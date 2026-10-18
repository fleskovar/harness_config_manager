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
 *   rename     install under a different name -- the bundle's name as a suffix
 *              unless the user types another. Offered for every kind addressed
 *              by name; the bundle's own instructions are rewritten to match
 *              (see rename.ts)
 *   abort      stop the whole run having written nothing
 *
 * Every choice is remembered for the run, so a bundle installed into three
 * harnesses asks once rather than three times. A rename is also recorded with
 * the installation, so `hcm update` installs the new version under the same
 * name.
 */

import { AbortedError, ConflictError } from './errors.js';
import { color, log } from './logger.js';
import { applicableParameters, applyParameters } from './parameters.js';
import { detectConflicts, resourceActions } from './planner.js';
import { isInteractive, select, text } from './prompt.js';
import { remapReferences } from './refmap.js';
import {
  bareMatchFor,
  canRename,
  disambiguatedName,
  isUsableName,
  rewriteReferences,
} from './rename.js';
import { getTarget } from '../targets/index.js';
import {
  type BundleResource,
  type InstallPlan,
  type PlanAction,
  type PlanConflict,
  resourceKey,
} from './types.js';

/** What to do with conflicts when nobody is there to ask. */
export type ConflictPolicy = 'prompt' | 'skip' | 'overwrite' | 'rename' | 'abort';

export const CONFLICT_POLICIES: readonly ConflictPolicy[] = [
  'prompt',
  'skip',
  'overwrite',
  'rename',
  'abort',
];

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
  /** The bundle being installed, which the resource comes from. */
  bundle: string;
  /** What it collides with, in words -- see `describeHolders`. */
  holders: string;
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
  /** What the resource collided with, in words. Absent for a carried rename. */
  against?: string;
}

/**
 * What a set of conflicts collides with, in words:
 *
 *   bundle "other-kit"
 *   bundles "a", "b" and content that no bundle installed
 *   an edited copy of its earlier install
 *
 * `bundleName` is the bundle being installed. It holds an item only when its
 * own earlier copy of that item was edited.
 */
