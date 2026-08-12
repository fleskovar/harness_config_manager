import {
  type ConflictPolicy,
  type ConflictResolver,
  type Resolution,
  resolvePlanConflicts,
} from '../core/conflicts.js';
import { captureContext } from '../core/context.js';
import {
  type DependencyGraph,
  formatDependencyTree,
  installedDependencies,
  resolveDependencyGraph,
} from '../core/deps.js';
import { ConflictError, HcmError } from '../core/errors.js';
import { applyPlan } from '../core/executor.js';
import { describeSource } from '../core/github.js';
import { color, log } from '../core/logger.js';
import { buildPlan } from '../core/planner.js';
import { resolveBundles } from '../core/registry.js';
import { findInstallation, upsertInstallation } from '../core/state.js';
import {
  installationId,
  type InstalledDependency,
  type LoadedBundle,
  type Scope,
  type TargetId,
  type TargetOptions,
} from '../core/types.js';
import { getTarget, TARGET_IDS } from '../targets/index.js';

export interface InstallOptions {
  targets?: string[];
  scope: Scope;
  dryRun?: boolean;
  /** Shorthand for `onConflict: 'overwrite'`. */
  force?: boolean;
  /** What to do about collisions; defaults to asking when there is a terminal. */
  onConflict?: ConflictPolicy;
  /** Test seam: answers the conflict questions instead of the terminal. */
  resolver?: ConflictResolver;
  /**
   * Answers remembered across targets and bundles in one run, so installing
   * into three harnesses asks each question once. Created here when absent.
   */
  decisions?: Map<string, Resolution>;
  refresh?: boolean;
  /**
   * What is installed on the machine being written to, which changes where some
   * resources land. Recorded with the installation so `hcm update` does not
   * have to be told again.
   */
  targetOptions?: TargetOptions;
  /** Install only what was named, leaving its `dependencies` to fail later. */
  noDeps?: boolean;
  cwd: string;
}

/** What one bundle in a run records about why it is being installed. */
export interface BundleRole {
  /** Pulled in to satisfy another bundle rather than asked for by name. */
  auto?: boolean;
  /** The bundles it required, resolved. */
  dependencies?: InstalledDependency[];
  /** Who wanted it, for the log. */
  requiredBy?: string[];
  /**
   * The harnesses to install into, overriding what the options say. A
   * dependency goes wherever the bundles that need it went -- installing it
   * into five harnesses because it happens to support five would leave four
   * copies nobody asked for.
   */
  targets?: TargetId[];
}

export async function installCommand(reference: string, options: InstallOptions): Promise<void> {
  const roots = await resolveBundles(reference, options.cwd, {
    refresh: options.refresh ?? false,
  });

  // One shared memory of answers for the whole command.
  const decisions = options.decisions ?? new Map<string, Resolution>();
  options = { ...options, decisions };

  if (roots.length > 1) {
    log.info(
      `${color.bold(String(roots.length))} bundles found: ` +
        roots.map((bundle) => bundle.manifest.name).join(', '),
    );
  }

  const graph = options.noDeps
    ? withoutDependencies(roots)
    : await resolveDependencyGraph(roots, options.cwd, { refresh: options.refresh ?? false });

  if (options.noDeps) warnAboutSkippedDependencies(roots);
  else logDependencyTree(graph, roots);

  const targets = targetsPerBundle(graph, options);

  // `graph.order` puts dependencies first, so by the time a dependent is
  // planned its dependency's items are on disk and claimed -- which is what
  // turns a shared asset into one copy with two claims rather than a conflict.
  for (const entry of graph.order) {
    await installBundle(entry.bundle, options, {
      auto: !entry.explicit,
      dependencies: installedDependencies(entry.bundle, graph),
      requiredBy: entry.requiredBy,
      ...(targets.get(entry.bundle.manifest.name)
        ? { targets: targets.get(entry.bundle.manifest.name) as TargetId[] }
        : {}),
    });
  }
}

/**
 * Which harnesses each bundle in the run should go into.
 *
 * The bundles the user named take the targets they asked for (or that the
 * manifest declares). A dependency takes the union of what the bundles needing
 * it are getting: it exists to serve them, so installing it anywhere else would
 * be four copies nobody asked for.
 *
 * Walked in reverse install order -- dependents first -- so every dependency's
 * targets are known by the time it is reached.
 */
function targetsPerBundle(
  graph: DependencyGraph,
  options: InstallOptions,
): Map<string, TargetId[]> {
  const chosen = new Map<string, Set<TargetId>>();

  const effective = (bundle: LoadedBundle, inherited?: Set<TargetId>): TargetId[] => {
    const wanted =
      inherited ??
      new Set((options.targets?.length ? options.targets : undefined) ?? TARGET_IDS);
    const declared = bundle.manifest.targets;
    const all = [...wanted].map((id) => getTarget(id).id);
    return declared ? all.filter((id) => declared.includes(id)) : all;
  };

  for (const entry of [...graph.order].reverse()) {
    const name = entry.bundle.manifest.name;
    // An explicitly named bundle answers to the command line even if something
    // else also requires it; a dependency inherits from its dependents.
    const inherited = entry.explicit ? undefined : chosen.get(name);
    const targets = effective(entry.bundle, inherited);
    chosen.set(name, new Set(targets));

    for (const dependency of entry.bundle.dependencies) {
      const needs = chosen.get(dependency.name) ?? new Set<TargetId>();
      for (const target of targets) needs.add(target);
      chosen.set(dependency.name, needs);
    }
  }

  return new Map([...chosen].map(([name, targets]) => [name, [...targets]]));
}

