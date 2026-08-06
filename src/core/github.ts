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
 * Parse every form of GitHub reference someone might reasonably paste:
 *
 *   owner/repo                                        shorthand
 *   owner/repo#branch                                 shorthand with ref
 *   owner/repo/sub/dir#branch                         shorthand with subdirectory
 *   https://github.com/owner/repo                     browser address bar
 *   https://github.com/owner/repo?tab=readme-ov-file  ...with GitHub's query string
 *   https://github.com/owner/repo/tree/main/sub/dir   browser, viewing a directory
 *   https://github.com/owner/repo/blob/main/sub/hcm.yaml   browser, viewing a file
 *   https://github.com/owner/repo.git                 HTTPS clone URL
 *   git@github.com:owner/repo.git                     SSH clone URL
 *   ssh://git@github.com/owner/repo.git               SSH clone URL, protocol form
 */
export function parseGithubSource(input: string): BundleSource | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  // SSH clone URLs, in both the scp-like and protocol forms.
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (ssh) {
    return { type: 'github', owner: ssh[1] as string, repo: ssh[2] as string, ref: 'HEAD' };
  }

  // Web and HTTPS clone URLs, with or without www.
  const url = /^(?:https?|git):\/\/(?:www\.)?github\.com\/(.+)$/i.exec(trimmed);
  if (url) return parseGithubUrlPath(url[1] as string);

  // Bare shorthand. Excluded when it looks like a filesystem path.
  const shorthand = /^([\w.-]+)\/([\w.-]+)(?:\/([^#]+))?(?:#(.+))?$/.exec(trimmed);
  if (shorthand && !trimmed.startsWith('.') && !path.isAbsolute(trimmed)) {
    const [, owner, repo, subdir, ref] = shorthand;
    return {
      type: 'github',
      owner: owner as string,
      repo: repo as string,
      ref: ref ?? 'HEAD',
      ...(subdir ? { subdir: trimSlashes(subdir) } : {}),
    };
  }

  return undefined;
}

/**
 * Fragments GitHub's own UI appends. Treating these as a git ref would send us
 * looking for a branch called "readme", so they are ignored -- but any other
 * fragment is honoured as a ref, so `.../repo#v1.2.0` works as you'd expect.
 */
const UI_FRAGMENTS = new Set(['readme', 'readme-ov-file']);

/** Parse the path portion of a github.com URL (everything after the host). */
function parseGithubUrlPath(rest: string): BundleSource | undefined {
  // Strip the query string, then split off the fragment.
  const hashIndex = rest.indexOf('#');
  const fragment = hashIndex >= 0 ? rest.slice(hashIndex + 1) : '';
  const withoutFragment = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
  const pathname = (withoutFragment.split('?')[0] ?? '').replace(/\/+$/, '');

  const segments = pathname.split('/').filter(Boolean);
  const owner = segments[0];
  const repo = segments[1]?.replace(/\.git$/, '');
  if (!owner || !repo) return undefined;

  // A fragment is a ref only when the URL did not already name one, and only
  // when it is not one of GitHub's own UI anchors (#readme, #L42).
  const fragmentRef =
    fragment && !UI_FRAGMENTS.has(fragment.toLowerCase()) && !/^L\d+(?:-L\d+)?$/.test(fragment)
      ? fragment
      : undefined;

  const kind = segments[2];
  if (kind === 'tree' || kind === 'blob') {
    const ref = segments[3];
    if (!ref) return { type: 'github', owner, repo, ref: fragmentRef ?? 'HEAD' };

    // GitHub uses /blob/ only for files and /tree/ for directories, so a blob
    // URL's last segment is always a filename -- drop it to get the bundle
    // directory. This holds for extensionless files such as README or LICENSE.
    const parts = kind === 'blob' ? segments.slice(4, -1) : segments.slice(4);

    return {
      type: 'github',
      owner,
      repo,
      ref,
      ...(parts.length ? { subdir: parts.join('/') } : {}),
    };
  }

  // Any other trailing path (/issues, /pulls, /releases) refers to the repo as
  // a whole as far as we are concerned.
  return { type: 'github', owner, repo, ref: fragmentRef ?? 'HEAD' };
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
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
  const root = path.join(await cacheDir(), cacheKey(source));
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