export function describeHolders(
  conflicts: readonly { owners?: string[] }[],
  bundleName: string,
): string {
  const holders = [...new Set(conflicts.flatMap((conflict) => conflict.owners ?? []))];
  const others = holders.filter((name) => name !== bundleName);
  const parts: string[] = [];

  if (others.length > 0) {
    parts.push(
      `${others.length === 1 ? 'bundle' : 'bundles'} ${others.map((name) => `"${name}"`).join(', ')}`,
    );
  }
  if (holders.includes(bundleName)) parts.push('an edited copy of its earlier install');
  if (conflicts.some((conflict) => !conflict.owners?.length)) {
    parts.push('content that no bundle installed');
  }

  if (parts.length <= 1) return parts[0] ?? 'content that no bundle installed';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export interface ResolvedPlan {
  plan: InstallPlan;
  outcomes: ResolutionOutcome[];
  /**
   * Resources installed under another name: `resourceKey` of the bundle's
   * original -> the name it was installed as. Recorded with the installation.
   */
  renames: Record<string, string>;
}

/**
 * Put renames recorded by an earlier installation into `decisions`, so that
 * this run installs those resources under the same names again. An answer
 * already given in this run wins.
 */
export function seedRenames(
  decisions: Map<string, Resolution>,
  bundleName: string,
  renames: Record<string, string>,
): void {
  for (const [key, newName] of Object.entries(renames)) {
    const stored = `${bundleName}/${key}`;
    if (!decisions.has(stored)) decisions.set(stored, { choice: 'rename', newName });
  }
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

  // A rename regenerates one resource's writes from the bundle, so they arrive
  // holding raw `<%PLACEHOLDERS%>` again and have to be rendered like the rest.
  const parameterValues = plan.templating?.values ?? {};
  const parameters = applicableParameters(plan.bundle.parameters, {
    target: plan.target,
    flavors: plan.flavors,
  });

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

    const label = `${current.kind} "${current.name}"`;
    const { kept, insertAt } = extract(actions, key);
    const generated = resourceActions(
      target,
      { ...current, name: newName },
      bundleName,
      plan.scope,
      plan.targetOptions,
    );

    // The new name must not land on something else this bundle writes.
    const taken = new Set(kept.map(slotOf).filter((slot) => slot !== undefined));
    const clash = generated.find((action) => taken.has(slotOf(action) ?? ''));
    if (clash) {
      throw new AbortedError(
        `Cannot rename ${label} to "${newName}": this bundle also writes ${clash.describe}`,
      );
    }

    const rewrite = rewriteReferences(
      kept,
      current.name,
      newName,
      bareMatchFor(current.kind, current.name),
    );

    // The renamed resource was regenerated from the bundle, so its own text
    // still holds the bundle's original name. A markdown resource can mention
    // itself (`run /review-pr again`), so rewrite that too. An MCP server is
    // left alone: its definition names the executable, which keeps its name.
    const original = originalOf(plan, current)?.name ?? current.name;
    const fresh =
      current.kind === 'mcp'
        ? generated
        : rewriteReferences(generated, original, newName, bareMatchFor(current.kind, original))
            .actions;

    const combined = [
      ...rewrite.actions.slice(0, insertAt),
      ...fresh,
      ...rewrite.actions.slice(insertAt),
    ];
    // The regenerated writes have not been past the file-reference remapper or
    // the parameter renderer -- both run once, in buildPlan -- so give just
    // those the same treatment, in the same order. They sit where `fresh` was
    // spliced in, which remapping preserves.
    const remapped = remapReferences(plan.bundle, combined, fresh).actions;
    actions = applyParameters(
      remapped,
      parameterValues,
      parameters,
      remapped.slice(insertAt, insertAt + fresh.length),
    ).actions;
    answered.add(key);

    return {
      label,
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
    return {
      plan: { ...plan, actions, conflicts, skipped },
      outcomes,
      renames: renamesIn(plan, actions),
    };
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
        throw new AbortedError(`Aborted at ${group.label} from bundle "${bundleName}"`);
      }

      if (resolution.choice === 'overwrite') {
        accepted.add(group.key);
        outcomes.push({
          label: group.label,
          choice: 'overwrite',
          detail: group.conflicts.map((conflict) => conflict.path).join(', '),
          against: group.holders,
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
          against: group.holders,
        });
        continue;
      }

      // Rename. Regenerate this resource's writes under the new name, then
      // point the rest of the bundle's instructions at it.
      const outcome = resolution.newName ? rename(group.key, resolution.newName) : undefined;
      if (!outcome) {
        throw new AbortedError(`Cannot rename ${group.label} from bundle "${bundleName}"`);
      }
      outcomes.push({ ...outcome, against: group.holders });
    }

    conflicts = await detectConflicts(actions, plan.scopeRoot, bundleName, options.cwd);
  }

  const unresolved = conflicts.filter((conflict) => !accepted.has(groupKey(conflict)));
  if (unresolved.length > 0) {
    throw new ConflictError(
      `Could not resolve ${unresolved.length} conflict(s) installing "${bundleName}", ` +
        `which clashes with ${describeHolders(unresolved, bundleName)}`,
      unresolved,
    );
  }

  return {
    plan: { ...plan, actions, conflicts, skipped },
    outcomes,
    renames: renamesIn(plan, actions),
  };
}

/** The resource as the bundle has it, before any rename in this run. */
function originalOf(plan: InstallPlan, resource: BundleResource): BundleResource | undefined {
  return plan.bundle.resources.find(
    (candidate) => candidate.kind === resource.kind && candidate.bundlePath === resource.bundlePath,
  );
}

/** Every resource in `actions` that carries a name other than the bundle's. */
function renamesIn(plan: InstallPlan, actions: PlanAction[]): Record<string, string> {
  const renames: Record<string, string> = {};
  for (const action of actions) {
    if (!action.resource) continue;
    const original = originalOf(plan, action.resource);
    if (original && original.name !== action.resource.name) {
      renames[resourceKey(original)] = action.resource.name;
    }
  }
  return renames;
}