/** The graph `--no-deps` implies: the roots, and nothing they asked for. */
function withoutDependencies(roots: LoadedBundle[]): DependencyGraph {
  const order = roots.map((bundle) => ({
    bundle,
    requiredBy: [],
    explicit: true,
    via: 'requested' as const,
  }));
  return {
    order,
    byName: new Map(order.map((entry) => [entry.bundle.manifest.name, entry])),
    hasDependencies: false,
  };
}

function warnAboutSkippedDependencies(roots: LoadedBundle[]): void {
  const skipped = roots.flatMap((bundle) =>
    bundle.dependencies.map((dependency) => `${bundle.manifest.name} -> ${dependency.name}`),
  );
  if (skipped.length === 0) return;
  log.warn(`  --no-deps: not installing ${skipped.length} required bundle(s): ${skipped.join(', ')}`);
  log.warn('  the bundle may not work until they are installed');
}

function logDependencyTree(graph: DependencyGraph, roots: LoadedBundle[]): void {
  if (!graph.hasDependencies) return;
  const pulled = graph.order.filter((entry) => !entry.explicit).length;
  log.info(`Resolved ${pulled} required bundle(s):`);
  for (const line of formatDependencyTree(graph, roots.map((bundle) => bundle.manifest.name))) {
    log.plain(color.dim(`  ${line}`));
  }
}

/**
 * Install one already-loaded bundle into every requested target.
 *
 * Exported for `hcm update`, which installs a dependency it has already
 * resolved -- going back through a name would only work for bundles that
 * happen to be registered.
 */
export async function installBundle(
  bundle: LoadedBundle,
  options: InstallOptions,
  role: BundleRole = {},
): Promise<void> {
  const declared = bundle.manifest.targets;
  const requested =
    role.targets ??
    (options.targets?.length ? options.targets : undefined) ??
    declared ??
    TARGET_IDS;
  let targets = requested.map((id) => getTarget(id).id);

  const undeclared = declared ? targets.filter((id) => !declared.includes(id)) : [];
  if (undeclared.length > 0) {
    // Naming a target the bundle does not support is a mistake worth refusing.
    // A *dependency* is different: nobody asked for it here, so it installs
    // into whichever of the requested harnesses it does support.
    if (!role.auto) {
      throw new HcmError(
        `"${bundle.manifest.name}" does not support: ${undeclared.join(', ')}`,
        `The bundle declares targets: ${declared?.join(', ')}`,
      );
    }
    targets = targets.filter((id) => declared?.includes(id));
  }

  const required = role.requiredBy?.length
    ? color.dim(` (required by ${role.requiredBy.join(', ')})`)
    : '';

  log.info('');
  log.info(
    `${color.bold(bundle.manifest.name)} ${color.dim(`v${bundle.manifest.version}`)} ` +
      `${color.dim(`(${describeSource(bundle.source)})`)}${required}`,
  );

  if (targets.length === 0) {
    log.warn(
      `  nothing to do: it supports ${declared?.join(', ')}, none of which is being installed into`,
    );
    return;
  }

  for (const targetId of targets) {
    logTargetHeader(targetId, options);
    await installInto(bundle, targetId, options, role);
  }
}

/** The "Claude Code · project · /path" banner each target's output sits under. */
export function logTargetHeader(targetId: TargetId, options: { scope: Scope; cwd: string }): void {
  const target = getTarget(targetId);
  log.info('');
  log.info(
    `${color.bold(target.title)} ${color.dim(`· ${options.scope} · ${target.scopeRoot(options.scope, options.cwd)}`)}`,
  );
}

/**
 * Install one bundle into one target. Exported because `hcm update` reinstalls
 * a bundle target by target, following what the ledger says is already there.
 */
