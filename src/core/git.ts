/**
 * Fetching bundles from any git host, by the HTTPS clone URL.
 *
 * GitHub has its own source type, with a shorthand and an archive download --
 * see `github.ts`. Every other host is read here, with the git protocol itself:
 * Azure DevOps, Bitbucket, GitLab, a self-hosted server. `git-http.ts` holds
 * the protocol; this file holds the reference syntax and the cache.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { HcmError } from './errors.js';
import { fs, isDirectory, removeDir, writeBytes } from './fsx.js';
import { downloadGitTree } from './git-http.js';
import { cacheDir } from './paths.js';
import type { BundleSource } from './types.js';

export type GitSource = Extract<BundleSource, { type: 'git' }>;

/**
 * How a remote source is fetched.
 *
 * `fetched` lets one command download a repository once, however many bundles
 * it reads from that repository. The command makes the set, and each download
 * adds its cache directory to it. A refresh of a directory that is in the set
 * uses the copy that this command downloaded.
 */
export interface FetchOptions {
  /** Download again, and replace what is in the cache. */
  refresh?: boolean;
  fetched?: Set<string>;
}

/**
 * Parse the HTTPS clone URL of a git repository:
 *
 *   https://dev.azure.com/org/project/_git/repo        Azure DevOps
 *   https://org@dev.azure.com/org/project/_git/repo    ...as its clone box gives it
 *   https://bitbucket.org/workspace/repo.git           Bitbucket
 *   https://gitlab.com/group/subgroup/repo.git         GitLab
 *   https://git.example.com/team/repo.git              a self-hosted server
 *   git+https://github.com/owner/repo.git              GitHub, read with the git protocol
 *
 * A fragment selects the ref and the folder, written as git writes
 * `<rev>:<path>`:
 *
 *   <url>#v1.2.0                 a tag, a branch or a full commit id
 *   <url>#main:bundles/my-kit    a folder of that ref
 *   <url>#:bundles/my-kit        a folder of the default branch
 *
 * An Azure DevOps browser URL has the same data in its query string
 * (`?path=/bundles/my-kit&version=GBmain`), and that is read too.
 */
export function parseGitSource(input: string): GitSource | undefined {
  const trimmed = input.trim().replace(/^git\+/i, '');
  if (!/^https?:\/\//i.test(trimmed)) return undefined;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HcmError(`"${input}" is not a URL that hcm can read`);
  }

  if (url.password) {
    throw new HcmError(
      'The URL contains a password or a token',
      'Remove it from the URL, and set it in the HCM_GIT_TOKEN environment variable. ' +
        'hcm records the URL in its registry, and a token must not be there.',
    );
  }
  if (url.pathname.replace(/\/+/g, '') === '') {
    throw new HcmError(`"${input}" does not name a repository`);
  }

  const fragment = safeDecode(url.hash.slice(1));
  const colon = fragment.indexOf(':');
  let ref = colon >= 0 ? fragment.slice(0, colon) : fragment;
  let subdir = colon >= 0 ? fragment.slice(colon + 1) : '';

  if (url.pathname.includes('/_git/')) {
    // GB is a branch, GT a tag and GC a commit.
    const version = /^G[BTC](.+)$/.exec(url.searchParams.get('version') ?? '')?.[1];
    ref ||= version ?? '';
    subdir ||= url.searchParams.get('path') ?? '';
  }

  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');

  const folder = subdir.split(/[\\/]+/).filter(Boolean);
  if (folder.includes('..')) {
    throw new HcmError(`The folder "${subdir}" is outside the repository`);
  }

  return {
    type: 'git',
    url: url.href,
    ref: ref || 'HEAD',
    ...(folder.length > 0 ? { subdir: folder.join('/') } : {}),
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The text that `parseGitSource` reads back into this source.
 *
 * A github.com URL keeps the `git+` prefix. Without it, the URL reads as a
 * GitHub source, which is downloaded another way.
 */
export function gitReference(source: GitSource): string {
  const prefix = /^https?:\/\/(?:[^/@]+@)?(?:www\.)?github\.com\//i.test(source.url) ? 'git+' : '';
  const ref = source.ref === 'HEAD' ? '' : source.ref;
  const fragment = source.subdir ? `#${ref}:${source.subdir}` : ref ? `#${ref}` : '';
  return `${prefix}${source.url}${fragment}`;
}

export function describeGitSource(source: GitSource): string {
  return `${source.url}#${source.ref}${source.subdir ? `:${source.subdir}` : ''}`;
}

/**
 * A readable directory name with a hash of the exact URL and ref, so that two
 * repositories never share a directory. The readable part is kept short for
 * the path length limit of Windows.
 */
function cacheKey(source: GitSource): string {
  const url = new URL(source.url);
  const readable = `${url.hostname}${url.pathname}-${source.ref}`
    .replace(/\.git(?=-)/, '')
    .replace(/[^\w.-]+/g, '-')
    .slice(-60)
    .replace(/^-+/, '');
  const hash = createHash('sha256').update(`${source.url}#${source.ref}`).digest('hex').slice(0, 8);
  return `git-${readable}-${hash}`;
}

/**
 * Download one ref of a repository into the cache, and return the directory
 * that holds the bundle (honouring `subdir`).
 *
 * The cache holds all files of the ref, as it does for a GitHub archive. Thus
 * each bundle of a collection, and a sibling that a bundle depends on, come
 * from one download.
 */
export async function fetchGitBundle(
  source: GitSource,
  options: FetchOptions = {},
): Promise<string> {
  const root = path.join(await cacheDir(), cacheKey(source));
  const bundleDir = source.subdir ? path.join(root, ...source.subdir.split('/')) : root;

  const refresh = options.refresh && !options.fetched?.has(root);
  if (!refresh && (await isDirectory(bundleDir))) return bundleDir;

  // Downloaded in full before the old copy is removed, so a failed download
  // leaves the cache as it was.
  const { files } = await downloadGitTree({ url: source.url, ref: source.ref });

  await removeDir(root);
  await fs.mkdir(root, { recursive: true });

  for (const file of files) {
    const target = path.resolve(root, ...file.path.split('/'));
    if (!target.startsWith(root + path.sep)) {
      throw new HcmError(`The repository has a file name that hcm does not write: "${file.path}"`);
    }
    await writeBytes(target, file.data);
    if (file.executable) await fs.chmod(target, 0o755);
  }
  options.fetched?.add(root);

  if (!(await isDirectory(bundleDir))) {
    throw new HcmError(`Path "${source.subdir}" not found in ${source.url} at ${source.ref}`);
  }

  return bundleDir;
}
