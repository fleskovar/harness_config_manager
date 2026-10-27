/**
 * `hcm update` — read a new version of each installed bundle, then put it
 * wherever the old one was.
 *
 * Reinstalling is rollback-then-install rather than write-over-the-top, because
 * a new version is defined as much by what it *removed* as by what it changed:
 * a subagent deleted upstream has to disappear from the harness too. Items you
 * hand-edited since install still block the way they do for `hcm uninstall`,
 * so an update never silently discards local changes.
 *
 * Each installation follows either the registry or its own source -- see
 * `core/tracking.ts`. A registry installation is updated by refreshing the
 * registered bundle, then reinstalling it. A source installation is updated by
 * reading its recorded source again; the registry is not read or written.
 *
 * Three ways to say what to update, and the difference between the last two
 * matters:
 *
 *   hcm update <bundle>  one bundle
 *   hcm update           everything installed here -- the working default
 *   hcm update all       everything installed here, and every *registered*
 *                        bundle, installed here or not
 */

import { loadBundle } from '../core/bundle.js';
import type { ConflictPolicy, Resolution } from '../core/conflicts.js';
import {
  type DependencyGraph,
  installedDependencies,
  resolveDependencyGraph,
} from '../core/deps.js';
import { HcmError } from '../core/errors.js';
import { assertFlavorsAvailable, expandFlavors } from '../core/flavors.js';
import { describeSource, resolveSource } from '../core/github.js';
import { expandTargets, requireTargetChoice } from '../core/harnesses.js';
import { color, log } from '../core/logger.js';
import {
  emptyOverrides,
  mergeOverrides,
  type ParameterOverrides,
  parseAssignments,
  readParametersFile,
} from '../core/parameters.js';
import {
  asList,
  availableEntries,
  entryDir,
  loadBundlesFrom,
  matchEntry,
  parseSource,
  refreshEntry,
} from '../core/registry.js';
import { findInstallation, readState } from '../core/state.js';
import {
  describeRecordedSource,
  effectiveTrack,
  recordedSource,
  sameOrigin,
  warnIfRegistryDiffers,
} from '../core/tracking.js';
import type {
  BundleSource,
  InstallationRecord,
  InstalledDependency,
  LoadedBundle,
  RegistryEntry,
  Scope,
  TargetOptions,
  TrackMode,
} from '../core/types.js';
import { entryMode } from './list.js';
import { installBundle, installInto, logTargetHeader } from './install.js';
import { rollbackInstallation } from './uninstall.js';

export interface UpdateOptions {
  targets?: string[];
  scope?: Scope | 'all';
  dryRun?: boolean;
  force?: boolean;
  onConflict?: ConflictPolicy;
  /** Answers shared across every bundle and target this run touches. */
  decisions?: Map<string, Resolution>;
  /** Parameter answers shared across every bundle and target this run touches. */
  answers?: Map<string, string>;
  /** Downloads shared across this run: one repository, one download. */
  fetched?: Set<string>;
  /**
   * Overrides what each installation recorded. Given nothing, every one is
   * reinstalled the way it was installed -- an update should put the new
   * version where the old one was, not quietly relocate it.
   */
  targetOptions?: TargetOptions;
  /**
   * `--param` assignments, overriding the values each installation recorded.
   * Given nothing, every one is rendered with exactly what it was rendered with
   * before -- an update should not rename the agent behind your back.
   */
  params?: string[];
  /** `--params-file`: files of parameter values, later ones winning. */
  paramsFiles?: string[];
  /** `params` and `paramsFiles` already parsed and merged; filled in by this command. */
  parameterOverrides?: ParameterOverrides;
  /**
   * Ask again for every parameter, ignoring what was recorded. The way to
   * change an answer without remembering how it was originally spelled.
   */
  reconfigure?: boolean;
  /** Never ask; use what is recorded, then the defaults. */
  prompt?: boolean;
  /**
   * Overrides the subset each installation recorded. Given nothing, every one
   * is reinstalled as the same set of flavors it already was -- `--flavor all`
   * is how you widen a narrowed installation back to the whole bundle.
   */
  flavors?: string[];
  /**
   * `--no-registry` (false): read each installation that follows the registry
   * from the source it recorded instead, this time only. The registry and the
   * store do not change.
   */
  registry?: boolean;
  /**
   * `--track`: switch the installations this run touches to this mode, and
   * record it. See `core/tracking.ts`.
   */
  track?: TrackMode;
  /**
   * `--from`: read the bundle from this source, and follow that source from
   * now on. For a virtual environment that moved, or for a project that stops
   * following the registry.
   */
  from?: string;
  cwd: string;
}

