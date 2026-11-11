/**
 * The requirements file: the bundles that a project uses, one per line.
 *
 * The file is part of the project and goes into version control with it. Then
 * anyone who has hcm installs the same bundles with one command:
 *
 *   hcm install -r                  # reads hcm-requirements.txt
 *   hcm install -r tools/agents.txt
 *
 * The syntax follows the direct references of pip's requirements.txt:
 *
 *   # name @ source [options]
 *   review-kit @ https://github.com/acme/agent-kits.git@v2.0.0
 *   db-kit     @ https://dev.azure.com/acme/platform/_git/kits@main
 *   py-kit     @ git+ssh://git@github.com:acme/agent-kits.git@main --flavor python
 *   docs-kit   @ ./agents/docs-kit
 *   team-kit                        # no source: the bundle registered on this machine
 *
 * The name selects one bundle. A repository can hold many bundles, and the
 * file installs only the ones that it names. hcm finds the bundle by the name
 * in its manifest, so the file does not need to give its folder.
 *
 * The source is one of:
 *
 *   https://host/path[@ref]          the HTTPS clone URL of any git host
 *   git+https://host/path[@ref]      the same, always with the git protocol
 *   git+ssh://user@host/path[@ref]   SSH, read with the git program
 *   user@host:path[@ref]             SSH, in the scp-like form
 *   ./path, ../path, /path           a folder, from the folder of this file
 *   file:///path                     a folder, as a URL
 *
 * The ref is a branch, a tag or a full commit id; without one, the default
 * branch. `#subdirectory=<path>` limits the search to one folder of the
 * repository, as in pip.
 *
 * The options of a line are `--flavor`, `--target` and `--param`. They apply
 * to that bundle only, and replace the same options of the command line.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverBundleDirs, findNestedBundleDirs, loadManifest } from './bundle.js';
import { HcmError } from './errors.js';
import { toPosix } from './fsx.js';
import { type FetchOptions, parseGitSource, toSshUrl } from './git.js';
import { parseGithubSource, resolveSource, sourceReference } from './github.js';
import type { BundleSource } from './types.js';

export const DEFAULT_REQUIREMENTS_FILE = 'hcm-requirements.txt';

/** One line of a requirements file. */
export interface Requirement {
  /** 1-based, for the messages. */
  line: number;
  /** The name of the bundle, as in its manifest. */
  name: string;
  /**
   * Where the bundle is. A repository or a folder that can hold more bundles
   * than this one. Absent: the registry of this machine.
   */
  source?: BundleSource;
  flavors?: string[];
  targets?: string[];
  /** `--param` assignments, as written on the line. */
  params?: string[];
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Read a requirements file. `baseDir` is the folder of the file: a relative
 * path in the file starts there, not in the working directory.
 *
 * Every error names its line. All lines are read before an error is thrown, so
 * that one run reports all of the mistakes.
 */
export function parseRequirements(contents: string, baseDir: string): Requirement[] {
  const requirements: Requirement[] = [];
  const problems: string[] = [];
  const seen = new Map<string, number>();

  contents.split(/\r?\n/).forEach((text, index) => {
    const line = index + 1;
    try {
      const requirement = parseRequirementLine(text, baseDir);
      if (!requirement) return;

      const earlier = seen.get(requirement.name.toLowerCase());
      if (earlier !== undefined) {
        throw new HcmError(`"${requirement.name}" is also on line ${earlier}`);
      }
      seen.set(requirement.name.toLowerCase(), line);
      requirements.push({ line, ...requirement });
    } catch (error) {
      if (!(error instanceof HcmError)) throw error;
      problems.push(`line ${line}: ${error.message}`);
    }
  });

  if (problems.length > 0) {
    throw new HcmError(
      `The requirements file has ${problems.length} error(s):\n  ${problems.join('\n  ')}`,
      'Write each line as "<bundle> @ <url>[@ref] [--flavor ...]", or as "<bundle>" alone.',
    );
  }
  return requirements;
}

/** One line, or nothing for a blank line or a comment. */
export function parseRequirementLine(
  text: string,
  baseDir: string,
): Omit<Requirement, 'line'> | undefined {
  const tokens = tokenize(text);
  if (tokens.length === 0) return undefined;

  const [first, ...rest] = tokens as [string, ...string[]];
  let name = first;
  let spec: string | undefined;
  let options = rest;

  if (rest[0] === '@') {
    // name @ source
    spec = rest[1];
    if (spec === undefined || spec.startsWith('-')) {
      throw new HcmError(`"${name} @" gives no source after the "@"`);
    }
    options = rest.slice(2);
  } else if (first.endsWith('@')) {
    // name@ source
    name = first.slice(0, -1);
    spec = rest[0];
    if (spec === undefined || spec.startsWith('-')) {
      throw new HcmError(`"${first}" gives no source after the "@"`);
    }
    options = rest.slice(1);
  } else if (rest[0]?.startsWith('@')) {
    // name @source
    spec = rest[0].slice(1);
    options = rest.slice(1);
  } else if (first.includes('@')) {
    // name@source, with no spaces
    const at = first.indexOf('@');
    name = first.slice(0, at);
    spec = first.slice(at + 1);
  }

  if (!NAME_PATTERN.test(name)) {
    throw new HcmError(
      `"${name}" is not a bundle name`,
      'A bundle name has letters, digits, dots, dashes and underscores.',
    );
  }

  return {
    name,
    ...(spec !== undefined ? { source: parseRequirementSource(spec, baseDir) } : {}),
    ...parseLineOptions(options),
  };
}

/**
 * Split a line into words, as a shell does: spaces separate the words, and
 * quotes keep spaces in a word. A `#` at the start of a word starts a comment,
 * so `url#subdirectory=x` is one word and ` # note` is a comment.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inWord = false;
  let quote: '"' | "'" | undefined;

  for (const char of text) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inWord) tokens.push(current);
      current = '';
      inWord = false;
      continue;
    }
    if (char === '#' && !inWord) break;
    current += char;
    inWord = true;
  }

  if (quote) throw new HcmError(`A ${quote} quote is not closed`);
  if (inWord) tokens.push(current);
  return tokens;
}

function parseLineOptions(tokens: string[]): Pick<Requirement, 'flavors' | 'targets' | 'params'> {
  const flavors: string[] = [];
  const targets: string[] = [];
  const params: string[] = [];
  let list: string[] | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    const [flag, inline] = token.startsWith('--') && token.includes('=')
      ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
      : [token, undefined];

    if (flag === '-f' || flag === '--flavor' || flag === '-t' || flag === '--target') {
      list = flag === '-f' || flag === '--flavor' ? flavors : targets;
      if (inline !== undefined) list.push(...inline.split(',').filter(Boolean));
      continue;
    }
    if (flag === '--param') {
      list = undefined;
      const value = inline ?? tokens[(index += 1)];
      if (value === undefined || !value.includes('=')) {
        throw new HcmError('"--param" needs a value, as NAME=value');
      }
      params.push(value);
      continue;
    }
    if (token.startsWith('-')) {
      throw new HcmError(
        `"${token}" is not an option of a requirements line`,
        'A line takes --flavor, --target and --param.',
      );
    }
    if (!list) throw new HcmError(`"${token}" is not an option, and follows no option`);
    list.push(token);
  }

  return {
    ...(flavors.length > 0 ? { flavors } : {}),
    ...(targets.length > 0 ? { targets } : {}),
    ...(params.length > 0 ? { params } : {}),
  };
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/**
 * Read the source of a line: a URL with an optional `@ref`, or a folder.
 *
 * The ref is after the last `@` of the path, as in pip. An `@` before the
 * host is the user name, as in `https://org@dev.azure.com/...` or
 * `git@github.com:...`, and is not a ref.
 */
export function parseRequirementSource(spec: string, baseDir: string): BundleSource {
  const { location, subdirectory } = splitFragment(spec);

  if (/^file:\/\//i.test(location)) {
    return withSubdir({ type: 'local', path: fileURLToPath(location) }, subdirectory);
  }
  if (isPath(location)) {
    return withSubdir({ type: 'local', path: path.resolve(baseDir, location) }, subdirectory);
  }

  const gitPlus = /^git\+/i.test(location);
  const url = toSshUrl(location.replace(/^git\+/i, ''));
  if (!/^(?:https?|ssh|git):\/\//i.test(url)) {
    throw new HcmError(
      `"${spec}" is not a URL or a folder`,
      'Give the clone URL of a repository (HTTPS or SSH), or a folder that starts with "./".',
    );
  }

  const { repository, ref } = splitRef(url, spec);
  const github = !gitPlus && /^https?:/i.test(repository) ? parseGithubSource(repository) : undefined;
  const source = github ?? parseGitSource(repository);
  if (!source || source.type === 'local') throw new HcmError(`"${spec}" is not a URL that hcm can read`);

  return withSubdir(ref ? { ...source, ref } : source, subdirectory);
}

/** pip's `#subdirectory=<path>`. Any other fragment is an error. */
function splitFragment(spec: string): { location: string; subdirectory?: string } {
  const hash = spec.indexOf('#');
  if (hash < 0) return { location: spec };

  const fragment = new URLSearchParams(spec.slice(hash + 1));
  const unknown = [...fragment.keys()].filter((key) => key !== 'subdirectory');
  if (unknown.length > 0) {
    throw new HcmError(
      `"#${spec.slice(hash + 1)}" is not a fragment that hcm reads`,
      'Give the ref after an "@" at the end of the URL, and a folder as "#subdirectory=<path>".',
    );
  }
  const subdirectory = fragment.get('subdirectory') ?? '';
  return { location: spec.slice(0, hash), ...(subdirectory ? { subdirectory } : {}) };
}

function splitRef(url: string, spec: string): { repository: string; ref?: string } {
  const pathStart = url.indexOf('/', url.indexOf('://') + 3);
  if (pathStart < 0) throw new HcmError(`"${spec}" does not name a repository`);

  const query = url.indexOf('?', pathStart);
  const pathEnd = query < 0 ? url.length : query;
  const at = url.lastIndexOf('@', pathEnd - 1);
  if (at < pathStart) return { repository: url };

  const ref = url.slice(at + 1, pathEnd);
  if (!ref) throw new HcmError(`"${spec}" has an "@" with no ref after it`);
  return { repository: url.slice(0, at) + url.slice(pathEnd), ref };
}

function isPath(location: string): boolean {
  return (
    location.startsWith('.') ||
    location.startsWith('/') ||
    location.startsWith('\\') ||
    location.startsWith('~') ||
    /^[a-z]:[\\/]/i.test(location)
  );
}

function withSubdir(source: BundleSource, subdirectory: string | undefined): BundleSource {
  if (!subdirectory) return source;
  const parts = subdirectory.split(/[\\/]+/).filter(Boolean);
  if (parts.includes('..')) {
    throw new HcmError(`The folder "${subdirectory}" is outside the repository`);
  }
  if (source.type === 'local') return { type: 'local', path: path.join(source.path, ...parts) };
  return { ...source, subdir: [source.subdir, ...parts].filter(Boolean).join('/') };
}

// ---------------------------------------------------------------------------
// Finding the bundle
// ---------------------------------------------------------------------------

/**
 * The source of the one bundle that a line names.
 *
 * The source of the line can hold many bundles: a collection, or a repository
 * that keeps them in deeper folders. The bundle is the one whose manifest has
 * the name of the line. The result points at its folder, so the installation
 * records exactly where the bundle came from.
 */
export async function locateRequirement(
  requirement: Requirement & { source: BundleSource },
  options: FetchOptions = {},
): Promise<BundleSource> {
  const { source } = requirement;
  const root = await resolveSource(source, options);

  const dirs = [...new Set([...(await discoverBundleDirs(root)), ...(await findNestedBundleDirs(root))])];
  const found: { dir: string; name: string }[] = [];
  for (const dir of dirs) {
    try {
      found.push({ dir, name: (await loadManifest(dir)).name });
    } catch {
      // A broken manifest of another bundle is not this line's problem.
    }
  }

  const matches = found.filter((bundle) => bundle.name === requirement.name);
  const where = sourceReference(source);

  if (matches.length === 0) {
    const names = [...new Set(found.map((bundle) => bundle.name))].sort();
    throw new HcmError(
      `There is no bundle "${requirement.name}" in ${where}`,
      names.length > 0
        ? `Bundles there: ${names.join(', ')}`
        : 'There is no bundle manifest (hcm.yaml) there.',
    );
  }
  if (matches.length > 1) {
    const folders = matches.map((bundle) => toPosix(path.relative(root, bundle.dir)) || '.');
    throw new HcmError(
      `${where} has ${matches.length} bundles named "${requirement.name}": ${folders.join(', ')}`,
      'Add "#subdirectory=<folder>" to the URL to select one.',
    );
  }

  const relative = toPosix(path.relative(root, (matches[0] as { dir: string }).dir));
  if (!relative) return source;
  if (source.type === 'local') return { type: 'local', path: path.join(source.path, relative) };
  return { ...source, subdir: [source.subdir, relative].filter(Boolean).join('/') };
}
