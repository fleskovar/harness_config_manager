/**
 * The registry: a user-level list of bundles this machine knows about, so
 * `hcm install <name>` works without repeating the path or URL every time.
 */

import path from 'node:path';
import { loadBundle } from './bundle.js';
import { HcmError } from './errors.js';
import { readJsonIfExists, writeJson } from './fsx.js';
import { describeSource, parseGithubSource, resolveSource } from './github.js';
import { registryFile } from './paths.js';
import type { BundleSource, RegistryEntry, RegistryFile } from './types.js';

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

/** Register a bundle after verifying it loads and reading its metadata. */
export async function addToRegistry(
  input: string,
  cwd: string,
  options: { name?: string } = {},
): Promise<RegistryEntry> {
  const source = parseSource(input, cwd);
  const directory = await resolveSource(source, { refresh: true });
  const bundle = await loadBundle(directory, source);

  const entry: RegistryEntry = {
    name: options.name ?? bundle.manifest.name,
    source,
    version: bundle.manifest.version,
    ...(bundle.manifest.description ? { description: bundle.manifest.description } : {}),
    ...(bundle.manifest.tags ? { tags: bundle.manifest.tags } : {}),
  };

  const registry = await readRegistry();
  const index = registry.entries.findIndex((existing) => existing.name === entry.name);
  if (index >= 0) registry.entries[index] = entry;
  else registry.entries.push(entry);

  registry.entries.sort((a, b) => a.name.localeCompare(b.name));
  await writeRegistry(registry);
  return entry;
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
 * Resolve a bundle reference to a loaded bundle. Accepts a registered name, a
 * local path, or a GitHub shorthand -- so `hcm install ./my-bundle` works
 * without registering first.
 */
export async function resolveBundle(
  reference: string,
  cwd: string,
  options: { refresh?: boolean } = {},
): Promise<{ bundle: import('./types.js').LoadedBundle; entry?: RegistryEntry }> {
  const registry = await readRegistry();
  const entry = registry.entries.find((candidate) => candidate.name === reference);

  if (entry) {
    const directory = await resolveSource(entry.source, options);
    return { bundle: await loadBundle(directory, entry.source), entry };
  }

  const source = parseSource(reference, cwd);
  try {
    const directory = await resolveSource(source, options);
    return { bundle: await loadBundle(directory, source) };
  } catch (error) {
    if (registry.entries.length === 0) {
      throw new HcmError(
        `Bundle "${reference}" not found`,
        'No bundles are registered yet. Try "hcm registry add <path-or-repo>".',
      );
    }
    throw new HcmError(
      `Bundle "${reference}" not found (${describeSource(source)}): ${(error as Error).message}`,
      `Registered bundles: ${registry.entries.map((candidate) => candidate.name).join(', ')}`,
    );
  }
}