/**
 * The one item an action owns, when it owns one outright: a whole file, a JSON
 * key, a marker block. Array items are shared by design, so they have none.
 */
function slotOf(action: PlanAction): string | undefined {
  const { payload } = action;
  if (payload.kind === 'file') return action.path;
  if (payload.kind === 'json-value') return `${action.path}::${payload.pointer.join('.')}`;
  if (payload.kind === 'block') return `${action.path}::${payload.blockId}`;
  return undefined;
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
    const renamable = resource !== undefined && canRename(resource.kind);
    groups.set(key, {
      key,
      label: describeResource(resource, conflict.path),
      bundle: bundleName,
      holders: '',
      resource,
      conflicts: [conflict],
      canRename: renamable,
      ...(renamable
        ? { suggestedName: disambiguatedName(resource.kind, resource.name, bundleName) }
        : {}),
    });
  }

  // Worded once every conflict of the resource is in: one skill can collide
  // with two bundles at once.
  return [...groups.values()].map((group) => ({
    ...group,
    holders: describeHolders(group.conflicts, bundleName),
  }));
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
      `${conflicts.length} conflict(s) installing "${bundleName}", ` +
        `which clashes with ${describeHolders(conflicts, bundleName)}`,
      conflicts,
    );
  }

  if (options.policy === 'rename') return renameResolver;

  const choice: ConflictChoice = options.policy;
  return async () => ({ choice });
}

/**
 * `--on-conflict rename`: every resource that collides installs under the
 * suggested name. A collision with no name to change -- a settings key, say --
 * stops the run, because neither keeping nor replacing it was asked for.
 */
const renameResolver: ConflictResolver = async (group) => {
  if (!group.canRename || !group.suggestedName) {
    throw new ConflictError(
      `${group.label} from bundle "${group.bundle}" has no name to change`,
      group.conflicts,
    );
  }
  return { choice: 'rename', newName: group.suggestedName };
};

/** Ask, once per resource. */
export const promptResolver: ConflictResolver = async (group) => {
  log.plain('');
  log.warn(`${group.label} from bundle "${group.bundle}" conflicts with ${group.holders}:`);
  for (const conflict of group.conflicts) {
    log.plain(`    ${color.dim(conflict.path)}  ${conflict.detail}`);
  }

  const from = `"${group.bundle}"`;
  const skip = {
    value: 'skip' as const,
    label: 'skip',
    detail: `keep what is there now (${group.holders}), install nothing`,
  };
  const abort = { value: 'abort' as const, label: 'abort', detail: 'stop; write nothing at all' };

  const choice = await select<ConflictChoice>(
    `  How should hcm handle ${group.label} from bundle ${from}?`,
    group.canRename
      ? [
          skip,
          { value: 'overwrite', label: 'replace', detail: `overwrite it with the version from ${from}` },
          {
            value: 'rename',
            label: 'rename',
            detail: group.suggestedName
              ? `install as "${group.suggestedName}" or another name; update the instructions in ${from}`
              : `install under another name; update the instructions in ${from}`,
          },
          abort,
        ]
      : [
          skip,
          { value: 'overwrite', label: 'overwrite', detail: `replace it with the version from ${from}` },
          abort,
        ],
    'skip',
  );

  if (choice !== 'rename') return { choice };

  const kind = group.resource?.kind ?? 'mcp';
  const oldName = group.resource?.name ?? '';
  const newName = await text(
    `  new name for ${group.label}${group.suggestedName ? color.dim(` [${group.suggestedName}]`) : ''}`,
    (value) => {
      const candidate = value === '' ? group.suggestedName ?? '' : value;
      if (!candidate) return 'enter a name';
      if (candidate === oldName) return 'that is the name that already clashed';
      if (!isUsableName(kind, candidate)) {
        return kind === 'asset'
          ? 'use letters, digits, dots, dashes and underscores, with / between directories'
          : 'use letters, digits, dots, dashes and underscores';
      }
      return undefined;
    },
  );

  return { choice, newName: newName === '' ? group.suggestedName : newName };
};
