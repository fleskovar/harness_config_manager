/**
 * The registry: a user-level list of bundles this machine knows about, so
 * `hcm install <name>` works without repeating the path or URL every time.
 */

import path from 'node:path';
import { discoverBundleDirs, loadBundle } from './bundle.js';
import { HcmError } from './errors.js';
import { readJsonIfExists, toPosix, writeJson } from './fsx.js';
import { describeSource, parseGithubSource, resolveSource } from './github.js';
import { registryFile } from './paths.js';
import type { BundleSource, LoadedBundle, RegistryEntry, RegistryFile } from './types.js';

export async function readRegistry(): Promise<RegistryFile> {
  const registry = await readJsonIfExists<RegistryFile>(registryFile());
  if (!registry || !Array.isArray(registry.entries)) return { version: 1, entries: [] };
  return registry;
}

export async function writeRegistry(registry: RegistryFile): Promise<void> {
  await writeJson(registryFile(), registry);
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
  options: { name?: string } = {},
): Promise<RegistryEntry[]> {
  const source = parseSource(input, cwd);
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
    const entry: RegistryEntry = {
      name: options.name ?? bundle.manifest.name,
      source: bundle.source,
      version: bundle.manifest.version,
      ...(bundle.manifest.description ? { description: bundle.manifest.description } : {}),
      ...(bundle.manifest.tags ? { tags: bundle.manifest.tags } : {}),
    };

    const index = registry.entries.findIndex((existing) => existing.name === entry.name);
    if (index >= 0) registry.entries[index] = entry;
    else registry.entries.push(entry);
    added.push(entry);
  }

  registry.entries.sort((a, b) => a.name.localeCompare(b.name));
  await writeRegistry(registry);
  return added;
}

export async function removeFromRegistry(name: string): Promise<boolean> {
  const registry = await readRegistry();
  const before = registry.entries.length;
  registry.entries = registry.entries.filter((entry) => entry.name !== name);
  if (registry.entries.length === before) return false;
  await writeRegistry(registry);
  return true;
}

/**
 * Resolve a reference to every bundle it names. Accepts a registered name, a
 * local path, or a GitHub reference -- so `hcm install ./my-bundle` works
 * without registering first, and a path to a collection installs all of them.
 */
export async function resolveBundles(
  reference: string,
  cwd: string,
  options: { refresh?: boolean } = {},
): Promise<LoadedBundle[]> {
  const registry = await readRegistry();
  const entry = registry.entries.find((candidate) => candidate.name === reference);
  if (entry) return [await loadBundle(await resolveSource(entry.source, options), entry.source)];

  const source = parseSource(reference, cwd);
  try {
    return await loadBundlesFrom(source, options);
  } catch (error) {
    if (error instanceof HcmError && registry.entries.length > 0) {
      throw new HcmError(
        `${error.message}`,
        `Registered bundles: ${registry.entries.map((candidate) => candidate.name).join(', ')}`,
      );
    }
    if (registry.entries.length === 0) {
      throw new HcmError(
        `Bundle "${reference}" not found`,
        'No bundles are registered yet. Try "hcm registry add <path-or-repo>".',
      );
    }
    throw error;
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
