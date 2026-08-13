/**
 * Helpers for the fixture-driven tests.
 *
 * These tests differ from the rest of the suite in one deliberate way: the
 * bundles they install are real directories checked in under `tests/fixtures`,
 * not strings built inside the test. You can open them, read them, work out by
 * hand what `hcm` ought to do with them, and compare that against what the test
 * asserts. `tests/fixtures/README.md` is the guide to doing exactly that.
 *
 * Everything here is about getting a fixture into a scratch directory and then
 * reading the result back in a form that is easy to compare by eye.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the checked-in fixture tree. */
export const FIXTURES_ROOT = path.resolve(here, '..', 'fixtures');

/** `fixturePath('bundles/review-kit')` -> the directory on disk. */
export function fixturePath(relative: string): string {
  return path.join(FIXTURES_ROOT, ...relative.split('/'));
}

/**
 * Copy a fixture into `destination` and return it.
 *
 * Always a copy: `hcm refs fix` rewrites the files it is pointed at, and an
 * asset a test can damage is an asset nobody can trust.
 */
export async function copyFixture(relative: string, destination: string): Promise<string> {
  await copyDirectory(fixturePath(relative), destination);
  return destination;
}

/**
 * Copy any directory, not just one under `tests/fixtures`.
 *
 * The per-target tests keep their bundle beside themselves, in
 * `tests/target-<harness>/input`, so they address it by path rather than by
 * fixture name.
 */
export async function copyDirectory(from: string, to: string): Promise<string> {
  await copyDir(from, to);
  return to;
}

async function copyDir(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(source, target);
    else await fs.copyFile(source, target);
  }
}

/** A fresh scratch directory, removed by `cleanup`. */
export async function makeWorkspace(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `hcm-${prefix}-`));
}

// ---------------------------------------------------------------------------
// Reading results back
// ---------------------------------------------------------------------------

/** Read a file under `root`, addressed with POSIX separators. */
export async function readText(root: string, relative: string): Promise<string> {
  return fs.readFile(path.join(root, ...relative.split('/')), 'utf8');
}

export async function readJson<T = Record<string, unknown>>(
  root: string,
  relative: string,
): Promise<T> {
  return JSON.parse(await readText(root, relative)) as T;
}

export async function exists(root: string, relative: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, ...relative.split('/')));
    return true;
  } catch {
    return false;
  }
}

/**
 * Every file under `root` as a sorted list of POSIX paths.
 *
 * This is what makes an install assertion readable: the expected value is the
 * list of files you would get from `find .` after running the same command by
 * hand. `.hcm/` is left out -- it is hcm's own bookkeeping, not a harness file,
 * and it has its own assertions where it matters.
 */
export async function listTree(root: string, options: { includeState?: boolean } = {}): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.hcm' && !options.includeState) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }

  await walk(root);
  return found.sort();
}

/**
 * Every file under `root` as POSIX path -> text.
 *
 * This is `listTree` with the contents attached, which is what a whole-tree
 * comparison needs: one `expect(actual).toEqual(expected)` covers the file list
 * and every byte inside it, and the diff on failure names the file and the line.
 *
 * Line endings are normalised on both sides. `hcm` writes `\n`, but a checkout
 * with `core.autocrlf=true` hands the expected tree back as `\r\n` -- and that
 * is git's business, not something a target adapter should be judged on.
 */
export async function readTree(
  root: string,
  options: { includeState?: boolean } = {},
): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  for (const relative of await listTree(root, options)) {
    tree[relative] = (await readText(root, relative)).replace(/\r\n/g, '\n');
  }
  return tree;
}