/**
 * No argument updates everything installed here; `all` also refreshes every
 * registered bundle; anything else names bundles -- one, or as many as you like.
 */
export async function updateCommand(
  references: string | string[] | undefined,
  options: UpdateOptions,
): Promise<void> {
  const wanted = references === undefined ? undefined : asList(references);
  const chosen = expandTargets(options.targets);
  assertTrackingFlags(options);

  // Read up front, so a malformed assignment stops the run before the first
  // bundle has been rolled back and reinstalled.
  const parameterOverrides = await collectOverrides(options);

  options = {
    ...options,
    decisions: options.decisions ?? new Map<string, Resolution>(),
    answers: options.answers ?? new Map<string, string>(),
    fetched: options.fetched ?? new Set<string>(),
    parameterOverrides,
    ...(chosen ? { targets: chosen } : {}),
    // Three states, not two: no flag reinstalls what each record says, while
    // `--flavor all` is an empty selection, meaning the whole bundle.
    ...(options.flavors === undefined ? {} : { flavors: expandFlavors(options.flavors) ?? [] }),
  };
  await assertTargetChosen(wanted, chosen, options);
  const plan = await planUpdate(wanted, options);

  if (plan.jobs.length === 0) {
    reportEmpty(plan, options);
    return;
  }

  for (const [index, job] of plan.jobs.entries()) {
    if (index > 0) log.plain('');
    if (job.kind === 'registry') await updateFromRegistry(job, options);
    else await updateFromSource(job, options);
  }
}

/** Refuse the flag combinations that contradict each other. */
function assertTrackingFlags(options: UpdateOptions): void {
  if (options.from !== undefined && options.track === 'registry') {
    throw new HcmError(
      '--from and --track registry contradict each other',
      '--from makes the installation follow that source. Use one of the two.',
    );
  }
  if (options.registry === false && options.track === 'registry') {
    throw new HcmError(
      '--no-registry and --track registry contradict each other',
      'Use --track registry to follow the registry, or --no-registry to read the sources once.',
    );
  }
}

/**
 * An update reinstalls wherever the ledger says the bundle already is, which in
 * a multi-harness folder is several harnesses at once -- so it needs `-t` for
 * the same reason install and uninstall do.
 *
 * Checked a scope at a time, because presence is a fact about a scope: a folder
 * with three harnesses in it says nothing about the home directory, and
 * `hcm update -s all` covers both.
 */
async function assertTargetChosen(
  references: string[] | undefined,
  chosen: ReturnType<typeof expandTargets>,
  options: UpdateOptions,
): Promise<void> {
  const records = await installations(options);

  for (const scope of scopesOf(options)) {
    const affected = [
      ...new Set(records.filter((record) => record.scope === scope).map((record) => record.target)),
    ];
    if (affected.length < 2) continue;

    await requireTargetChoice({
      ...(chosen ? { chosen } : {}),
      affected,
      command: `hcm update${references?.length ? ` ${references.join(' ')}` : ''}`,
      scope,
      cwd: options.cwd,
    });
  }
}

// ---------------------------------------------------------------------------
// Planning: which installations, and where each one reads its next version
// ---------------------------------------------------------------------------

/** Refresh a registered bundle, then reinstall it where these records are. */
interface RegistryJob {
  kind: 'registry';
  entry: RegistryEntry;
  /** Empty when the bundle is not installed here: the refresh is all there is. */
  records: InstallationRecord[];
  /** Record this mode on each reinstalled installation. */
  switchTo?: TrackMode;
}

/** Read one source, then reinstall it where these records are. */
interface SourceJob {
  kind: 'source';
  /** The manifest name the records were installed under. */
  bundle: string;
  source: BundleSource;
  records: InstallationRecord[];
  switchTo?: TrackMode;
  /** Already read, by `--from`. */
  loaded?: LoadedBundle;
  /** Follows the registry, read from its source this time only. */
  once?: boolean;
}

