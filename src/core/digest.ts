/**
 * The digest of a bundle: one hash over the paths and contents of its files.
 *
 * An installation records the digest of the bundle that it came from. Then
 * `hcm update` can tell that a source holds the same bundle as before, and
 * skip the rollback and the reinstall. The version alone is not enough: a
 * branch can change its files and keep its version.
 *
 * The digest covers every file of the bundle folder, also the files that no
 * target installs, for example the README. A change there causes one
 * reinstall that changes nothing, which is cheaper than a missed update.
 */

import path from 'node:path';
import { fs, toPosix } from './fsx.js';
import { sha256 } from './hash.js';
import type { LoadedBundle } from './types.js';

/** The folders that are never part of a bundle. The store skips the same ones. */
const NOT_PART_OF_A_BUNDLE = new Set(['.git', 'node_modules', '.hcm']);

/** One bundle object is hashed once, also when it goes into several harnesses. */
const computed = new WeakMap<LoadedBundle, Promise<string>>();

/** The digest of a loaded bundle, from the files in its root folder. */
export function bundleDigest(bundle: LoadedBundle): Promise<string> {
  let digest = computed.get(bundle);
  if (!digest) {
    digest = directoryDigest(bundle.root);
    computed.set(bundle, digest);
  }
  return digest;
}

/**
 * `sha256:` and the hash of a sorted list of `<posix path> <sha256 of bytes>`
 * lines. Sorted, so the order in which the disk lists the files does not
 * change the result.
 */
export async function directoryDigest(root: string): Promise<string> {
  const files = await bundleFiles(root);
  const lines: string[] = [];
  for (const file of files) {
    const relative = toPosix(path.relative(root, file));
    lines.push(`${relative} ${sha256(await fs.readFile(file))}`);
  }
  return `sha256:${sha256(lines.sort().join('\n'))}`;
}

async function bundleFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!NOT_PART_OF_A_BUNDLE.has(entry.name)) await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}
