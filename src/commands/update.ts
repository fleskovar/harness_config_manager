/**
 * `hcm update` — re-read a registered bundle from its origin, then put the new
 * version wherever the old one was.
 *
 * Reinstalling is rollback-then-install rather than write-over-the-top, because
 * a new version is defined as much by what it *removed* as by what it changed:
 * a subagent deleted upstream has to disappear from the harness too. Items you
 * hand-edited since install still block the way they do for `hcm uninstall`,
 * so an update never silently discards local changes.
 */

import type { ConflictPolicy, Resolution } from '../core/conflicts.js';
import { color, log } from '../core/logger.js';
import { readRegistry, refreshEntry, requireEntry } from '../core/registry.js';
import { readState } from '../core/state.js';
import type { InstallationRecord, LoadedBundle, RegistryEntry, Scope } from '../core/types.js';
import { installInto, logTargetHeader } from './install.js';
import { rollbackInstallation } from './uninstall.js';

export interface UpdateOptions {
  targets?: string[];
  scope?: Scope | 'all';
  dryRun?: boolean;
  force?: boolean;
  onConflict?: ConflictPolicy;
  /** Answers shared across every bundle and target this run touches. */
  decisions?: Map<string, Resolution>;
  cwd: string;
}

/** `hcm update all` updates everything registered; anything else names one bundle. */
export async function updateCommand(reference: string, options: UpdateOptions): Promise<void> {
  const entries = await select(reference);
  options = { ...options, decisions: options.decisions ?? new Map<string, Resolution>() };

  if (entries.length === 0) {
    log.info('No bundles registered.');
    log.info(color.dim('Add one with: hcm registry add <path|owner/repo>'));
    return;
  }

  for (const [index, entry] of entries.entries()) {
    if (index > 0) log.plain('');
    await updateOne(entry, options);
  }
}

/**
 * "all" is a literal, not a name -- but a bundle actually called `all` (or with
 * `all` as its id) wins, so nobody is locked out of their own bundle.
 */
async function select(reference: string): Promise<RegistryEntry[]> {
  const registry = await readRegistry();
  const named = registry.entries.find(
    (entry) => entry.name === reference || entry.id === reference,
  );
  if (named) return [named];
  if (reference === 'all') return registry.entries;
  return [await requireEntry(reference)];
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

  for (const record of records) {
    logTargetHeader(record.target, { scope: record.scope, cwd: options.cwd });
    await reinstall(record, bundle, options);
  }
}

/** Replace one installation with the refreshed bundle. */
async function reinstall(
  record: InstallationRecord,
  bundle: LoadedBundle,
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

  await installInto(bundle, record.target, {
    scope: record.scope,
    cwd: options.cwd,
    dryRun: options.dryRun ?? false,
    force: options.force ?? false,
    ...(options.onConflict ? { onConflict: options.onConflict } : {}),
    ...(options.decisions ? { decisions: options.decisions } : {}),
  });
}

/** Every installation of a bundle, filtered by the requested scopes and targets. */
async function installedRecords(
  bundle: string,
  options: UpdateOptions,
): Promise<InstallationRecord[]> {
  const scopes: Scope[] =
    options.scope === undefined || options.scope === 'all'
      ? ['project', 'user']
      : [options.scope];

  const records: InstallationRecord[] = [];
  for (const scope of scopes) {
    const state = await readState(scope, options.cwd);
    records.push(...state.installations.filter((record) => record.bundle === bundle));
  }

  if (!options.targets?.length) return records;
  return records.filter((record) => options.targets?.includes(record.target));
}
