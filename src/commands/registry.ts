import { spawn } from 'node:child_process';
import type { CollectionClashPolicy } from '../core/collection-clash.js';
import { HcmError } from '../core/errors.js';
import { flavorNames } from '../core/flavors.js';
import { parameterNames } from '../core/parameters.js';
import { ensureDir } from '../core/fsx.js';
import { describeSource } from '../core/github.js';
import { color, log } from '../core/logger.js';
import { storeDir } from '../core/paths.js';
import {
  addToRegistry,
  asList,
  availableEntries,
  collectionNames,
  entriesInCollection,
  liveEntries,
  matchEntry,
  readRegistry,
  refreshEntry,
  removeCollectionFromRegistry,
  removeFromRegistry,
  requireEntry,
} from '../core/registry.js';
import { storeEntryDir } from '../core/store.js';
import { entryMode } from './list.js';
import { readState } from '../core/state.js';
import type { RegistryEntry, Scope } from '../core/types.js';

export async function registryAddCommand(
  sources: string | string[],
  options: {
    name?: string;
    dev?: boolean;
    collection?: string;
    onCollectionClash?: CollectionClashPolicy;
    cwd: string;
  },
): Promise<void> {
  const wanted = asList(sources);

  // `--name` renames the entry, so it can only mean one of them.
  if (options.name && wanted.length > 1) {
    throw new HcmError(
      '--name takes one bundle, but several sources were given',
      'Register them one at a time to name each, or drop --name to keep their own names.',
    );
  }

  const entries: RegistryEntry[] = [];
  for (const source of wanted) {
    entries.push(
      ...(await addToRegistry(source, options.cwd, {
        name: options.name,
        dev: options.dev,
        ...(options.collection !== undefined ? { collection: options.collection } : {}),
        ...(options.onCollectionClash ? { onCollectionClash: options.onCollectionClash } : {}),
      })),
    );
  }

  for (const entry of entries) {
    const mode = entry.dev ? color.yellow(' [dev]') : '';
    log.success(
      `Registered ${color.dim(`[${entry.id}]`)} ${color.bold(entry.name)} v${entry.version}${mode} ` +
        `${color.dim(describeSource(entry.source))}`,
    );
  }

  // Tell how to remove the group in one step: that is why it has a name.
  for (const collection of collectionNames(entries)) {
    log.info(
      color.dim(
        `Collection ${color.bold(collection)}: remove all of its bundles with ` +
          `"hcm registry remove --collection ${collection}".`,
      ),
    );
  }

  if (entries.some((entry) => entry.dev)) {
    log.info(
      color.dim(
        'Dev bundles are read from that directory every time, so edit and re-run "hcm install" freely.',
      ),
    );
  } else {
    log.info(
      color.dim(
        'Copied into the store; run "hcm registry update" to pick up later changes at the source.',
      ),
    );
  }

  // One command, however many were registered: `hcm install` takes a list.
  const ids = entries.map((entry) => entry.id);
  log.info(
    color.dim(
      ids.length === 1
        ? `Install it with: hcm install ${ids[0]}`
        : `Install them with: hcm install ${ids.join(' ')}`,
    ),
  );

  // A bundle that can be installed in parts is worth saying so about once,
  // here, rather than leaving it to be discovered in `hcm info`.
  for (const entry of entries) {
    if (!entry.flavors?.length) continue;
    log.info(
      color.dim(
        `${color.bold(entry.name)} installs in parts: ${flavorNames(entry.flavors)} — ` +
          `e.g. hcm install ${entry.id} --flavor ${entry.flavors[0]?.name}`,
      ),
    );
  }

  // The same for a bundle that will stop and ask: knowing the names in advance
  // is what makes a scripted install possible at all.
  for (const entry of entries) {
    if (!entry.parameters?.length) continue;
    log.info(
      color.dim(
        `${color.bold(entry.name)} is customised at install time: ` +
          `${parameterNames(entry.parameters)} — ` +
          `e.g. hcm install ${entry.id} --param ${entry.parameters[0]?.name}=<value>`,
      ),
    );
  }
}

/**
 * `hcm registry remove` -- unregister bundles by name or id, and with
 * `--collection`, every bundle of that collection. Give references, a
 * collection, or both.
 */
