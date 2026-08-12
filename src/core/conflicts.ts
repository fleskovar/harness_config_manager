/**
 * Deciding what to do about a conflict.
 *
 * `buildPlan` reports collisions; this turns each one into a decision and
 * rewrites the plan accordingly, before anything is written. Decisions are made
 * per *resource*, not per file, because one skill is a dozen writes and the user
 * means one thing by all of them.
 *
 * Four outcomes:
 *   skip       leave what is on disk; drop our writes for that resource
 *   overwrite  write ours over theirs (this is what --force does to everything)
 *   rename     install under a different name -- MCP servers only, because they
 *              are addressed by name and the bundle's own instructions can be
 *              rewritten to match (see rename.ts)
 *   abort      stop the whole run having written nothing
 *
 * Every choice is remembered for the run, so a bundle installed into three
 * harnesses asks once rather than three times.
 */

import { AbortedError, ConflictError } from './errors.js';
import { color, log } from './logger.js';
import { detectConflicts, resourceActions } from './planner.js';
import { isInteractive, select, text } from './prompt.js';
import { remapReferences } from './refmap.js';
import { NAME_PATTERN, rewriteReferences } from './rename.js';
import { getTarget } from '../targets/index.js';
import {
  type BundleResource,
  type InstallPlan,
  type PlanAction,
  type PlanConflict,
  resourceKey,
} from './types.js';

/** What to do with conflicts when nobody is there to ask. */
export type ConflictPolicy = 'prompt' | 'skip' | 'overwrite' | 'abort';

export type ConflictChoice = 'skip' | 'overwrite' | 'rename' | 'abort';

export interface Resolution {
  choice: ConflictChoice;
  /** Required for `rename`. */
  newName?: string;
}

/** One resource's worth of collisions, as put to the user. */
export interface ConflictGroup {
  /** Stable identity of the resource, used to remember the answer. */
  key: string;
  /** Human label, e.g. `mcp "light-plan"`. */
  label: string;
  resource?: BundleResource;
  conflicts: PlanConflict[];
  /** Renaming only makes sense where the name is the address. */
  canRename: boolean;
  /** Suggested new name, when renaming is on offer. */
  suggestedName?: string;
}

export type ConflictResolver = (group: ConflictGroup) => Promise<Resolution>;

export interface ResolveOptions {
  policy: ConflictPolicy;
  /** Overridden by tests; defaults to the interactive prompt. */
  resolver?: ConflictResolver;
  /** Answers carried across targets within one run. */
  decisions?: Map<string, Resolution>;
  cwd: string;
}

export interface ResolutionOutcome {
  label: string;
  choice: ConflictChoice;
  detail: string;
}

export interface ResolvedPlan {
  plan: InstallPlan;
  outcomes: ResolutionOutcome[];
}

/** Guards against a rename that keeps landing on another taken name. */
const MAX_ROUNDS = 10;

/**
 * Resolve every conflict in `plan` and return the plan that should actually be
 * applied. Throws `AbortedError` if the user aborts, or `ConflictError` when
 * the policy is `abort` (the default when there is no terminal to ask at).
 */
