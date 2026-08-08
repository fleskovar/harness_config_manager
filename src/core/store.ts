/**
 * The bundle store: one directory per registry entry, holding the bundle's
 * files. Registering copies a bundle in; `hcm update` refreshes the copy;
 * `hcm registry remove` deletes it.
 *
 * The point is that a registered bundle is a *snapshot*. Installing twice a
 * month apart installs the same thing both times, whether the origin was a
 * GitHub ref that has since moved or a working directory you have been editing.
 * `hcm registry add --dev` opts out: those entries are referenced in place, so
 * edit-then-reinstall picks up changes with nothing to refresh.
 */

import path from 'node:path';
import { copyDir, isDirectory, removeDir } from './fsx.js';
import { resolveSource } from './github.js';
import { storeDir } from './paths.js';
import type { BundleSource, RegistryEntry } from './types.js';

/** Directories that are never part of a bundle, however it was authored. */
const NOT_PART_OF_A_BUNDLE = ['.git', 'node_modules', '.hcm'];

/**
 * The store directory name for an entry: id first so the folders sort the way
 * `hcm registry list` prints them, and the name so the folder is recognisable.
 */
export function storeSlug(entry: Pick<RegistryEntry, 'id' | 'name'>): string {
  const safeName = entry.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${entry.id}-${safeName || 'bundle'}`;
}

/** Absolute path of one entry's directory in the store. */
export async function storeEntryDir(slug: string): Promise<string> {
  return path.join(await storeDir(), slug);
}

/**
 * Copy a bundle into the store, replacing whatever was there. `from` is a
 * directory that already holds the bundle -- a working copy for a local source,
 * or a freshly downloaded tarball for a GitHub one.
 */
export async function saveToStore(slug: string, from: string): Promise<string> {
  const destination = await storeEntryDir(slug);
  // Replace rather than merge: a file deleted upstream must disappear here too.
  await removeDir(destination);
  await copyDir(from, destination, NOT_PART_OF_A_BUNDLE);
  return destination;
}

/** Fetch a source and snapshot it into the store, returning the stored path. */
export async function populateStore(
  slug: string,
  source: BundleSource,
  options: { refresh?: boolean } = {},
): Promise<string> {
  const origin = await resolveSource(source, options);
  return saveToStore(slug, origin);
}

export async function removeFromStore(slug: string): Promise<boolean> {
  const target = await storeEntryDir(slug);
  if (!(await isDirectory(target))) return false;
  await removeDir(target);
  return true;
}
