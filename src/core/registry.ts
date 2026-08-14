/**
 * The registry: a user-level list of bundles this machine knows about, so
 * `hcm install <name>` works without repeating the path or URL every time.
 *
 * Each entry carries a short alphanumeric id (`1`, `2`, ... `a`, `b`) that can
 * be typed anywhere a name can, and -- unless it was registered with `--dev` --
 * a snapshot of the bundle's files in the store. See `store.ts` for why.
 */

import path from 'node:path';
import { discoverBundleDirs, loadBundle } from './bundle.js';
import { HcmError } from './errors.js';
import { summarizeFlavors } from './flavors.js';
import { isDirectory, readJsonIfExists, toPosix, writeJson } from './fsx.js';
import { describeSource, parseGithubSource, resolveSource } from './github.js';
import { registryFile } from './paths.js';
import { populateStore, removeFromStore, storeEntryDir, storeSlug } from './store.js';
import type { BundleSource, LoadedBundle, RegistryEntry, RegistryFile } from './types.js';

/**
 * The smallest id not already taken, in base 36: 1-9, then a-z, then 10, 11...
 * Reusing ids freed by `registry remove` keeps them short, which is the whole
 * point of having them.
 */
export function nextRegistryId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n += 1) {
    const candidate = n.toString(36);
    if (!used.has(candidate)) return candidate;
  }
}

/** Give ids to entries written before ids existed, in registry order. */
function backfillIds(entries: RegistryEntry[]): boolean {
  const taken = new Set(entries.map((entry) => entry.id).filter(Boolean));
  let changed = false;

  for (const entry of entries) {
    if (entry.id) continue;
    entry.id = nextRegistryId(taken);
    taken.add(entry.id);
    changed = true;
  }

  return changed;
}

export async function readRegistry(): Promise<RegistryFile> {
  const registry = await readJsonIfExists<RegistryFile>(registryFile());
  if (!registry || !Array.isArray(registry.entries)) return { version: 1, entries: [] };

  // A one-time migration, persisted so ids do not shift as entries come and go.
  if (backfillIds(registry.entries)) await writeRegistry(registry);
  return registry;
}

export async function writeRegistry(registry: RegistryFile): Promise<void> {
  await writeJson(registryFile(), registry);
}

/**
 * Find the entry a user meant. Exact name first, then id, then a unique
 * case-insensitive name -- so `hcm install 3` and `hcm install My-Kit` both
 * land where you would expect, and an ambiguous match is refused rather than
 * guessed at.
 */
export function matchEntry(entries: RegistryEntry[], reference: string): RegistryEntry | undefined {
  const wanted = reference.trim();

  const byName = entries.find((entry) => entry.name === wanted);
  if (byName) return byName;

  const byId = entries.find((entry) => entry.id.toLowerCase() === wanted.toLowerCase());
  if (byId) return byId;

  const insensitive = entries.filter(
    (entry) => entry.name.toLowerCase() === wanted.toLowerCase(),
  );
  return insensitive.length === 1 ? insensitive[0] : undefined;
}

/** Resolve a reference to a registry entry, or fail with the known ids listed. */
export async function requireEntry(reference: string): Promise<RegistryEntry> {
  const registry = await readRegistry();
  const entry = matchEntry(registry.entries, reference);
  if (entry) return entry;

  throw new HcmError(
    `"${reference}" is not a registered bundle`,
    registry.entries.length > 0
      ? `Registered: ${registry.entries.map((known) => `${known.id} ${known.name}`).join(', ')}`
      : 'Nothing is registered yet. Try "hcm registry add <path-or-repo>".',
  );
}

/**
 * The directory holding a registered bundle's files.
 *
 * `--dev` entries point at the user's own working copy. Everything else reads
 * the store, re-populating it when it has gone missing (a cleared home
 * directory, a store on another machine) so a stale registry heals itself.
 */
export async function entryDir(
  entry: RegistryEntry,
  options: { refresh?: boolean } = {},
): Promise<string> {
  if (entry.dev) {
    const working = entry.source.type === 'local' ? entry.source.path : undefined;
    if (!working || !(await isDirectory(working))) {
      throw new HcmError(
        `The dev bundle "${entry.name}" is no longer at ${describeSource(entry.source)}`,
        'Re-register it with "hcm registry add <path> --dev", or drop it with "hcm registry remove".',
      );
    }
    return working;
  }

  // Entries written before the store existed resolve the old way.
  if (!entry.store) return resolveSource(entry.source, options);

  const stored = await storeEntryDir(entry.store);
  if (!options.refresh && (await isDirectory(stored))) return stored;
  return populateStore(entry.store, entry.source, { refresh: true });
}

/** Interpret a user-supplied source: a GitHub shorthand/URL, or a local path. */
export function parseSource(input: string, cwd: string): BundleSource {
  const github = parseGithubSource(input);
  if (github) return github;
  return { type: 'local', path: path.resolve(cwd, input) };
}

