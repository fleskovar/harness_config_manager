/**
 * Bundle loading.
 *
 * A bundle is just a directory with a manifest and a handful of
 * conventionally-named subdirectories. Resources are discovered from the
 * layout -- there is no resource list to keep in sync by hand.
 *
 *   my-bundle/
 *     hcm.yaml
 *     subagents/code-reviewer.md
 *     skills/security-review/SKILL.md
 *     commands/fix-issue.md
 *     rules/testing.md
 *     context/PROJECT.md
 *     mcp/github.json
 *     settings/settings.json
 *     assets/logo.png
 */

import path from 'node:path';
import YAML from 'yaml';
import { HcmError } from './errors.js';
import { parseMarkdown } from './frontmatter.js';
import { fs, isDirectory, listFiles, pathExists, toPosix } from './fsx.js';
import { isValidRange } from './semver.js';
import {
  type BundleDependency,
  type BundleManifest,
  type BundleResource,
  type BundleSource,
  KIND_DIRECTORIES,
  type LoadedBundle,
  type ResourceKind,
} from './types.js';

export const MANIFEST_NAMES = ['hcm.yaml', 'hcm.yml', 'hcm.json'];

export async function findManifest(root: string): Promise<string | undefined> {
  for (const name of MANIFEST_NAMES) {
    const candidate = path.join(root, name);
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

export async function loadManifest(root: string): Promise<BundleManifest> {
  const manifestPath = await findManifest(root);
  if (!manifestPath) {
    throw new HcmError(
      `No bundle manifest found in ${root}`,
      `Expected one of: ${MANIFEST_NAMES.join(', ')}. Run "hcm init" to scaffold one.`,
    );
  }

  const text = await fs.readFile(manifestPath, 'utf8');
  const parsed = (manifestPath.endsWith('.json') ? JSON.parse(text) : YAML.parse(text)) as unknown;

  if (!parsed || typeof parsed !== 'object') {
    throw new HcmError(`Manifest ${manifestPath} is empty or malformed`);
  }

  const manifest = parsed as BundleManifest;
  if (!manifest.name) throw new HcmError(`Manifest ${manifestPath} is missing "name"`);
  if (!manifest.version) throw new HcmError(`Manifest ${manifestPath} is missing "version"`);
  if (!BUNDLE_NAME_PATTERN.test(manifest.name)) {
    throw new HcmError(
      `Bundle name "${manifest.name}" is not usable as a directory/file name`,
      'Use letters, digits, dots, dashes and underscores.',
    );
  }

  // Parsed here so a malformed dependency is reported against the manifest it
  // is written in, rather than at install time against whoever required it.
  normalizeDependencies(manifest, manifestPath);

  return manifest;
}

const BUNDLE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Accept both ways of writing a dependency and return the one shape the rest of
 * hcm works with:
 *
 *   dependencies:
 *     - jira-board                    # any version
 *     - team-conventions@^2.0.0       # a range, npm-style
 *     - name: db-kit
 *       version: ">=1.2 <2"
 *       source: acme/agent-kits/db-kit
 */
export function normalizeDependencies(
  manifest: BundleManifest,
  where = manifest.name,
): BundleDependency[] {
  const declared = manifest.dependencies;
  if (declared === undefined) return [];

  if (!Array.isArray(declared)) {
    throw new HcmError(
      `"dependencies" in ${where} must be a list`,
      'Write one entry per bundle: "- jira-board@^1.2.0", or a mapping with name/version/source.',
    );
  }

  const seen = new Set<string>();
  const dependencies: BundleDependency[] = [];

  for (const entry of declared) {
    const dependency = typeof entry === 'string' ? parseDependencyString(entry, where) : entry;

    if (!dependency || typeof dependency !== 'object' || typeof dependency.name !== 'string') {
      throw new HcmError(
        `Malformed dependency in ${where}: ${JSON.stringify(entry)}`,
        'Each entry is a name, "name@range", or a mapping with a "name".',
      );
    }

    const name = dependency.name.trim();
    if (!BUNDLE_NAME_PATTERN.test(name)) {
      throw new HcmError(`"${name}" is not a usable bundle name (in ${where}'s dependencies)`);
    }
    if (name === manifest.name) {
      throw new HcmError(`Bundle "${manifest.name}" depends on itself`);
    }
    if (seen.has(name)) {
      throw new HcmError(
        `"${name}" is listed twice in ${where}'s dependencies`,
        'Give one entry per bundle; a single range can say "&&" with a space and "||" for either.',
      );
    }
    seen.add(name);

    const range = typeof dependency.version === 'string' ? dependency.version.trim() : undefined;
    if (range !== undefined && !isValidRange(range)) {
      throw new HcmError(
        `"${range}" is not a version range hcm understands (${where} -> ${name})`,
        'Supported: *, 1.2.3, ^1.2.3, ~1.2.3, >=1.2.3, 1.2.x, and these combined with spaces or "||".',
      );
    }

    const source = typeof dependency.source === 'string' ? dependency.source.trim() : undefined;

    dependencies.push({
      name,
      ...(range ? { version: range } : {}),
      ...(source ? { source } : {}),
    });
  }

  return dependencies;
}

/** `name`, or `name@range` -- the range may itself contain an `@`-free string. */
function parseDependencyString(entry: string, where: string): BundleDependency {
  const trimmed = entry.trim();
  if (!trimmed) throw new HcmError(`Empty dependency entry in ${where}`);

  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return { name: trimmed };
  return { name: trimmed.slice(0, at), version: trimmed.slice(at + 1) };
}

/**
 * Find the bundles in a directory.
 *
 * A directory is either a bundle itself, or a *collection*: a folder whose
 * immediate children are each a bundle. That covers the common case of one
 * repository holding several kits side by side. Only one level is searched --
 * nesting collections inside collections would make `hcm install <path>`
 * unpredictable.
 *
 * Returns absolute directory paths, sorted, empty when nothing was found.
 */
export async function discoverBundleDirs(root: string): Promise<string[]> {
  const absoluteRoot = path.resolve(root);
  if (await findManifest(absoluteRoot)) return [absoluteRoot];

  const entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    // Skip dot-directories and dependency folders rather than stat-ing them all.
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const candidate = path.join(absoluteRoot, entry.name);
    if (await findManifest(candidate)) found.push(candidate);
  }

  return found;
}

export async function loadBundle(root: string, source?: BundleSource): Promise<LoadedBundle> {
  const absoluteRoot = path.resolve(root);
  if (!(await isDirectory(absoluteRoot))) {
    throw new HcmError(`Bundle path is not a directory: ${absoluteRoot}`);
  }

  const manifest = await loadManifest(absoluteRoot);

  // `agents/` was this directory's name before the rename to `subagents/`.
  // Unknown directories are ignored, so without this the subagents would be
  // silently dropped from the install rather than reported.
  if (
    (await isDirectory(path.join(absoluteRoot, 'agents'))) &&
    !(await isDirectory(path.join(absoluteRoot, 'subagents')))
  ) {
    throw new HcmError(
      `Bundle "${manifest.name}" has an "agents/" directory, which hcm no longer reads`,
      'Rename it to "subagents/" -- the target harnesses keep their own naming.',
    );
  }

  const resources: BundleResource[] = [];

  for (const [directory, kind] of Object.entries(KIND_DIRECTORIES)) {
    const kindRoot = path.join(absoluteRoot, directory);
    if (!(await isDirectory(kindRoot))) continue;
    resources.push(...(await loadKind(absoluteRoot, kindRoot, kind)));
  }

  return {
    manifest,
    root: absoluteRoot,
    resources: resources.sort((a, b) => a.bundlePath.localeCompare(b.bundlePath)),
    source: source ?? { type: 'local', path: absoluteRoot },
    dependencies: normalizeDependencies(manifest),
  };
}

async function loadKind(
  bundleRoot: string,
  kindRoot: string,
  kind: ResourceKind,
): Promise<BundleResource[]> {
  // Skills are directories containing SKILL.md plus supporting files.
  if (kind === 'skill') return loadSkills(bundleRoot, kindRoot);
  // Assets are copied verbatim, preserving their relative layout.
  if (kind === 'asset') return loadAssets(bundleRoot, kindRoot);

  const entries = await fs.readdir(kindRoot, { withFileTypes: true });
  const resources: BundleResource[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const absolutePath = path.join(kindRoot, entry.name);
    const name = entry.name.replace(/\.(md|json|ya?ml)$/i, '');
    const bundlePath = toPosix(path.relative(bundleRoot, absolutePath));
    const text = await fs.readFile(absolutePath, 'utf8');

    if (kind === 'mcp' || kind === 'settings') {
      let data: unknown;
      try {
        data = entry.name.match(/\.ya?ml$/i) ? YAML.parse(text) : JSON.parse(text);
      } catch (error) {
        throw new HcmError(`Failed to parse ${bundlePath}: ${(error as Error).message}`);
      }
      resources.push({
        kind,
        name,
        bundlePath,
        primaryFile: absolutePath,
        files: [{ absolutePath, relativePath: '' }],
        frontmatter: {},
        data,
      });
      continue;
    }

    const { frontmatter, body } = parseMarkdown(text);
    resources.push({
      kind,
      name: typeof frontmatter.name === 'string' ? frontmatter.name : name,
      bundlePath,
      primaryFile: absolutePath,
      files: [{ absolutePath, relativePath: '' }],
      frontmatter,
      body,
    });
  }

  return resources;
}

async function loadSkills(bundleRoot: string, kindRoot: string): Promise<BundleResource[]> {
  const entries = await fs.readdir(kindRoot, { withFileTypes: true });
  const resources: BundleResource[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const skillRoot = path.join(kindRoot, entry.name);
    const skillFile = path.join(skillRoot, 'SKILL.md');

    if (!(await pathExists(skillFile))) {
      throw new HcmError(
        `Skill "${entry.name}" has no SKILL.md`,
        `Expected ${toPosix(path.relative(bundleRoot, skillFile))}`,
      );
    }

    const text = await fs.readFile(skillFile, 'utf8');
    const { frontmatter, body } = parseMarkdown(text);
    const files = (await listFiles(skillRoot)).map((absolutePath) => ({
      absolutePath,
      relativePath: toPosix(path.relative(skillRoot, absolutePath)),
    }));

    resources.push({
      kind: 'skill',
      name: typeof frontmatter.name === 'string' ? frontmatter.name : entry.name,
      bundlePath: toPosix(path.relative(bundleRoot, skillRoot)),
      primaryFile: skillFile,
      files,
      frontmatter,
      body,
    });
  }

  return resources;
}

async function loadAssets(bundleRoot: string, kindRoot: string): Promise<BundleResource[]> {
  const files = await listFiles(kindRoot);
  return files.map((absolutePath) => {
    const relativePath = toPosix(path.relative(kindRoot, absolutePath));
    return {
      kind: 'asset' as const,
      name: relativePath,
      bundlePath: toPosix(path.relative(bundleRoot, absolutePath)),
      primaryFile: absolutePath,
      files: [{ absolutePath, relativePath: '' }],
      frontmatter: {},
    };
  });
}

/** Basic sanity checks, surfaced by `hcm validate`. */
export function validateBundle(bundle: LoadedBundle): string[] {
  const problems: string[] = [];

  for (const resource of bundle.resources) {
    if (
      (resource.kind === 'subagent' || resource.kind === 'skill') &&
      !resource.frontmatter.description
    ) {
      problems.push(`${resource.bundlePath}: missing "description" in frontmatter`);
    }
    if (resource.kind === 'mcp') {
      const data = resource.data as Record<string, unknown> | undefined;
      const hasCommand = data && (typeof data.command === 'string' || typeof data.url === 'string');
      if (!hasCommand) {
        problems.push(`${resource.bundlePath}: MCP server needs a "command" or "url"`);
      }
    }
    if (resource.kind === 'rule') {
      const applies = resource.frontmatter.appliesTo;
      if (applies !== undefined && !Array.isArray(applies) && typeof applies !== 'string') {
        problems.push(`${resource.bundlePath}: "appliesTo" must be a string or list of globs`);
      }
    }
  }

  const seen = new Map<string, string>();
  for (const resource of bundle.resources) {
    const key = `${resource.kind}:${resource.name}`;
    const previous = seen.get(key);
    if (previous) problems.push(`Duplicate ${resource.kind} "${resource.name}" (${previous}, ${resource.bundlePath})`);
    seen.set(key, resource.bundlePath);
  }

  // On Reasonix and Pi a subagent is a Skill, so the two kinds share one
  // namespace -- Reasonix itself refuses a profile whose name belongs to
  // another Skill, and on Pi the two would overwrite each other's SKILL.md.
  for (const resource of bundle.resources) {
    if (resource.kind !== 'subagent') continue;
    const skill = seen.get(`skill:${resource.name}`);
    if (skill) {
      problems.push(
        `Subagent "${resource.name}" collides with the skill of the same name (${skill}, ${resource.bundlePath}): Reasonix and Pi store both as skills/${resource.name}/`,
      );
    }
  }

  return problems;
}