export async function installInto(
  bundle: LoadedBundle,
  targetId: TargetId,
  options: InstallOptions,
  role: BundleRole = {},
): Promise<void> {
  const target = getTarget(targetId);
  const targetOptions = options.targetOptions ?? {};
  await warnIfMappingChanged(bundle.manifest.name, targetId, targetOptions, options);
  const built = await buildPlan(bundle, targetId, options.scope, options.cwd, targetOptions);

  if (built.actions.length === 0) {
    log.warn(`  nothing to install (${built.skipped.length} resource(s) not supported here)`);
    return;
  }

  for (const skip of built.skipped) {
    log.debug(`skip ${skip.resource.bundlePath}: ${skip.reason}`);
  }

  const { plan, outcomes } = await resolveConflicts(built, target.title, options);

  for (const outcome of outcomes) {
    log.info(`  ${color.cyan(outcome.choice)} ${outcome.label} ${color.dim(`(${outcome.detail})`)}`);
  }

  // What is left is what the user said to overwrite.
  for (const conflict of plan.conflicts) {
    log.warn(`  overwriting: ${conflict.path}: ${conflict.detail}`);
  }

  if (plan.actions.length === 0) {
    log.warn('  nothing left to install after resolving conflicts');
    return;
  }

  for (const action of plan.actions) {
    const mark = action.adopt || action.share ? color.dim('=') : color.green('+');
    const note = action.adopt
      ? color.dim('  (already present -- adopted, not ours to remove)')
      : action.share
        ? color.dim('  (already installed by another bundle -- shared, not copied again)')
        : '';
    log.info(`  ${mark} ${action.describe}${note}`);
  }

  if (options.dryRun) {
    log.info(color.dim('  (dry run -- nothing written)'));
    return;
  }

  const receipts = await applyPlan(plan);

  // An explicit install of something previously pulled in as a dependency makes
  // it the user's: it should survive the bundle that first needed it.
  const previous = await findInstallation(options.scope, options.cwd, bundle.manifest.name, targetId);
  const auto = (role.auto ?? false) && (previous?.auto ?? true);

  await upsertInstallation(options.scope, options.cwd, {
    id: installationId(bundle.manifest.name, targetId, options.scope),
    bundle: bundle.manifest.name,
    version: bundle.manifest.version,
    target: targetId,
    scope: options.scope,
    source: bundle.source,
    installedAt: new Date().toISOString(),
    receipts,
    ...(Object.keys(targetOptions).length > 0 ? { targetOptions } : {}),
    ...(role.dependencies?.length ? { dependencies: role.dependencies } : {}),
    ...(auto ? { auto: true } : {}),
  });

  // Keep a copy of the context sections. The harness's own agent rewrites
  // CLAUDE.md and AGENTS.md; a receipt records where a section was, not what it
  // said, so without this there would be nothing to put back. See core/context.ts.
  const cached = await captureContext(bundle, targetId, options.scope, options.cwd, plan.actions);

  const adopted = receipts.filter(
    (receipt) => (receipt.op === 'file' || receipt.op === 'json-value') && receipt.preexisting,
  ).length;
  const shared = plan.actions.filter((action) => action.share).length;

  log.success(
    `  installed ${receipts.length} item(s)` +
      (adopted > 0 ? color.dim(` (${adopted} already present, left as they are)`) : '') +
      (shared > 0 ? color.dim(` (${shared} shared with another bundle)`) : ''),
  );
  if (cached > 0) {
    log.debug(`cached ${cached} context section(s) for "hcm context append"`);
  }
}

/** The CLI flag each target option answers to, for messages about them. */
const TARGET_OPTION_FLAGS: Record<keyof TargetOptions, string> = {
  piSubagents: '--pi-subagents',
};

export function describeTargetOptions(options: TargetOptions): string {
  const keys = Object.keys(TARGET_OPTION_FLAGS) as (keyof TargetOptions)[];
  const on = keys.filter((key) => options[key]).map((key) => TARGET_OPTION_FLAGS[key]);
  return on.length > 0 ? on.join(' ') : 'the defaults';
}

/**
 * Installing with different options to last time moves things: a subagent that
 * was a skill becomes an agent file. This install's receipts replace the ones
 * that knew about the old locations, so nothing would ever clean them up --
 * say so, and name the commands that do it properly.
 */
async function warnIfMappingChanged(
  bundleName: string,
  targetId: TargetId,
  targetOptions: TargetOptions,
  options: InstallOptions,
): Promise<void> {
  const record = await findInstallation(options.scope, options.cwd, bundleName, targetId);
  if (!record) return;

  const before = describeTargetOptions(record.targetOptions ?? {});
  const after = describeTargetOptions(targetOptions);
  if (before === after) return;

  log.warn(`  installed here with ${before}, now installing with ${after}`);
  log.warn(
    '  anything that moves will be left behind at its old path -- ' +
      `"hcm update ${bundleName}" swaps them over, or uninstall first`,
  );
}

/**
 * Ask (or apply the policy) about every collision, and report the conflicts we
 * could not get past the way `hcm` always has.
 */
async function resolveConflicts(
  plan: Awaited<ReturnType<typeof buildPlan>>,
  targetTitle: string,
  options: InstallOptions,
): ReturnType<typeof resolvePlanConflicts> {
  try {
    return await resolvePlanConflicts(plan, {
      policy: options.onConflict ?? (options.force ? 'overwrite' : 'prompt'),
      ...(options.resolver ? { resolver: options.resolver } : {}),
      ...(options.decisions ? { decisions: options.decisions } : {}),
      cwd: options.cwd,
    });
  } catch (error) {
    if (error instanceof ConflictError) {
      for (const conflict of error.conflicts) {
        log.error(`  ${conflict.path}: ${conflict.detail}`);
      }
      throw new ConflictError(
        `${error.conflicts.length} conflict(s) installing "${plan.bundle.manifest.name}" into ${targetTitle}`,
        error.conflicts,
      );
    }
    throw error;
  }
}
