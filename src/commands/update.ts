/**
 * `hcm update` — re-read a registered bundle from its origin, then put the new
 * version wherever the old one was.
 *
 * Reinstalling is rollback-then-install rather than write-over-the-top, because
 * a new version is defined as much by what it *removed* as by what it changed:
 * a subagent deleted upstream has to disappear from the harness too. Items you
 * hand-edited since install still block the way they do for `hcm uninstall`,
 * so an update never silently discards local changes.
 *
 * Three ways to say what to update, and the difference between the last two
 * matters:
 *
 *   hcm update <bundle>  one bundle
 *   hcm update           everything installed here -- the working default
 *   hcm update all       every *registered* bundle, installed here or not
 */

import type { ConflictPolicy, Resolution } from '../core/conflicts.js';
import {
  type DependencyGraph,
  installedDependencies,
  resolveDependencyGraph,
} from '../core/deps.js';
import { loadBundle } from '../core/bundle.js';
import { expandTargets, requireTargetChoice } from '../core/harnesses.js';
import { color, log } from '../core/logger.js';
import { asList, entryDir, readRegistry, refreshEntry, requireEntry } from '../core/registry.js';
import { findInstallation, readState } from '../core/state.js';
import type {
  InstallationRecord,
  InstalledDependency,
  LoadedBundle,
  RegistryEntry,
  Scope,
  TargetOptions,
} from '../core/types.js';
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
  /**
   * Overrides what each installation recorded. Given nothing, every one is
   * reinstalled the way it was installed -- an update should put the new
   * version where the old one was, not quietly relocate it.
   */
  targetOptions?: TargetOptions;
  cwd: string;
}

/**
 * No argument updates everything installed here; `all` updates everything
 * registered; anything else names bundles -- one, or as many as you like.
 */