/**
 * Narrow a source to a bundle directory found inside it, so each bundle in a
 * collection records where it actually came from.
 */
function narrowSource(source: BundleSource, root: string, bundleDir: string): BundleSource {
  if (path.resolve(root) === path.resolve(bundleDir)) return source;
  const relative = toPosix(path.relative(root, bundleDir));

  if (source.type === 'local') return { type: 'local', path: bundleDir };
  return {
    ...source,
    subdir: source.subdir ? `${source.subdir}/${relative}` : relative,
  };
}

/**
 * Load every bundle a source contains. One directory holding a manifest yields
 * a single bundle; a collection of sibling bundle folders yields all of them.
 */
export async function loadBundlesFrom(
  source: BundleSource,
  options: { refresh?: boolean } = {},
): Promise<LoadedBundle[]> {
  const root = await resolveSource(source, options);
  const dirs = await discoverBundleDirs(root);

  if (dirs.length === 0) {
    throw new HcmError(
      `No bundle found in ${describeSource(source)}`,
      'Expected a manifest (hcm.yaml) there, or subdirectories that each contain one.',
    );
  }

  return Promise.all(dirs.map((dir) => loadBundle(dir, narrowSource(source, root, dir))));
}

/** Register a bundle, or every bundle in a collection. */
export async function addToRegistry(
  input: string,
  cwd: string,
  options: { name?: string; dev?: boolean } = {},
): Promise<RegistryEntry[]> {
  const source = parseSource(input, cwd);

  if (options.dev && source.type !== 'local') {
    throw new HcmError(
      '--dev only applies to bundles on this filesystem',
      `${describeSource(source)} has to be downloaded, so there is nothing to edit in place. ` +
        'Clone it and register the clone with --dev.',
    );
  }

  const bundles = await loadBundlesFrom(source, { refresh: true });

  if (options.name && bundles.length > 1) {
    throw new HcmError(
      `--name cannot be used with a collection (${bundles.length} bundles found)`,
      `Register one directly, e.g. "${input}/${path.basename(bundles[0]!.root)}".`,
    );
  }

  const registry = await readRegistry();
  const added: RegistryEntry[] = [];

  for (const bundle of bundles) {
    const name = options.name ?? bundle.manifest.name;
    const existing = registry.entries.find((candidate) => candidate.name === name);

    // Re-registering keeps the id, so anything you have written down still works.
    const id = existing?.id ?? nextRegistryId(registry.entries.map((entry) => entry.id));
    const entry: RegistryEntry = {
      id,
      name,
      source: bundle.source,
      version: bundle.manifest.version,
      ...(bundle.manifest.description ? { description: bundle.manifest.description } : {}),
      ...(bundle.manifest.tags ? { tags: bundle.manifest.tags } : {}),
      ...(bundle.dependencies.length > 0 ? { dependencies: bundle.dependencies } : {}),
      ...(bundle.flavors.length > 0 ? { flavors: summarizeFlavors(bundle.flavors) } : {}),
      ...(options.dev ? { dev: true } : { store: storeSlug({ id, name }) }),
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // A bundle that was on dev and is now snapshotted (or the reverse) must not
    // leave a stale copy behind claiming to be the registered one.
    if (existing?.store && existing.store !== entry.store) await removeFromStore(existing.store);
    if (entry.store) await populateStore(entry.store, bundle.source, { refresh: false });

    if (existing) registry.entries[registry.entries.indexOf(existing)] = entry;
    else registry.entries.push(entry);
    added.push(entry);
  }

  registry.entries.sort((a, b) => a.name.localeCompare(b.name));
  await writeRegistry(registry);
  return added;
}

/** Forget a bundle and delete its stored copy. Dev sources are left alone. */
export async function removeFromRegistry(
  reference: string,
): Promise<{ entry: RegistryEntry; storeRemoved: boolean } | undefined> {
  const registry = await readRegistry();
  const entry = matchEntry(registry.entries, reference);
  if (!entry) return undefined;

  registry.entries = registry.entries.filter((candidate) => candidate !== entry);
  await writeRegistry(registry);

  const storeRemoved = entry.store ? await removeFromStore(entry.store) : false;
  return { entry, storeRemoved };
}

/**
 * Re-read a registered bundle from its origin: re-download a GitHub ref, or
 * re-copy a local directory. Returns the entry as it now stands, with the
 * version it had before so callers can report the change.
 *
 * A dry run reads the origin -- there is no other way to know what the new
 * version even is -- but leaves the store and the registry as they were.
 */
export async function refreshEntry(
  entry: RegistryEntry,
  options: { dryRun?: boolean } = {},
): Promise<{ entry: RegistryEntry; bundle: LoadedBundle; previousVersion?: string }> {
  if (entry.dev) {
    const bundle = await loadBundle(await entryDir(entry), entry.source);
    return options.dryRun
      ? { entry, bundle, previousVersion: entry.version }
      : persistRefresh(entry, bundle);
  }

  if (options.dryRun) {
    const bundle = await loadBundle(await resolveSource(entry.source, { refresh: true }), entry.source);
    return { entry, bundle, previousVersion: entry.version };
  }

  const dir = await populateStore(entry.store ?? storeSlug(entry), entry.source, { refresh: true });
  return persistRefresh(entry, await loadBundle(dir, entry.source));
}

/** Write a refreshed bundle's metadata back to the registry entry. */
async function persistRefresh(
  entry: RegistryEntry,
  bundle: LoadedBundle,
): Promise<{ entry: RegistryEntry; bundle: LoadedBundle; previousVersion?: string }> {
  const registry = await readRegistry();
  const current = matchEntry(registry.entries, entry.id) ?? entry;
  const previousVersion = current.version;

  const updated: RegistryEntry = {
    ...current,
    version: bundle.manifest.version,
    ...(bundle.manifest.description ? { description: bundle.manifest.description } : {}),
    ...(bundle.manifest.tags ? { tags: bundle.manifest.tags } : {}),
    // Replaced wholesale, so a dependency dropped upstream disappears here too.
    ...(bundle.dependencies.length > 0 ? { dependencies: bundle.dependencies } : {}),
    ...(bundle.flavors.length > 0 ? { flavors: summarizeFlavors(bundle.flavors) } : {}),
    ...(entry.dev ? {} : { store: entry.store ?? storeSlug(entry) }),
    updatedAt: new Date().toISOString(),
  };

  // A bundle that has stopped requiring anything should stop saying it does,
  // and the same for a flavor dropped upstream.
  if (bundle.dependencies.length === 0) delete updated.dependencies;
  if (bundle.flavors.length === 0) delete updated.flavors;

  const index = registry.entries.indexOf(current);
  if (index >= 0) registry.entries[index] = updated;
  await writeRegistry(registry);

  return { entry: updated, bundle, previousVersion };
}

/**
 * The bundle references a command was given, as a list.
 *
 * The CLI hands every command an array now that `hcm install 1 2 3` is a thing,
 * but the commands are called directly too -- from `hcm import`, from `hcm
 * update`, from the tests -- and there one bundle is one string. Both mean the
 * same thing, so both are accepted rather than making every caller wrap.
 */
export function asList(references: string | string[]): string[] {
  return typeof references === 'string' ? [references] : references;
}

/**
 * Resolve a reference to every bundle it names. Accepts a registered name or
 * id, a local path, or a GitHub reference -- so `hcm install ./my-bundle` works
 * without registering first, and a path to a collection installs all of them.
 */
export async function resolveBundles(
  reference: string,
  cwd: string,
  options: { refresh?: boolean } = {},
): Promise<LoadedBundle[]> {
  const registry = await readRegistry();
  const entry = matchEntry(registry.entries, reference);
  if (entry) return [await loadBundle(await entryDir(entry, options), entry.source)];

  const source = parseSource(reference, cwd);
  try {
    return await loadBundlesFrom(source, options);
  } catch (error) {
    if (!(error instanceof HcmError)) throw error;

    // Keep the specific diagnostic -- "this bundle has an agents/ directory",
    // "this skill has no SKILL.md" -- and only supply a hint when the error
    // did not carry one of its own.
    const fallbackHint =
      registry.entries.length > 0
        ? `Registered bundles: ${registry.entries.map((candidate) => `${candidate.id} ${candidate.name}`).join(', ')}`
        : 'No bundles are registered yet. Try "hcm registry add <path-or-repo>".';

    throw new HcmError(error.message, error.hint ?? fallbackHint);
  }
}

/** Resolve a reference that must name exactly one bundle. */
export async function resolveBundle(
  reference: string,
  cwd: string,
  options: { refresh?: boolean } = {},
): Promise<LoadedBundle> {
  const bundles = await resolveBundles(reference, cwd, options);
  if (bundles.length > 1) {
    throw new HcmError(
      `"${reference}" contains ${bundles.length} bundles`,
      `Name one of: ${bundles.map((bundle) => bundle.manifest.name).join(', ')}`,
    );
  }
  return bundles[0] as LoadedBundle;
}

/**
 * The bundle name a user's reference points at, for commands that work off the
 * installation ledger rather than the bundle files. An id resolves through the
 * registry; anything else is taken at face value, since a bundle can be
 * installed without ever having been registered.
 */
export async function resolveInstalledName(reference: string): Promise<string> {
  const registry = await readRegistry();
  return matchEntry(registry.entries, reference)?.name ?? reference;
}
