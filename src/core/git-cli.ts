/**
 * Downloading a repository with the `git` program, for SSH and git:// URLs.
 *
 * The HTTPS client in `git-http.ts` needs no `git` on the machine. SSH is a
 * different case: the keys, the agent and `~/.ssh/config` belong to the
 * user's own SSH setup, and only the `git` program uses them. So hcm runs
 * `git` for these URLs, and reads the same result as the HTTPS client gives:
 * the files of one commit, without the history.
 *
 * The work is done in a temporary bare repository:
 *
 *   git init --bare                       an empty repository, with no work tree
 *   git fetch --depth 1 <url> <ref>       one commit, written to FETCH_HEAD
 *   git ls-tree -r -z FETCH_HEAD          the files of that commit
 *   git cat-file --batch                  their contents
 *
 * A bare repository has no checkout, so `core.autocrlf` and the other
 * work-tree settings do not change the bytes. The files are the blobs as they
 * are in the repository, as the HTTPS client gives them.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { HcmError } from './errors.js';
import { fs } from './fsx.js';
import type { GitDownload, GitFile } from './git-http.js';

/** The output of one `git` process. */
export interface GitRunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * Runs one `git` command. A test can give its own runner, so that the tests
 * do not need SSH.
 */
export type GitRunner = (args: string[], options?: { input?: Buffer }) => Promise<GitRunResult>;

const MODE_SYMLINK = '120000';
const MODE_SUBMODULE = '160000';

const NO_GIT_HINT =
  'Install git, and make sure that the "git" command is on the PATH. ' +
  'Or use the HTTPS clone URL of the repository, with a token in HCM_GIT_TOKEN.';

/** The default runner: the `git` program on the PATH. */
export const runGit: GitRunner = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      // The terminal stays with the user, so SSH can ask for a key passphrase.
      // Git itself must not ask for a user name: there is nobody to answer.
      stdio: [options.input ? 'pipe' : 'inherit', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new HcmError('An SSH or git:// URL needs the git program, which is not installed', NO_GIT_HINT));
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
      });
    });

    if (options.input) child.stdin?.end(options.input);
  });

/**
 * Download the files of one ref of a repository with the `git` program.
 *
 * `url` is any URL that `git fetch` accepts. `ref` is a branch, a tag, a full
 * commit id, or `HEAD` for the default branch.
 */
export async function downloadWithGit(
  options: { url: string; ref: string },
  run: GitRunner = runGit,
): Promise<GitDownload> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-git-'));

  try {
    const git = async (args: string[], input?: Buffer): Promise<Buffer> => {
      const result = await run(['-C', temporary, ...args], input ? { input } : {});
      if (result.code !== 0) throw fetchFailure(options, result.stderr);
      return result.stdout;
    };

    await git(['init', '--bare', '--quiet']);
    await git(['fetch', '--depth', '1', '--no-tags', '--quiet', options.url, options.ref]);

    const commit = (await git(['rev-parse', 'FETCH_HEAD'])).toString('utf8').trim();
    const entries = parseLsTree(await git(['ls-tree', '-r', '-z', '--full-tree', commit]));
    if (entries.length === 0) return { commit, files: [] };

    const contents = parseCatFileBatch(
      await git(['cat-file', '--batch'], Buffer.from(entries.map((entry) => `${entry.id}\n`).join(''))),
    );

    const files: GitFile[] = entries.map((entry) => {
      const data = contents.get(entry.id);
      if (!data) throw new HcmError(`git did not return the contents of "${entry.path}"`);
      return { path: entry.path, data, executable: entry.mode === '100755' };
    });

    return { commit, files };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function fetchFailure(options: { url: string; ref: string }, stderr: string): HcmError {
  const detail = stderr.replace(/^fatal:\s*/gim, '').split(/\r?\n/).filter(Boolean).join(' ');
  return new HcmError(
    `git could not read ${options.url} at ${options.ref}${detail ? `: ${detail}` : ''}`,
    'Check the URL and the ref. For SSH, make sure that "git ls-remote <url>" works in this terminal.',
  );
}

interface TreeEntry {
  mode: string;
  id: string;
  path: string;
}

/**
 * Read `git ls-tree -r -z`. Each entry is `<mode> <type> <id>\t<path>\0`.
 *
 * Symbolic links and submodules are left out, for the same reasons as in
 * `git-http.ts`. A path that could leave the target directory is refused.
 */
export function parseLsTree(output: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];

  for (const record of output.toString('utf8').split('\0')) {
    if (!record) continue;
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(record);
    if (!match) throw new HcmError(`git returned a tree entry that hcm cannot read: "${record}"`);

    const [, mode, type, id, entryPath] = match as unknown as [string, string, string, string, string];
    if (type !== 'blob' || mode === MODE_SYMLINK || mode === MODE_SUBMODULE) continue;

    const parts = entryPath.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..' || /[\\\0]/.test(part))) {
      throw new HcmError(`The repository has a file name that hcm does not write: "${entryPath}"`);
    }
    if (parts.some((part) => part.toLowerCase() === '.git')) continue;

    entries.push({ mode, id, path: entryPath });
  }

  return entries;
}

/**
 * Read `git cat-file --batch`. Each object is `<id> <type> <size>\n`, then the
 * bytes, then a newline. A missing object is `<id> missing\n`.
 */
export function parseCatFileBatch(output: Buffer): Map<string, Buffer> {
  const objects = new Map<string, Buffer>();
  let position = 0;

  while (position < output.length) {
    const newline = output.indexOf(0x0a, position);
    if (newline < 0) break;
    const header = output.toString('utf8', position, newline);
    position = newline + 1;

    const match = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
    if (!match) continue;

    const size = Number(match[3]);
    objects.set(match[1] as string, output.subarray(position, position + size));
    position += size + 1;
  }

  return objects;
}