export async function updateCommand(
  references: string | string[] | undefined,
  options: UpdateOptions,
): Promise<void> {
  const wanted = references === undefined ? undefined : asList(references);
  const chosen = expandTargets(options.targets);
  options = {
    ...options,
    decisions: options.decisions ?? new Map<string, Resolution>(),
    ...(chosen ? { targets: chosen } : {}),
  };
  await assertTargetChosen(wanted, chosen, options);
  const selection = await select(wanted, options);

  if (selection.entries.length === 0) {
    reportEmpty(selection, options);
    return;
  }

  // Said once, before the run, so a long update does not bury it: these are
  // installed here but have nowhere to be re-read from.
  for (const name of selection.unregistered) {
    log.warn(`${name} is installed here but not registered; nothing to update it from`);
    log.warn(color.dim(`  register its source with: hcm registry add <path|owner/repo>`));
  }

  for (const [index, entry] of selection.entries.entries()) {
    if (index > 0) log.plain('');
    await updateOne(entry, options);
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

interface Selection {
  entries: RegistryEntry[];
  /** Installed here, but with no registry entry to re-read them from. */
  unregistered: string[];
  /** Whether the selection came from the ledger rather than from a name. */
  fromLedger: boolean;
}

/**
 * "all" is a literal, not a name -- but a bundle actually called `all` (or with
 * `all` as its id) wins, so nobody is locked out of their own bundle. The same
 * courtesy is why no argument means "what is installed" rather than "all":
 * refreshing a registered bundle that is not installed anywhere does nothing
 * useful, and in a project with a large registry it is a lot of nothing.
 *
 * Several names select several entries, in registry order rather than the order
 * they were typed, so `hcm update 3 1` and `hcm update 1 3` walk the same
 * bundles in the same sequence. A bundle named twice is updated once.
 */
async function select(
  references: string[] | undefined,
  options: UpdateOptions,
): Promise<Selection> {
  const registry = await readRegistry();

  if (references !== undefined && references.length > 0) {
    const selected = new Map<string, RegistryEntry>();

    for (const reference of references) {
      const named = registry.entries.find(
        (entry) => entry.name === reference || entry.id === reference,
      );
      if (named) {
        selected.set(named.id, named);
        continue;
      }
      if (reference === 'all') {
        for (const entry of registry.entries) selected.set(entry.id, entry);
        continue;
      }
      const found = await requireEntry(reference);
      selected.set(found.id, found);
    }

    const entries = registry.entries.filter((entry) => selected.has(entry.id));
    return { entries, unregistered: [], fromLedger: false };
  }

  const installed = new Set((await installations(options)).map((record) => record.bundle));

  // Registry order, not ledger order, so `hcm update` and `hcm update all`
  // walk the same bundles in the same sequence.
  const entries = registry.entries.filter((entry) => installed.has(entry.name));
  const claimed = new Set(entries.map((entry) => entry.name));

  for (const entry of await aliasedEntries(registry.entries, installed, claimed)) {
    entries.push(entry);
  }
  entries.sort((a, b) => registry.entries.indexOf(a) - registry.entries.indexOf(b));

  const unregistered = [...installed].filter((name) => !claimed.has(name)).sort();
  return { entries, unregistered, fromLedger: true };
}

/**
 * Entries whose *manifest* name is installed, when their *registry* name is not.
 *
 * `registry add --name` renames the entry, not the bundle, so an alias records
 * its installation under the manifest name and a name match alone would miss
 * it -- and then report it as unregistered, which is worse than missing it.
 * The real name is only written down inside the bundle, so read it from the
 * copy already on disk: no refresh, no network, and only for the entries a name
 * match did not already account for. An unreadable copy is skipped rather than
 * thrown from, since one broken entry must not stop the other updates.
 *
 * `claimed` is extended in place, so the caller's "installed but not
 * registered" list stays correct.
 */
async function aliasedEntries(
  entries: RegistryEntry[],
  installed: Set<string>,
  claimed: Set<string>,
): Promise<RegistryEntry[]> {
  if ([...installed].every((name) => claimed.has(name))) return [];

  const matched: RegistryEntry[] = [];
  for (const entry of entries) {
    if (claimed.has(entry.name)) continue;

    let name: string;
    try {
      const dir = await entryDir(entry, { refresh: false });
      name = (await loadBundle(dir, entry.source)).manifest.name;
    } catch {
      continue;
    }

    if (!installed.has(name) || claimed.has(name)) continue;
    claimed.add(name);
    matched.push(entry);
  }
  return matched;
}

/** Nothing to do -- say which "nothing" this is, since the fixes differ. */
function reportEmpty(selection: Selection, options: UpdateOptions): void {
  if (!selection.fromLedger) {
    log.info('No bundles registered.');
    log.info(color.dim('Add one with: hcm registry add <path|owner/repo>'));
    return;
  }

  for (const name of selection.unregistered) {
    log.warn(`${name} is installed here but not registered; nothing to update it from`);
  }

  if (selection.unregistered.length === 0) {
    log.info(`No bundles installed in ${scopesOf(options).join(' or ')} scope.`);
    log.info(color.dim('Install one with: hcm install <bundle>'));
  }

  log.info(color.dim('"hcm update all" refreshes every registered bundle.'));
}

async function updateOne(entry: RegistryEntry, options: UpdateOptions): Promise<void> {
  const { entry: updated, bundle, previousVersion } = await refreshEntry(entry, {
    dryRun: options.dryRun ?? false,
  });

  const version =
    previousVersion && previousVersion !== bundle.manifest.version
      ? `${color.dim(`v${previousVersion}`)} → ${color.bold(`v${bundle.manifest.version}`)}`
      : color.dim(`v${bundle.manifest.version} (unchanged)`);

  log.info(
    `${color.dim(`[${updated.id}]`)} ${color.bold(updated.name)} ${version}` +
      (updated.dev ? color.yellow(' [dev]') : ''),
  );

  // Installations are keyed by the manifest name, which `registry add --name`
  // can differ from -- the alias is a registry convenience, not a rename.
  const records = await installedRecords(bundle.manifest.name, options);

  if (records.length === 0) {
    log.info(
      color.dim(
        options.dryRun
          ? '  not installed anywhere; nothing else would change'
          : '  not installed anywhere; the registered copy is now up to date',
      ),
    );
    return;
  }

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
    await reinstall(record, bundle, graph, options);
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
          ...(options.targetOptions ? { targetOptions: options.targetOptions } : {}),
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

/** Replace one installation with the refreshed bundle. */
async function reinstall(
  record: InstallationRecord,
  bundle: LoadedBundle,
  graph: DependencyGraph,
  options: UpdateOptions,
): Promise<void> {
  const rolledBack = await rollbackInstallation(record, {
    cwd: options.cwd,
    dryRun: options.dryRun ?? false,
    force: options.force ?? false,
  });

  // A dry run reports the removal and then the install it *would* have done;
  // a real run that could not remove the old items must not write new ones on
  // top of them, or the two versions would be interleaved with no way back.
  if (!rolledBack && !options.dryRun) {
    log.warn('  skipped: could not remove the installed version cleanly');
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
      // the new version exactly where the old one was.
      targetOptions: options.targetOptions ?? record.targetOptions ?? {},
      ...(options.onConflict ? { onConflict: options.onConflict } : {}),
      ...(options.decisions ? { decisions: options.decisions } : {}),
    },
    {
      // An update does not change why a bundle is here, only what it holds.
      ...(record.auto ? { auto: true } : {}),
      dependencies: resolvedDependencies(record, bundle, graph),
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

/** Every installation of a bundle, filtered by the requested scopes and targets. */
async function installedRecords(
  bundle: string,
  options: UpdateOptions,
): Promise<InstallationRecord[]> {
  return (await installations(options)).filter((record) => record.bundle === bundle);
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