export async function resolvePlanConflicts(
  plan: InstallPlan,
  options: ResolveOptions,
): Promise<ResolvedPlan> {
  const target = getTarget(plan.target);
  const bundleName = plan.bundle.manifest.name;
  const decisions = options.decisions ?? new Map<string, Resolution>();

  let actions = plan.actions;
  let conflicts = plan.conflicts;
  const outcomes: ResolutionOutcome[] = [];
  const skipped = [...plan.skipped];
  /** Resources the user chose to overwrite: their collisions stop being news. */
  const accepted = new Set<string>();
  /** Resources already answered in *this* plan; a repeat means the answer failed. */
  const answered = new Set<string>();

  const rename = (key: string, newName: string): ResolutionOutcome | undefined => {
    const current = actions.find(
      (action) => action.resource && resourceKey(action.resource) === key,
    )?.resource;
    if (!current) return undefined;

    const fresh = resourceActions(
      target,
      { ...current, name: newName },
      bundleName,
      plan.scope,
      plan.targetOptions,
    );
    const { kept, insertAt } = extract(actions, key);
    // Only the *other* resources get their references rewritten: the renamed
    // one was regenerated, and rewriting it would also rename its command.
    const rewrite = rewriteReferences(kept, current.name, newName);

    const combined = [
      ...rewrite.actions.slice(0, insertAt),
      ...fresh,
      ...rewrite.actions.slice(insertAt),
    ];
    // The regenerated writes have not been past the file-reference remapper --
    // that runs once, in buildPlan -- so give just those the same treatment.
    actions = remapReferences(plan.bundle, combined, fresh).actions;
    answered.add(key);

    return {
      label: `${current.kind} "${current.name}"`,
      choice: 'rename',
      detail:
        `installed as "${newName}"` +
        (rewrite.total > 0
          ? `; rewrote ${rewrite.total} reference(s) in ${rewrite.touched.length} file(s)`
          : '; no references found in the bundle'),
    };
  };

  // Answers are remembered per bundle, so two bundles that happen to ship a
  // resource of the same name still get asked separately.
  const remembered = (key: string): Resolution | undefined => decisions.get(`${bundleName}/${key}`);
  const remember = (key: string, resolution: Resolution): void => {
    decisions.set(`${bundleName}/${key}`, resolution);
  };

  // A rename decided for an earlier target applies here too, collision or not:
  // the same server under two names across harnesses would be a trap.
  let carried = false;
  for (const [stored, decision] of decisions) {
    if (decision.choice !== 'rename' || !decision.newName) continue;
    if (!stored.startsWith(`${bundleName}/`)) continue;
    const outcome = rename(stored.slice(bundleName.length + 1), decision.newName);
    if (!outcome) continue;
    outcomes.push({ ...outcome, detail: `${outcome.detail} (as decided earlier)` });
    carried = true;
  }

  if (carried) {
    conflicts = await detectConflicts(actions, plan.scopeRoot, bundleName, options.cwd);
  }

  if (conflicts.length === 0) {
    return { plan: { ...plan, actions, conflicts, skipped }, outcomes };
  }

  const resolver = pickResolver(options, () => conflicts, bundleName);

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const pending = conflicts.filter((conflict) => !accepted.has(groupKey(conflict)));
    if (pending.length === 0) break;

    for (const group of groupConflicts(pending, bundleName)) {
      const earlier = answered.has(group.key) ? undefined : remembered(group.key);
      if (earlier) log.debug(`reusing your earlier answer for ${group.label}: ${earlier.choice}`);

      const resolution = earlier ?? (await resolver(group));
      remember(group.key, resolution);
      answered.add(group.key);

      if (resolution.choice === 'abort') {
        throw new AbortedError(`Aborted at ${group.label}`);
      }

      if (resolution.choice === 'overwrite') {
        accepted.add(group.key);
        outcomes.push({
          label: group.label,
          choice: 'overwrite',
          detail: group.conflicts.map((conflict) => conflict.path).join(', '),
        });
        continue;
      }

      if (resolution.choice === 'skip') {
        const before = actions.length;
        actions = dropSkipped(actions, group);
        skipped.push(
          ...(group.resource
            ? [{ resource: group.resource, reason: 'skipped: kept what was already there' }]
            : []),
        );
        outcomes.push({
          label: group.label,
          choice: 'skip',
          detail: `${before - actions.length} write(s) dropped`,
        });
        continue;
      }

      // Rename. Regenerate this resource's writes under the new name, then
      // point the rest of the bundle's instructions at it.
      const outcome = resolution.newName ? rename(group.key, resolution.newName) : undefined;
      if (!outcome) throw new AbortedError(`Cannot rename ${group.label}`);
      outcomes.push(outcome);
    }

    conflicts = await detectConflicts(actions, plan.scopeRoot, bundleName, options.cwd);
  }

  const unresolved = conflicts.filter((conflict) => !accepted.has(groupKey(conflict)));
  if (unresolved.length > 0) {
    throw new ConflictError(
      `Could not resolve ${unresolved.length} conflict(s) installing "${bundleName}"`,
      unresolved,
    );
  }

  return {
    plan: { ...plan, actions, conflicts, skipped },
    outcomes,
  };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function groupKey(conflict: PlanConflict): string {
  return conflict.resource ? resourceKey(conflict.resource) : `path:${conflict.path}`;
}

function describeResource(resource: BundleResource | undefined, path: string): string {
  return resource ? `${resource.kind} "${resource.name}"` : path;
}