export async function registryRemoveCommand(
  references: string[],
  options: { collection?: string; cwd: string },
): Promise<void> {
  if (references.length === 0 && options.collection === undefined) {
    throw new HcmError(
      'Name the bundles to remove, or a collection',
      'For example: "hcm registry remove 3 4", or "hcm registry remove --collection agent-kits".',
    );
  }

  // The collection first: a reference to one of its bundles is then already
  // gone, and is not reported as unknown.
  const removedByCollection: RegistryEntry[] = [];
  if (options.collection !== undefined) {
    for (const removed of await removeCollectionFromRegistry(options.collection)) {
      removedByCollection.push(removed.entry);
      await reportRemoval(removed, options.cwd);
    }
  }

  for (const reference of references) {
    const removed = await removeFromRegistry(reference);
    if (removed) await reportRemoval(removed, options.cwd);
    else if (!matchEntry(removedByCollection, reference)) {
      throw new HcmError(`"${reference}" is not registered`);
    }
  }
}

async function reportRemoval(
  removed: { entry: RegistryEntry; storeRemoved: boolean },
  cwd: string,
): Promise<void> {
  const { entry, storeRemoved } = removed;
  log.success(`Removed ${color.dim(`[${entry.id}]`)} ${color.bold(entry.name)}`);

  if (storeRemoved) log.info(color.dim(`  deleted the stored copy (${entry.store})`));
  else if (entry.dev) {
    log.info(color.dim(`  left your working copy alone (${describeSource(entry.source)})`));
  }

  const installed = await installationsOf(entry.name, cwd);
  if (installed.length > 0) {
    log.warn(
      `  still installed in ${installed.join(', ')} — ` +
        `run "hcm uninstall ${entry.name}" to remove those items.`,
    );
  }
}

/**
 * `hcm registry update` -- read registered bundles from their sources again,
 * and replace the stored copies.
 *
 * This is the registry half of `hcm update`. It downloads the latest files of
 * each remote source and copies each local source again, but it does not touch
 * a project. `hcm update` then puts the new version where the old one is
 * installed.
 *
 * No argument means every registered bundle. One source that cannot be read
 * does not stop the others; the command reports it and exits with code 1.
 */
export async function registryUpdateCommand(
  references: string[],
  options: { dryRun?: boolean } = {},
): Promise<void> {
  const entries = await entriesToUpdate(references);

  if (entries.length === 0) {
    log.info('No bundles registered.');
    log.info(color.dim('Add one with: hcm registry add <path|url|owner/repo>'));
    return;
  }

  // Shared by the whole run, so a repository that holds several of these
  // bundles is downloaded once.
  const fetched = new Set<string>();
  let failed = 0;

  for (const entry of entries) {
    const label = `${color.dim(`[${entry.id}]`)} ${color.bold(entry.name)}`;

    if (entry.builtin) {
      log.info(`${label} ${color.dim('is built into hcm; it has the version of the hcm that runs')}`);
      continue;
    }

    try {
      const { bundle, previousVersion } = await refreshEntry(entry, {
        dryRun: options.dryRun ?? false,
        fetched,
      });
      const version =
        previousVersion && previousVersion !== bundle.manifest.version
          ? `${color.dim(`v${previousVersion}`)} → ${color.bold(`v${bundle.manifest.version}`)}`
          : color.dim(`v${bundle.manifest.version} (same version)`);
      log.success(`${label} ${version} ${color.dim(describeSource(entry.source))}`);
    } catch (error) {
      if (!(error instanceof HcmError)) throw error;
      failed += 1;
      log.error(`${label} ${error.message}`);
      if (error.hint) log.info(color.dim(`  ${error.hint}`));
    }
  }

  if (options.dryRun) {
    log.info(color.dim('Dry run: the store and the registry did not change.'));
  } else if (failed < entries.length) {
    log.info(color.dim('Run "hcm update" in a project to install the new versions there.'));
  }
  if (failed > 0) process.exitCode = 1;
}

/** The entries that the references name, in registry order, each one once. */
async function entriesToUpdate(references: string[]): Promise<RegistryEntry[]> {
  if (references.length === 0) return (await readRegistry()).entries;

  const wanted = new Map<string, RegistryEntry>();
  for (const reference of references) {
    const entry = await requireEntry(reference);
    wanted.set(entry.id, entry);
  }
  return (await availableEntries()).filter((entry) => wanted.has(entry.id));
}

