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
import {
  ALL_FLAVORS,
  assertFlavorsAvailable,
  describeFlavorSelection,
  expandFlavors,
  hasFlavor,
  sameFlavors,
} from '../core/flavors.js';
import { describeSource } from '../core/github.js';
import {
  chooseTargets,
  detectHarnesses,
  expandTargets,
  type HarnessPresence,
  requireTargetChoice,
  type TargetChooser,
  warnIfWiderThanTheFolder,
} from '../core/harnesses.js';
import { color, log } from '../core/logger.js';
import { describeReaders, sharedFileNotices } from '../core/overlap.js';
import {
  applicableParameters,
  emptyOverrides,
  mergeOverrides,
  overridesFor,
  type ParameterOverrides,
  parseAssignments,
  readParametersFile,
  resolveParameters,
  storableValues,
  withDefaults,
} from '../core/parameters.js';
import { buildPlan } from '../core/planner.js';
import { asList, resolveBundles } from '../core/registry.js';
import { findInstallation, upsertInstallation } from '../core/state.js';
import {
  installationId,
  type InstalledDependency,
  type LoadedBundle,
  type ParameterValues,
  type PlanReferences,
  type PlanTemplating,
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
  /**
   * Install only the bundle's common part plus these flavors, rather than all
   * of it. Empty or absent is the whole bundle. See `core/flavors.ts`.
   */
  flavors?: string[];
  /**
   * `--param` assignments, as typed: `NAME=value`, `bundle:NAME=value` or
   * `bundle@harness:NAME=value`. See `core/parameters.ts`.
   */
  params?: string[];
  /** `--params-file`: files of parameter values, later ones winning. */
  paramsFiles?: string[];
  /** Already-parsed overrides, for callers that are not a command line. */
  parameterOverrides?: ParameterOverrides;
  /**
   * Values a previous installation was rendered with, reused unless something
   * overrides them. `hcm update` passes these: it rolls the old installation
   * back before reinstalling, so by then there is no record left to read.
   */
  recordedParameters?: ParameterValues;
  /**
   * Ask for missing parameter values when there is a terminal. False never
   * asks: defaults are used, and a required value with no default is an error.
   */
  prompt?: boolean;
  /** Ask again for values a previous install recorded. */
  reconfigure?: boolean;
  /**
   * Parameter answers remembered across bundles and targets in one run, so
   * installing into three harnesses asks each question once. Created here when
   * absent, like `decisions`.
   */
  answers?: Map<string, string>;
  /**
   * Test seam: answers the 'which harness?' question instead of the terminal.
   * See `chooseTargets` in core/harnesses.ts.
   */
  targetChooser?: TargetChooser;
  /** Install only what was named, leaving its `dependencies` to fail later. */
  noDeps?: boolean;
  /**
   * The harnesses this folder is used by, so writes into a file another one
   * also reads can be flagged. Worked out once at the start of the run and
   * passed down: detecting again after the first install would find the
   * harnesses this very command just created.
   */
  presentTargets?: TargetId[];
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

/**
 * Install one bundle, or several.
 *
 * Several is not a loop over one. The bundles named in a single command are
 * resolved into a single dependency graph, so a dependency two of them share is
 * installed once, a version clash between them is an error rather than a race,
 * and the conflict questions are asked once for the whole run.
 */
export async function installCommand(
  references: string | string[],
  options: InstallOptions,
): Promise<void> {
  const wanted = asList(references);
  const roots: LoadedBundle[] = [];

  // Every reference is resolved before anything is planned, so a name that
  // turns out not to exist stops the run before the earlier ones are written.
  for (const reference of wanted) {
    roots.push(
      ...(await resolveBundles(reference, options.cwd, { refresh: options.refresh ?? false })),
    );
  }

  // One shared memory of answers for the whole command -- conflict decisions,
  // and the parameter values typed at the prompt.
  const decisions = options.decisions ?? new Map<string, Resolution>();
  const answers = options.answers ?? new Map<string, string>();
  let chosen = expandTargets(options.targets);

  // Read before anything is planned, so a malformed assignment or a missing
  // file stops the run rather than the second bundle of five.
  const parameterOverrides = await collectOverrides(options);

  // Checked against the bundles the user named, before anything is planned: a
  // flavor none of them has would otherwise install their common part and
  // silently drop the half that was actually wanted.
  const flavors = expandFlavors(options.flavors) ?? [];
  assertFlavorsAvailable(roots, flavors);

  options = {
    ...options,
    decisions,
    answers,
    parameterOverrides,
    flavors,
    ...(chosen ? { targets: chosen } : {}),
  };

  if (roots.length > 1) {
    log.info(
      `${color.bold(String(roots.length))} bundles found: ` +
        roots.map((bundle) => bundle.manifest.name).join(', '),
    );
  }

  if (flavors.length > 0) {
    log.info(`Installing the ${color.bold(flavors.join(', '))} flavor(s) and everything common`);
  }

  const graph = options.noDeps
    ? withoutDependencies(roots)
    : await resolveDependencyGraph(roots, options.cwd, { refresh: options.refresh ?? false });

  if (options.noDeps) warnAboutSkippedDependencies(roots);
  else logDependencyTree(graph, roots);

  // No -t: rather than silently installing into every harness these bundles
  // support, offer them -- with what this folder is already set up for ticked.
  // Asked here, after the graph, so a bad reference or an unresolvable
  // dependency still fails before the user is made to answer anything.
  if (!chosen) {
    const picked = await chooseTargets({
      available: supportedTargets(roots),
      scope: options.scope,
      cwd: options.cwd,
      ...(options.targetChooser ? { chooser: options.targetChooser } : {}),
      ...(options.prompt === false ? { prompt: false } : {}),
    });
    if (picked) {
      chosen = picked;
      options = { ...options, targets: picked };
    }
  }

  const targets = targetsPerBundle(graph, options);
  const affected = [...new Set([...targets.values()].flat())];

  // In a folder used by several harnesses, "install this" is not a complete
  // instruction -- say which. Detection also feeds the shared-file warnings
  // below, so it happens once, here, before anything is written.
  const command = `hcm install ${wanted.join(' ')}`;
  const found = await requireTargetChoice({
    ...(chosen ? { chosen } : {}),
    affected,
    command,
    scope: options.scope,
    cwd: options.cwd,
  });
  warnIfWiderThanTheFolder(found, chosen, affected, command, (message) => log.warn(message));

  options = { ...options, presentTargets: presentAfterThisRun(found, affected) };

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
 * The harnesses worth offering when nobody said which: every one the bundles
 * named on the command line support.
 *
 * Only the named ones. A dependency goes wherever its dependents go -- it is
 * not something the user is choosing -- so a dependency that happens to support
 * one extra harness must not put that harness on the menu.
 */
function supportedTargets(roots: LoadedBundle[]): TargetId[] {
  const supported = new Set<TargetId>();
  for (const bundle of roots) {
    for (const id of bundle.manifest.targets ?? TARGET_IDS) supported.add(getTarget(id).id);
  }
  return TARGET_IDS.filter((id) => supported.has(id));
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

/**
 * The harnesses that will be using this folder once the run finishes: the ones
 * already here, plus the ones being installed into. A file shared with a
 * harness this very command is setting up is just as shared as one shared with
 * a harness that was here yesterday.
 */
function presentAfterThisRun(found: HarnessPresence[], affected: TargetId[]): TargetId[] {
  return [...new Set([...found.map((harness) => harness.target), ...affected])];
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

  // A dependency inherits the run's flavors, and a bundle that has never heard
  // of them is all common part -- so it arrives whole. Said out loud, because
  // "--flavor python" reads as if it narrowed everything in the run.
  const flavors = options.flavors ?? [];
  if (flavors.length > 0 && !flavors.some((name) => hasFlavor(bundle, name))) {
    log.info(color.dim(`  no ${flavors.join('/')} flavor here -- installing all of it`));
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
  const flavors = options.flavors ?? [];
  await warnIfMappingChanged(bundle.manifest.name, targetId, targetOptions, flavors, options);

  // Asked before the plan is built, because the plan is the rendered text: a
  // value arriving later would leave the hashes describing something else.
  const parameters = await askParameters(bundle, targetId, flavors, options);

  const built = await buildPlan(
    bundle,
    targetId,
    options.scope,
    options.cwd,
    targetOptions,
    flavors,
    parameters.values,
  );

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

  reportReferences(plan);
  reportTemplating(plan.templating);
  await reportSharedFiles(plan.actions.map((action) => action.path), targetId, options);

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

  // An installation is automatic only if it is being pulled in as a dependency
  // *and* was not already the user's. Both directions matter: installing by
  // name something that was pulled in before makes it the user's, and a bundle
  // installed by name first stays theirs when a later bundle turns out to
  // require it. A record with no `auto` flag is an explicit installation, so
  // the flag is compared rather than defaulted -- `previous.auto ?? true` would
  // read every explicit installation as automatic and let the next
  // "hcm uninstall <dependent>" take it away.
  const previous = await findInstallation(options.scope, options.cwd, bundle.manifest.name, targetId);
  const auto = (role.auto ?? false) && (previous ? previous.auto === true : true);

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
    ...(flavors.length > 0 ? { flavors } : {}),
    // Everything except the secrets, so `hcm update` can render the new version
    // the same way without being told again.
    ...(Object.keys(parameters.stored).length > 0 ? { parameters: parameters.stored } : {}),
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

/**
 * Everything `--param` and `--params-file` said, in one place.
 *
 * Files first, flags second, so a flag beats the file it sits beside -- the
 * usual reading of "the file is the setting, the flag is the exception". Two
 * files are merged in the order given, the later one winning.
 */
async function collectOverrides(options: InstallOptions): Promise<ParameterOverrides> {
  const fromFiles: ParameterOverrides[] = [];
  for (const file of options.paramsFiles ?? []) {
    fromFiles.push(await readParametersFile(file, options.cwd));
  }

  return mergeOverrides(
    options.parameterOverrides ?? emptyOverrides(),
    ...fromFiles,
    parseAssignments(options.params),
  );
}

/** What one installation's templates should be rendered with, and what to record. */
interface InstallParameters {
  values: ParameterValues;
  /** The subset safe to write into the ledger -- see `storableValues`. */
  stored: ParameterValues;
}

/**
 * Settle every parameter this installation needs.
 *
 * The values a previous install of the same bundle into the same harness
 * recorded are the starting point, so reinstalling asks nothing and changes
 * nothing. `hcm update` cannot rely on that -- it rolls the old installation
 * back first -- so it hands them over itself.
 */
async function askParameters(
  bundle: LoadedBundle,
  targetId: TargetId,
  flavors: string[],
  options: InstallOptions,
): Promise<InstallParameters> {
  if (bundle.parameters.length === 0) return { values: {}, stored: {} };
  const applicable = applicableParameters(bundle.parameters, { target: targetId, flavors });

  const recorded =
    options.recordedParameters ??
    (await findInstallation(options.scope, options.cwd, bundle.manifest.name, targetId))
      ?.parameters;

  const resolved = await resolveParameters({
    bundle: bundle.manifest.name,
    target: targetId,
    parameters: applicable,
    overrides: overridesFor(
      options.parameterOverrides ?? emptyOverrides(),
      bundle.manifest.name,
      targetId,
    ),
    ...(recorded ? { recorded } : {}),
    session: options.answers ?? new Map<string, string>(),
    ...(options.prompt === false ? { prompt: false } : {}),
    ...(options.reconfigure ? { reconfigure: true } : {}),
  });

  for (const parameter of applicable) {
    const value = resolved.values[parameter.name] ?? '';
    const shown = parameter.secret ? color.dim('(hidden)') : JSON.stringify(value);
    log.debug(`${parameter.name} = ${shown} (${resolved.sources[parameter.name]})`);
  }

  return {
    // What is rendered includes a default for anything narrowed away, so a
    // file common to every harness never carries a hole; what is *recorded* is
    // only what this install actually settled, since a default belongs to the
    // manifest and should move with it.
    values: withDefaults(resolved.values, bundle.parameters),
    stored: storableValues(resolved.values, applicable),
  };
}

/**
 * What the parameter renderer did.
 *
 * Substitutions are routine -- one line, only with `--verbose`. A placeholder
 * left standing is not: it goes into the installed file exactly as written, and
 * the agent reads `<%AGENT_NAME%>` out loud. That is worth a warning every time.
 */
function reportTemplating(templating: PlanTemplating | undefined): void {
  if (!templating) return;

  for (const filled of templating.substituted) {
    log.debug(`${filled.path}: <%${filled.name}%> ×${filled.count}`);
  }
  if (templating.substituted.length > 0) {
    const files = new Set(templating.substituted.map((filled) => filled.path)).size;
    const names = new Set(templating.substituted.map((filled) => filled.name)).size;
    log.debug(`filled in ${names} parameter(s) across ${files} file(s)`);
  }

  // One warning per name and file, however many times it appears in it.
  const seen = new Set<string>();
  for (const miss of templating.unresolved) {
    const key = `${miss.path}::${miss.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    log.warn(`  ${miss.path}: "<%${miss.name}%>" ${miss.reason}; it installs verbatim`);
  }
}

/**
 * Warn about the writes that land in a file another harness also reads.
 *
 * `-t claude-code` reads as "only Claude Code", and for everything under
 * `.claude/` it is. `.mcp.json` is not: Pi reads the same file, so in a folder
 * where Pi is set up the server installs for Pi as well, and comes back out
 * only when the last claim on it does. Neither surprise is avoidable -- one
 * file cannot be two -- so both are said out loud.
 */
async function reportSharedFiles(
  paths: string[],
  targetId: TargetId,
  options: InstallOptions,
): Promise<void> {
  const present = options.presentTargets ?? (await detectHarnesses(options.scope, options.cwd)).map(
    (harness) => harness.target,
  );

  const notices = sharedFileNotices({
    target: targetId,
    paths,
    scope: options.scope,
    cwd: options.cwd,
    present,
    ...(options.targetOptions ? { options: options.targetOptions } : {}),
  });

  for (const notice of notices) {
    log.warn(
      `  ${notice.path} is shared with ${describeReaders(notice.others)}: ` +
        'what is written here is visible to all of them, and uninstalling from one ' +
        'leaves it in place for the others',
    );
  }
}

/**
 * What the reference remapper did.
 *
 * The rewrites are routine -- one line, only with `--verbose`. A reference the
 * remapper could not follow is not routine: the file it names is not going into
 * this harness, so the instruction stays in the text and points at nothing.
 * That is worth a warning every time.
 */
function reportReferences(plan: { references?: PlanReferences }): void {
  const references = plan.references;
  if (!references) return;

  for (const rewrite of references.rewrites) {
    log.debug(`${rewrite.path}: ${rewrite.from} → ${rewrite.to}`);
  }
  if (references.rewrites.length > 0) {
    const files = new Set(references.rewrites.map((rewrite) => rewrite.path)).size;
    log.debug(
      `remapped ${references.rewrites.length} file reference(s) across ${files} file(s)`,
    );
  }

  for (const miss of references.dropped) {
    log.warn(`  ${miss.path}: "${miss.ref}" ${miss.reason}`);
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
 * was a skill becomes an agent file. Installing a narrower set of flavors drops
 * things: yesterday's C# skills are no longer part of the plan. Either way this
 * install's receipts replace the ones that knew about the old items, so nothing
 * would ever clean them up -- say so, and name the commands that do it properly.
 */
async function warnIfMappingChanged(
  bundleName: string,
  targetId: TargetId,
  targetOptions: TargetOptions,
  flavors: string[],
  options: InstallOptions,
): Promise<void> {
  const record = await findInstallation(options.scope, options.cwd, bundleName, targetId);
  if (!record) return;

  const before = describeTargetOptions(record.targetOptions ?? {});
  const after = describeTargetOptions(targetOptions);

  if (before !== after) {
    log.warn(`  installed here with ${before}, now installing with ${after}`);
    log.warn(
      '  anything that moves will be left behind at its old path -- ' +
        `"hcm update ${bundleName}" swaps them over, or uninstall first`,
    );
  }

  if (!sameFlavors(record.flavors, flavors)) {
    log.warn(
      `  installed here as ${describeFlavorSelection(record.flavors)}, ` +
        `now installing ${describeFlavorSelection(flavors)}`,
    );
    log.warn(
      '  anything dropping out of the selection stays where it is -- ' +
        `"hcm update ${bundleName} --flavor ${flavors.join(' ') || ALL_FLAVORS}" swaps them over, ` +
        'or uninstall first',
    );
  }
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