type UpdateJob = RegistryJob | SourceJob;

interface UpdatePlan {
  jobs: UpdateJob[];
  /** Whether the selection came from the ledger rather than from a name. */
  fromLedger: boolean;
}

/**
 * Decide what to update, and where each installation reads its next version.
 *
 * Bundles are picked by name, by id, by `all`, or -- with no argument -- from
 * the ledger. Each installation picked is then a registry job or a source job,
 * by its mode (see `core/tracking.ts`), after `--track`, `--from` and
 * `--no-registry`.
 *
 * Registry jobs come in registry order, so `hcm update 3 1` and `hcm update 1
 * 3` walk the same bundles in the same sequence. Source jobs follow, by name.
 * A bundle named twice is updated once.
 */
async function planUpdate(
  references: string[] | undefined,
  options: UpdateOptions,
): Promise<UpdatePlan> {
  const available = await availableEntries();
  const records = await installations(options);
  const registered = await registryIndex(
    available,
    new Set(records.map((record) => record.bundle)),
  );

  if (options.from !== undefined) {
    return { jobs: [await planFrom(options.from, references, records, available, options)], fromLedger: false };
  }

  const picked = pickRecords(references, records, available, registered);
  const registryJobs = new Map<string, RegistryJob>();
  const sourceJobs = new Map<string, SourceJob>();

  for (const entry of picked.entries) {
    registryJobs.set(entry.id, { kind: 'registry', entry, records: [] });
  }

  for (const record of picked.records) {
    const entry = registered.get(record.bundle);
    const mode = modeFor(record, entry, options);

    if (mode === 'registry' && entry && options.registry !== false) {
      const job = registryJobs.get(entry.id) ?? { kind: 'registry', entry, records: [] };
      job.records.push(record);
      if (options.track) job.switchTo = options.track;
      registryJobs.set(entry.id, job);
      continue;
    }

    const source = recordedSource(record, options.cwd);
    const key = `${record.bundle}::${JSON.stringify(source)}`;
    const job: SourceJob = sourceJobs.get(key) ?? {
      kind: 'source',
      bundle: record.bundle,
      source,
      records: [],
      ...(mode === 'registry' ? { once: true } : {}),
    };
    job.records.push(record);
    if (options.track) job.switchTo = options.track;
    sourceJobs.set(key, job);
  }

  const order = (entry: RegistryEntry): number => available.indexOf(entry);
  const jobs: UpdateJob[] = [
    ...[...registryJobs.values()].sort((a, b) => order(a.entry) - order(b.entry)),
    ...[...sourceJobs.values()].sort((a, b) => a.bundle.localeCompare(b.bundle)),
  ];
  return { jobs, fromLedger: picked.fromLedger };
}

/**
 * The mode one installation is updated in, this run.
 *
 * A built-in bundle has no source apart from the hcm that runs, so it always
 * follows the registry. `--track registry` on a bundle that is not registered
 * has nothing to follow, and is refused.
 */
function modeFor(
  record: InstallationRecord,
  entry: RegistryEntry | undefined,
  options: UpdateOptions,
): TrackMode {
  if (entry?.builtin) return 'registry';

  if (options.track === 'registry' && !entry) {
    throw new HcmError(
      `"${record.bundle}" is not registered, so it cannot follow the registry`,
      'Register it with "hcm registry add <path|url>" first.',
    );
  }

  const mode = options.track ?? effectiveTrack(record, entry !== undefined);
  // A record that chose the registry, whose bundle was unregistered since,
  // still has its own source to read.
  if (mode === 'registry' && !entry) {
    log.warn(`${record.bundle} follows the registry, but it is not registered any more`);
    log.warn(color.dim(`  reading the source it was installed from: ${describeRecordedSource(record)}`));
    return 'source';
  }
  return mode;
}

/**
 * The installations and registry entries that the references name.
 *
 * A name picks the installations of that bundle here. It picks the registry
 * entry only when the bundle is registered and not installed here in this
 * scope: then refreshing the registered copy is all an update can do. A bundle
 * that is installed here only as a pinned source does not touch the registry.
 */