function groupConflicts(conflicts: PlanConflict[], bundleName: string): ConflictGroup[] {
  const groups = new Map<string, ConflictGroup>();

  for (const conflict of conflicts) {
    const key = groupKey(conflict);
    const existing = groups.get(key);
    if (existing) {
      existing.conflicts.push(conflict);
      continue;
    }

    const resource = conflict.resource;
    const canRename = resource?.kind === 'mcp';
    groups.set(key, {
      key,
      label: describeResource(resource, conflict.path),
      resource,
      conflicts: [conflict],
      canRename,
      ...(canRename && resource ? { suggestedName: `${bundleName}-${resource.name}` } : {}),
    });
  }

  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Applying a skip
// ---------------------------------------------------------------------------

/**
 * Drop the writes a skip cancels.
 *
 * For most kinds that is the whole resource -- half a skill on disk is worse
 * than none. A settings fragment is different: its keys are independent, so
 * only the colliding ones are dropped and the rest still land.
 */
function dropSkipped(actions: PlanAction[], group: ConflictGroup): PlanAction[] {
  if (group.resource?.kind === 'settings') {
    const collided = new Set(
      group.conflicts.map((conflict) => `${conflict.path}::${(conflict.pointer ?? []).join('.')}`),
    );
    return actions.filter((action) => {
      if (!action.resource || resourceKey(action.resource) !== group.key) return true;
      const pointer =
        action.payload.kind === 'json-value' || action.payload.kind === 'json-array-item'
          ? action.payload.pointer
          : [];
      return !collided.has(`${action.path}::${pointer.join('.')}`);
    });
  }

  if (!group.resource) {
    const paths = new Set(group.conflicts.map((conflict) => conflict.path));
    return actions.filter((action) => !paths.has(action.path));
  }

  return actions.filter(
    (action) => !action.resource || resourceKey(action.resource) !== group.key,
  );
}

/** Remove one resource's actions, remembering where they were. */
function extract(actions: PlanAction[], key: string): { kept: PlanAction[]; insertAt: number } {
  const kept: PlanAction[] = [];
  let insertAt = actions.length;

  for (const action of actions) {
    if (action.resource && resourceKey(action.resource) === key) {
      if (insertAt === actions.length) insertAt = kept.length;
      continue;
    }
    kept.push(action);
  }

  return { kept, insertAt };
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

/**
 * The resolver implied by `--on-conflict`.
 *
 * `abort` -- and `prompt` with no terminal to prompt at -- never returns one:
 * it raises straight away, listing the conflicts as they stand now, which is
 * what `hcm` has always done for scripts and CI.
 */
function pickResolver(
  options: ResolveOptions,
  current: () => PlanConflict[],
  bundleName: string,
): ConflictResolver {
  if (options.resolver) return options.resolver;
  if (options.policy === 'prompt' && isInteractive()) return promptResolver;

  if (options.policy === 'prompt' || options.policy === 'abort') {
    const conflicts = current();
    throw new ConflictError(
      `${conflicts.length} conflict(s) installing "${bundleName}"`,
      conflicts,
    );
  }

  const choice: ConflictChoice = options.policy;
  return async () => ({ choice });
}

/** Ask, once per resource. */
export const promptResolver: ConflictResolver = async (group) => {
  log.plain('');
  log.warn(`${group.label} conflicts with what is already installed:`);
  for (const conflict of group.conflicts) {
    log.plain(`    ${color.dim(conflict.path)}  ${conflict.detail}`);
  }

  const choice = await select<ConflictChoice>(
    `  How should hcm handle ${group.label}?`,
    group.canRename
      ? [
          { value: 'skip', label: 'skip', detail: 'keep the existing one, install nothing' },
          { value: 'overwrite', label: 'replace', detail: 'overwrite it with the bundle version' },
          {
            value: 'rename',
            label: 'rename',
            detail: 'install under another name and update this bundle’s instructions',
          },
          { value: 'abort', label: 'abort', detail: 'stop; write nothing at all' },
        ]
      : [
          { value: 'skip', label: 'skip', detail: 'keep the existing one, install nothing' },
          { value: 'overwrite', label: 'overwrite', detail: 'replace it with the bundle version' },
          { value: 'abort', label: 'abort', detail: 'stop; write nothing at all' },
        ],
    'skip',
  );

  if (choice !== 'rename') return { choice };

  const oldName = group.resource?.name ?? '';
  const newName = await text(
    `  new name for ${group.label}${group.suggestedName ? color.dim(` [${group.suggestedName}]`) : ''}`,
    (value) => {
      const candidate = value === '' ? group.suggestedName ?? '' : value;
      if (!candidate) return 'enter a name';
      if (candidate === oldName) return 'that is the name that already clashed';
      if (!NAME_PATTERN.test(candidate)) {
        return 'use letters, digits, dots, dashes and underscores';
      }
      return undefined;
    },
  );

  return { choice, newName: newName === '' ? group.suggestedName : newName };
};