/** Where a bundle is currently installed, as "target (scope)" labels. */
async function installationsOf(bundle: string, cwd: string): Promise<string[]> {
  const labels: string[] = [];
  for (const scope of ['project', 'user'] as Scope[]) {
    const state = await readState(scope, cwd);
    for (const record of state.installations) {
      if (record.bundle === bundle) labels.push(`${record.target} (${scope})`);
    }
  }
  return labels;
}

export async function registryListCommand(
  options: { json?: boolean; collection?: string },
): Promise<void> {
  // Read from the working copy for dev entries -- see liveEntry in core/registry.
  const available = await availableEntries();
  const selected =
    options.collection === undefined
      ? available
      : entriesInCollection(available, options.collection);
  const entries = await liveEntries(selected);

  if (options.json) {
    log.plain(JSON.stringify(entries, null, 2));
    return;
  }

  if (entries.length === 0) {
    if (options.collection === undefined) log.info('No bundles registered.');
    else {
      log.info(`No registered bundle is in the collection "${options.collection}".`);
      const known = collectionNames(available);
      if (known.length > 0) log.info(color.dim(`Known collections: ${known.join(', ')}`));
    }
    return;
  }

  const width = Math.max(...entries.map((entry) => entry.id.length));

  for (const entry of entries) {
    const mode = entryMode(entry);
    log.plain(
      `${color.dim(entry.id.padStart(width))}  ${color.bold(entry.name)} ` +
        `${color.dim(`v${entry.version ?? '?'}`)}${mode}`,
    );
    log.plain(`  ${' '.repeat(width)}${color.dim(describeSource(entry.source))}`);
    if (entry.collection) {
      log.plain(`  ${' '.repeat(width)}${color.dim(`collection: ${entry.collection.name}`)}`);
    }
    // What this one can be installed as a part of, which is not something the
    // name or the source can tell you.
    if (entry.flavors?.length) {
      log.plain(`  ${' '.repeat(width)}${color.dim(`flavors: ${flavorNames(entry.flavors)}`)}`);
    }
    // And what it will ask for on the way in, which is worth knowing before
    // running the install rather than when it stops to ask.
    if (entry.parameters?.length) {
      log.plain(
        `  ${' '.repeat(width)}${color.dim(`parameters: ${parameterNames(entry.parameters)}`)}`,
      );
    }
  }
}

/**
 * Show -- and open -- the store: the one directory holding every registered
 * bundle's files. With a reference, opens that bundle's folder instead.
 */
export async function registryOpenCommand(
  reference: string | undefined,
  options: { open?: boolean },
): Promise<void> {
  const target = reference ? await bundleDir(reference) : await storeDir();

  // Opening a directory that does not exist yet fails on every platform, and a
  // fresh install has never written the store.
  await ensureDir(target);
  log.plain(target);

  if (options.open === false) return;

  const opened = await openInFileManager(target);
  if (!opened) {
    log.info(color.dim('Could not open a file manager here; the path is printed above.'));
  }
}

/** The directory a registered bundle's files live in, dev or stored. */
async function bundleDir(reference: string): Promise<string> {
  const entry = await requireEntry(reference);
  if (entry.dev || entry.builtin) return devPath(entry);
  if (entry.store) return storeEntryDir(entry.store);

  throw new HcmError(
    `"${entry.name}" has no directory in the store`,
    'Run "hcm update ' + entry.id + '" to populate it.',
  );
}

function devPath(entry: RegistryEntry): string {
  if (entry.source.type !== 'local') {
    throw new HcmError(`"${entry.name}" is read in place but has no local path`);
  }
  return entry.source.path;
}

/** Hand a directory to the platform's file manager. Never throws. */
function openInFileManager(target: string): Promise<boolean> {
  const [command, args] =
    process.platform === 'win32'
      ? ['explorer.exe', [target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];

  return new Promise((resolve) => {
    try {
      const child = spawn(command as string, args as string[], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', () => resolve(false));
      child.unref();
      // Explorer returns a non-zero exit code even when it worked, so a
      // successful spawn is as much confirmation as we are going to get.
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}
