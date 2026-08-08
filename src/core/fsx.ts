import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Convert any path to POSIX separators, which is what receipts and manifests store. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Resolve a scope-relative POSIX path against an absolute root. */
export function fromPosix(root: string, relative: string): string {
  return path.resolve(root, ...relative.split('/'));
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function readTextIfExists(target: string): Promise<string | undefined> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Raw bytes, for content that would not survive a round trip through UTF-8. */
export async function readBytesIfExists(target: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function readJsonIfExists<T>(target: string): Promise<T | undefined> {
  const text = await readTextIfExists(target);
  if (text === undefined) return undefined;
  if (text.trim() === '') return undefined;
  return JSON.parse(text) as T;
}

/**
 * Create a directory tree, returning the directories that did not previously
 * exist (deepest last). Uninstall uses this to prune only what it created.
 */
export async function ensureDir(target: string): Promise<string[]> {
  const created: string[] = [];
  const segments: string[] = [];
  let current = path.resolve(target);
  while (!(await pathExists(current))) {
    segments.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const dir of segments.reverse()) {
    await fs.mkdir(dir, { recursive: true });
    created.push(dir);
  }
  return created;
}

export async function writeText(target: string, contents: string): Promise<string[]> {
  const created = await ensureDir(path.dirname(target));
  await fs.writeFile(target, contents, 'utf8');
  return created;
}

export async function writeBytes(target: string, contents: Buffer): Promise<string[]> {
  const created = await ensureDir(path.dirname(target));
  await fs.writeFile(target, contents);
  return created;
}

export async function writeJson(target: string, value: unknown): Promise<string[]> {
  return writeText(target, `${JSON.stringify(value, null, 2)}\n`);
}

export async function removeFile(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Remove a directory only when it is empty. Returns true when removed. */
export async function removeDirIfEmpty(target: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(target);
    if (entries.length > 0) return false;
    await fs.rmdir(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk upward from `target`, removing empty directories, stopping at `stopAt`
 * (exclusive) or at the first non-empty directory.
 */
export async function pruneEmptyDirs(target: string, stopAt: string): Promise<void> {
  let current = path.resolve(target);
  const boundary = path.resolve(stopAt);
  while (current.startsWith(boundary) && current !== boundary) {
    if (!(await removeDirIfEmpty(current))) return;
    current = path.dirname(current);
  }
}

/** Recursively list files under a directory, returning absolute paths. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await walk(root);
  return out.sort();
}

/** Copy a file, creating parent directories as needed. */
export async function copyFile(from: string, to: string): Promise<string[]> {
  const created = await ensureDir(path.dirname(to));
  await fs.copyFile(from, to);
  return created;
}

/**
 * Recursively copy a directory. `skip` names directories to leave behind --
 * a bundle's own `.git` or `node_modules` are not part of the bundle.
 * Symlinks are copied as links rather than followed, so a cycle cannot hang us.
 */
export async function copyDir(from: string, to: string, skip: string[] = []): Promise<void> {
  const skipped = new Set(skip);
  await fs.mkdir(to, { recursive: true });

  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);

    if (entry.isDirectory()) await copyDir(source, destination, skip);
    else if (entry.isSymbolicLink()) await fs.symlink(await fs.readlink(source), destination);
    else if (entry.isFile()) await fs.copyFile(source, destination);
  }
}

/** Remove a directory and everything under it. Missing is not an error. */
export async function removeDir(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

export { fs };