function pickRecords(
  references: string[] | undefined,
  records: InstallationRecord[],
  available: RegistryEntry[],
  registered: Map<string, RegistryEntry>,
): { records: InstallationRecord[]; entries: RegistryEntry[]; fromLedger: boolean } {
  if (references === undefined || references.length === 0) {
    return { records, entries: [], fromLedger: true };
  }

  const pickedRecords = new Set<InstallationRecord>();
  const pickedEntries = new Set<RegistryEntry>();
  const installed = new Set(records.map((record) => record.bundle));

  for (const reference of references) {
    // "all" is a literal, not a name -- but a bundle actually called `all`
    // (or with `all` as its id) wins, so nobody is locked out of their own
    // bundle.
    const named = available.find((entry) => entry.name === reference || entry.id === reference);
    if (reference === 'all' && !named && !installed.has(reference)) {
      for (const record of records) pickedRecords.add(record);
      for (const entry of available) pickedEntries.add(entry);
      continue;
    }

    const entry = named ?? matchEntry(available, reference);
    const matches = records.filter(
      (record) => record.bundle === reference || (entry && registered.get(record.bundle) === entry),
    );

    if (matches.length === 0 && !entry) {
      throw new HcmError(
        `"${reference}" is not installed here, and it is not a registered bundle`,
        installed.size > 0
          ? `Installed here: ${[...installed].sort().join(', ')}`
          : 'Nothing is installed in this scope. Try "hcm install <bundle>".',
      );
    }

    for (const record of matches) pickedRecords.add(record);
    if (matches.length === 0 && entry) pickedEntries.add(entry);
  }

  // A picked entry and the registry installations of its bundle share one job,
  // so the registered copy is refreshed once.
  return {
    records: records.filter((record) => pickedRecords.has(record)),
    entries: [...pickedEntries],
    fromLedger: false,
  };
}

/**
 * `--from <source>`: read the bundle there, and make each installation of it
 * follow that source. The source holds one bundle, and that bundle has to be
 * installed here already -- `hcm install --track source` is for a first
 * install.
 */
async function planFrom(
  from: string,
  references: string[] | undefined,
  records: InstallationRecord[],
  available: RegistryEntry[],
  options: UpdateOptions,
): Promise<SourceJob> {
  const source = parseSource(from, options.cwd);
  const bundles = await loadBundlesFrom(source, {
    refresh: true,
    ...(options.fetched ? { fetched: options.fetched } : {}),
  });

  if (bundles.length > 1) {
    throw new HcmError(
      `--from needs one bundle, but ${from} contains ${bundles.length}`,
      `Name the folder of one of: ${bundles.map((bundle) => bundle.manifest.name).join(', ')}`,
    );
  }

  const bundle = bundles[0] as LoadedBundle;
  const name = bundle.manifest.name;

  for (const reference of references ?? []) {
    const meant = matchEntry(available, reference)?.name ?? reference;
    if (meant !== name) {
      throw new HcmError(
        `--from ${from} holds the bundle "${name}", not "${reference}"`,
        `Run "hcm update ${name} --from ${from}", or name no bundle.`,
      );
    }
  }

  const matches = records.filter((record) => record.bundle === name);
  if (matches.length === 0) {
    throw new HcmError(
      `"${name}" is not installed here, so there is nothing to update`,
      `Install it with: hcm install ${from} --track source`,
    );
  }

  return { kind: 'source', bundle: name, source: bundle.source, records: matches, switchTo: 'source', loaded: bundle };
}

/**
 * The registry entry each installed bundle name belongs to.
 *
 * Mostly a name match. `registry add --name` renames the entry, not the
 * bundle, so an alias records its installation under the manifest name, and a
 * name match alone would miss it. The real name is only written down inside
 * the bundle, so read it from the copy already on disk: no refresh, no network,
 * and only for the names that a name match did not already account for. An
 * unreadable copy is skipped rather than thrown from, since one broken entry
 * must not stop the other updates.
 */
async function registryIndex(
  entries: RegistryEntry[],
  installed: Set<string>,
): Promise<Map<string, RegistryEntry>> {
  const index = new Map<string, RegistryEntry>();
  for (const entry of entries) {
    if (installed.has(entry.name) && !index.has(entry.name)) index.set(entry.name, entry);
  }
  if ([...installed].every((name) => index.has(name))) return index;

  for (const entry of entries) {
    if (index.has(entry.name)) continue;

    let name: string;
    try {
      const dir = await entryDir(entry, { refresh: false });
      name = (await loadBundle(dir, entry.source)).manifest.name;
    } catch {
      continue;
    }

    if (installed.has(name) && !index.has(name)) index.set(name, entry);
  }
  return index;
}

