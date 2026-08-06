/**
 * Fetching bundles from GitHub.
 *
 * We download the ref tarball rather than shelling out to git: no git
 * dependency, no credential prompts, and it works for a subdirectory of a
 * monorepo of bundles.
 */

import path from 'node:path';
import { x as extractTar } from 'tar';
import { HcmError } from './errors.js';
import { ensureDir, fs, isDirectory, pathExists } from './fsx.js';
import { cacheDir } from './paths.js';
import type { BundleSource } from './types.js';

/**
 * Parse the shorthands people actually type:
 *   owner/repo
 *   owner/repo#branch
 *   owner/repo/sub/dir#branch
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch/sub/dir
 */
export function parseGithubSource(input: string): BundleSource | undefined {
  const trimmed = input.trim();

  const urlMatch = /^https?:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/.exec(
    trimmed,
  );
  if (urlMatch) {
    const [, owner, repo, ref, subdir] = urlMatch;
    return {
      type: 'github',
      owner: owner as string,
      repo: repo as string,
      ref: ref ?? 'HEAD',
      ...(subdir ? { subdir } : {}),
    };
  }

  const shorthand = /^([\w.-]+)\/([\w.-]+)(?:\/([^#]+))?(?:#(.+))?$/.exec(trimmed);
  if (shorthand && !trimmed.startsWith('.') && !path.isAbsolute(trimmed)) {
    const [, owner, repo, subdir, ref] = shorthand;
    return {
      type: 'github',
      owner: owner as string,
      repo: repo as string,
      ref: ref ?? 'HEAD',
      ...(subdir ? { subdir } : {}),
    };
  }

  return undefined;
}

export function describeSource(source: BundleSource): string {
  if (source.type === 'local') return source.path;
  const subdir = source.subdir ? `/${source.subdir}` : '';
  return `github:${source.owner}/${source.repo}${subdir}#${source.ref}`;
}

function cacheKey(source: Extract<BundleSource, { type: 'github' }>): string {
  return `${source.owner}-${source.repo}-${source.ref}`.replace(/[^\w.-]/g, '_');
}

/**
 * Download and extract a GitHub ref into the cache, returning the directory
 * that holds the bundle (honouring `subdir`).
 */
export async function fetchGithubBundle(
  source: Extract<BundleSource, { type: 'github' }>,
  options: { refresh?: boolean } = {},
): Promise<string> {
  const root = path.join(cacheDir(), cacheKey(source));
  const bundleDir = source.subdir ? path.join(root, ...source.subdir.split('/')) : root;

  if (!options.refresh && (await isDirectory(bundleDir))) return bundleDir;

  if (await pathExists(root)) await fs.rm(root, { recursive: true, force: true });
  await ensureDir(root);

  const ref = source.ref === 'HEAD' ? await defaultBranch(source) : source.ref;
  const url = `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${encodeURIComponent(ref)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new HcmError(
      `Failed to download ${describeSource(source)} (HTTP ${response.status})`,
      'Check the repository name and ref, and that the repository is public.',
    );
  }

  const archive = path.join(root, 'bundle.tar.gz');
  await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));

  // GitHub tarballs nest everything under `<repo>-<ref>/`; strip that level.
  await extractTar({ file: archive, cwd: root, strip: 1 });
  await fs.rm(archive, { force: true });

  if (!(await isDirectory(bundleDir))) {
    throw new HcmError(
      `Path "${source.subdir}" not found in ${source.owner}/${source.repo}@${ref}`,
    );
  }

  return bundleDir;
}

async function defaultBranch(source: Extract<BundleSource, { type: 'github' }>): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${source.owner}/${source.repo}`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) return 'main';
  const data = (await response.json()) as { default_branch?: string };
  return data.default_branch ?? 'main';
}

/** Resolve any source to a local directory, downloading when needed. */
export async function resolveSource(
  source: BundleSource,
  options: { refresh?: boolean } = {},
): Promise<string> {
  if (source.type === 'local') {
    if (!(await isDirectory(source.path))) {
      throw new HcmError(`Bundle directory no longer exists: ${source.path}`);
    }
    return source.path;
  }
  return fetchGithubBundle(source, options);
}