/**
 * Everything `--param` and `--params-file` said, in one place. Files first,
 * flags second -- the same reading `hcm install` gives them.
 */
async function collectOverrides(options: UpdateOptions): Promise<ParameterOverrides> {
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

/** Nothing to do -- say which "nothing" this is, since the fixes differ. */
function reportEmpty(plan: UpdatePlan, options: UpdateOptions): void {
  if (!plan.fromLedger) {
    log.info('No bundles registered.');
    log.info(color.dim('Add one with: hcm registry add <path|url|owner/repo>'));
    return;
  }

  log.info(`No bundles installed in ${scopesOf(options).join(' or ')} scope.`);
  log.info(color.dim('Install one with: hcm install <bundle>'));
  log.info(color.dim('"hcm update all" refreshes every registered bundle.'));
}

// ---------------------------------------------------------------------------
// Running one job
// ---------------------------------------------------------------------------

/** Refresh a registered bundle, then reinstall it wherever its records are. */
async function updateFromRegistry(job: RegistryJob, options: UpdateOptions): Promise<void> {
  const { entry: updated, bundle, previousVersion } = await refreshEntry(job.entry, {
    dryRun: options.dryRun ?? false,
    ...(options.fetched ? { fetched: options.fetched } : {}),
  });

  log.info(
    `${color.dim(`[${updated.id}]`)} ${color.bold(updated.name)} ` +
      `${describeVersion(previousVersion, bundle.manifest.version)}${entryMode(updated)}`,
  );

  if (job.records.length === 0) {
    log.info(
      color.dim(
        options.dryRun
          ? '  not installed anywhere; nothing else would change'
          : '  not installed anywhere; the registered copy is now up to date',
      ),
    );
    return;
  }

  // An installation that came from another place is moved onto the registered
  // copy now. That is what following the registry means, but it is worth one
  // line: the user can pin the old source instead.
  for (const record of job.records) {
    if (record.track || sameOrigin(record.source, bundle.source)) continue;
    log.info(
      color.dim(
        `  ${record.target}: installed from ${describeRecordedSource(record)}; ` +
          'now from the registry (keep that source with --track source)',
      ),
    );
  }

  await reinstallAll(bundle, job.records, job.switchTo, options);
}

/**
 * Read a source again, then reinstall it wherever its records are. The
 * registry is not read or written, apart from a warning when it holds another
 * version of the same bundle.
 *
 * A source that cannot be read is reported, and the run goes on: a deleted
 * virtual environment in one project must not stop every other update.
 */
async function updateFromSource(job: SourceJob, options: UpdateOptions): Promise<void> {
  let bundle: LoadedBundle;
  try {
    bundle = job.loaded ?? (await loadBundle(
      await resolveSource(job.source, {
        refresh: true,
        ...(options.fetched ? { fetched: options.fetched } : {}),
      }),
      job.source,
    ));
  } catch (error) {
    if (!(error instanceof HcmError)) throw error;
    log.error(`${color.bold(job.bundle)} ${error.message}`);
    log.info(
      color.dim(
        `  point it at where the bundle is now: hcm update ${job.bundle} --from <path|url>`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  if (bundle.manifest.name !== job.bundle) {
    log.error(
      `${color.bold(job.bundle)} ${describeSource(job.source)} now holds the bundle ` +
        `"${bundle.manifest.name}", not "${job.bundle}"`,
    );
    log.info(color.dim(`  point it at the right folder: hcm update ${job.bundle} --from <path|url>`));
    process.exitCode = 1;
    return;
  }

  const previous = job.records[0]?.version;
  const mode = job.once ? color.dim(' [source, this time]') : color.magenta(' [source]');
  log.info(
    `${color.bold(job.bundle)} ${describeVersion(previous, bundle.manifest.version)}${mode}`,
  );
  log.info(color.dim(`  from ${describeSource(bundle.source)}`));
  await warnIfRegistryDiffers(bundle);

  await reinstallAll(bundle, job.records, job.switchTo, options);
}

/** "v1.0.0 → v1.1.0", or "v1.0.0 (unchanged)". */
function describeVersion(previous: string | undefined, current: string): string {
  return previous && previous !== current
    ? `${color.dim(`v${previous}`)} → ${color.bold(`v${current}`)}`
    : color.dim(`v${current} (unchanged)`);
}

/**
 * Put one new version in place of the old one, in each of its installations,
 * after the dependencies that it gained.
 */
async function reinstallAll(
  bundle: LoadedBundle,
  records: InstallationRecord[],
  switchTo: TrackMode | undefined,
  options: UpdateOptions,
): Promise<void> {
  // A `--flavor` this bundle does not have is refused here rather than left to
  // narrow the install to nothing. `hcm update all` can name bundles that have
  // no flavors at all, so this only applies where one was asked for.
  if (options.flavors?.length) assertFlavorsAvailable([bundle], options.flavors);

  // A new version can require something the old one did not. Those bundles are
  // installed first, exactly as `hcm install` would have done, so the reinstall
  // below lands on a complete set.
  //
  // A dependency that cannot be resolved is reported and the update carries on:
  // `hcm update all` should not stop at the first bundle whose requirement has
  // gone missing, and the installed copy is no worse for being refreshed.
  let graph: DependencyGraph;
  try {
    graph = await resolveDependencyGraph([bundle], options.cwd, {});
    await installNewDependencies(bundle, graph, records, options);
  } catch (error) {
    log.warn(`  ${(error as Error).message}`);
    log.warn('  updating it anyway; run "hcm install" once the dependency is available');
    graph = { order: [], byName: new Map(), hasDependencies: false };
  }

  for (const record of records) {
    logTargetHeader(record.target, { scope: record.scope, cwd: options.cwd });
    await reinstall(record, bundle, graph, switchTo ?? record.track, options);
  }
}

/**
 * Install the dependencies this bundle has gained, into the places it is
 * already installed. Dependencies that are there stay as they are -- updating
 * one bundle should not silently update another; `hcm update all` does that.
 */
async function installNewDependencies(
  bundle: LoadedBundle,
  graph: DependencyGraph,
  records: InstallationRecord[],
  options: UpdateOptions,
): Promise<void> {
  // Walked in graph order, so a dependency's own dependencies come first and
  // a whole new subtree can arrive in one update.
  for (const resolved of graph.order) {
    const name = resolved.bundle.manifest.name;
    if (name === bundle.manifest.name) continue;

    const where = { scopes: new Set<Scope>(), targets: new Set<string>() };

    for (const record of records) {
      const installed = await findInstallation(record.scope, options.cwd, name, record.target);
      if (installed) continue;
      where.scopes.add(record.scope);
      where.targets.add(record.target);
    }

    if (where.scopes.size === 0) continue;

    log.info(
      color.dim(
        `  ${name} v${resolved.bundle.manifest.version} is now required and not installed here`,
      ),
    );

    // Installed from the copy already resolved rather than by name: a
    // dependency found beside its dependent, or at the source its manifest
    // names, need never have been registered on this machine.
    for (const scope of where.scopes) {
      await installBundle(
        resolved.bundle,
        {
          scope,
          cwd: options.cwd,
          targets: [...where.targets],
          dryRun: options.dryRun ?? false,
          force: options.force ?? false,
          ...(options.onConflict ? { onConflict: options.onConflict } : {}),
          ...(options.decisions ? { decisions: options.decisions } : {}),
          ...(options.answers ? { answers: options.answers } : {}),
          ...(options.targetOptions ? { targetOptions: options.targetOptions } : {}),
          // A dependency arriving mid-update is narrowed the same way the run
          // is; one that has no such flavor is all common part, so it comes
          // whole. See `core/flavors.ts`.
          ...(options.flavors?.length ? { flavors: options.flavors } : {}),
          // It has never been installed here, so it has nothing recorded and
          // asks for its own parameters from scratch -- with whatever this run
          // supplied on the command line available to answer them.
          ...(options.parameterOverrides
            ? { parameterOverrides: options.parameterOverrides }
            : {}),
          ...(options.prompt === false ? { prompt: false } : {}),
        },
        {
          auto: true,
          dependencies: installedDependencies(resolved.bundle, graph),
          requiredBy: resolved.requiredBy,
        },
      );
    }
  }
}

/**
 * Replace one installation with the refreshed bundle. `track` is the mode to
 * record: the rollback below takes the old record away, so it is handed over,
 * like the parameters and the renames.
 */
async function reinstall(
  record: InstallationRecord,
  bundle: LoadedBundle,
  graph: DependencyGraph,
  track: TrackMode | undefined,
  options: UpdateOptions,
): Promise<void> {
  const rolledBack = await rollbackInstallation(record, {
    cwd: options.cwd,
    dryRun: options.dryRun ?? false,
    force: options.force ?? false,
    // All of it or none of it. An update that could not remove the old version
    // will not write the new one over the top -- so a removal that stopped
    // half way would leave the harness with neither, which is exactly the
    // local work the block was there to protect. See `rollbackInstallation`.
    allOrNothing: true,
  });

  // A dry run reports the removal and then the install it *would* have done;
  // a real run that could not remove the old items must not write new ones on
  // top of them, or the two versions would be interleaved with no way back.
  if (!rolledBack && !options.dryRun) {
    log.warn('  skipped: the installed version is still there, unchanged');
    log.warn(
      color.dim('  revert the edit(s), or re-run with --force to replace them'),
    );
    return;
  }

  await installInto(
    bundle,
    record.target,
    {
      scope: record.scope,
      cwd: options.cwd,
      dryRun: options.dryRun ?? false,
      force: options.force ?? false,
      // What was recorded, unless this run says otherwise -- so `hcm update` puts
      // the new version exactly where the old one was, and no more of it.
      targetOptions: options.targetOptions ?? record.targetOptions ?? {},
      flavors: options.flavors ?? record.flavors ?? [],
      // Handed over rather than looked up: the rollback above has already taken
      // the record away, so by now there is nothing left on disk to read them
      // from. This is what makes an update render the new version with the same
      // values the old one had.
      ...(record.parameters ? { recordedParameters: record.parameters } : {}),
      // The same for renames: a skill installed as `review-my-kit` stays that.
      ...(record.renames ? { recordedRenames: record.renames } : {}),
      ...(options.parameterOverrides ? { parameterOverrides: options.parameterOverrides } : {}),
      ...(options.reconfigure ? { reconfigure: true } : {}),
      ...(options.prompt === false ? { prompt: false } : {}),
      ...(options.onConflict ? { onConflict: options.onConflict } : {}),
      ...(options.decisions ? { decisions: options.decisions } : {}),
      ...(options.answers ? { answers: options.answers } : {}),
    },
    {
      // An update does not change why a bundle is here, only what it holds.
      ...(record.auto ? { auto: true } : {}),
      dependencies: resolvedDependencies(record, bundle, graph),
      ...(track ? { track } : {}),
    },
  );
}

/**
 * What to record as this installation's dependencies. Normally the versions
 * just resolved -- but if resolution failed we keep what was recorded before,
 * rather than writing an empty list that would let `hcm uninstall` take away a
 * bundle something still needs.
 */
function resolvedDependencies(
  record: InstallationRecord,
  bundle: LoadedBundle,
  graph: DependencyGraph,
): InstalledDependency[] {
  const resolved = installedDependencies(bundle, graph);
  if (resolved.length > 0 || bundle.dependencies.length === 0) return resolved;
  return record.dependencies ?? [];
}

/** The scopes this run covers. Omitted means both, as it does for `hcm list`. */
function scopesOf(options: UpdateOptions): Scope[] {
  return options.scope === undefined || options.scope === 'all'
    ? ['project', 'user']
    : [options.scope];
}

/**
 * Every installation in scope, filtered by `--target`. One place, because the
 * bare `hcm update` picks *which bundles to update* from the same ledger view
 * that then decides *where each one goes* -- if those two disagreed, a bundle
 * could be selected here and updated nowhere.
 */
async function installations(options: UpdateOptions): Promise<InstallationRecord[]> {
  const records: InstallationRecord[] = [];
  for (const scope of scopesOf(options)) {
    const state = await readState(scope, options.cwd);
    records.push(...state.installations);
  }

  if (!options.targets?.length) return records;
  return records.filter((record) => options.targets?.includes(record.target));
}
