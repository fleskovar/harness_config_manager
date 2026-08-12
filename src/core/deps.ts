/**
 * Bundle dependencies.
 *
 * A bundle that explains how to work with the team's JIRA board is worth
 * writing once, and requiring from the half-dozen bundles that assume it. So a
 * manifest may list `dependencies`, and installing a bundle installs what it
 * needs first.
 *
 * The rules, in short:
 *
 *   - One version of a bundle per scope. A scope has one `.claude/agents/`, so
 *     two versions of the same bundle cannot both be installed; conflicting
 *     ranges are reported rather than resolved to something nobody asked for.
 *   - Dependencies are installed before dependents, so the assets a dependent
 *     shares with its dependency are already on disk and claimed when the
 *     dependent's plan is built (see `core/state.ts` on claims).
 *   - Cycles are refused, naming the loop.
 *
 * Where a dependency is looked for, in order: bundles already resolved in this
 * run, the registry, a sibling directory in the same collection, and finally
 * the `source` the dependency itself names.
 */

import path from 'node:path';
import { discoverBundleDirs, loadBundle, loadManifest } from './bundle.js';
import { HcmError } from './errors.js';
import { isDirectory } from './fsx.js';
import { describeSource, resolveSource } from './github.js';
import { entryDir, loadBundlesFrom, parseSource, readRegistry } from './registry.js';
import { satisfies } from './semver.js';
import type { BundleDependency, BundleSource, InstalledDependency, LoadedBundle } from './types.js';

/** How a bundle came to be part of this run. */
export type ResolvedVia = 'requested' | 'registry' | 'sibling' | 'source';

export interface ResolvedBundle {
  bundle: LoadedBundle;
  /** Bundles that required this one. Empty when the user asked for it directly. */
  requiredBy: string[];
  /** The user named this bundle (or the collection holding it). */
  explicit: boolean;
  via: ResolvedVia;
}

export interface DependencyGraph {
  /** Every bundle to install, dependencies before dependents. */
  order: ResolvedBundle[];
  byName: Map<string, ResolvedBundle>;
  /** True when anything was pulled in that the user did not name. */
  hasDependencies: boolean;
}

export interface ResolveOptions {
  /** Re-download GitHub sources rather than using the cache. */
  refresh?: boolean;
}

/** Guards against a manifest that requires itself through a long enough chain. */
const MAX_DEPTH = 32;

/**
 * Resolve `roots` and everything they require into an install order.
 *
 * Roots are seeded first, so a bundle depending on a sibling in the same
 * collection gets the copy the user actually pointed at rather than a
 * registered one of the same name.
 */
export async function resolveDependencyGraph(
  roots: LoadedBundle[],
  cwd: string,
  options: ResolveOptions = {},
): Promise<DependencyGraph> {
  const byName = new Map<string, ResolvedBundle>();
  const order: ResolvedBundle[] = [];
  const finished = new Set<string>();
  /** Every range asked for, so a clash can name both sides. */
  const constraints = new Map<string, { range: string; from: string }[]>();

  for (const bundle of roots) {
    const name = bundle.manifest.name;
    const existing = byName.get(name);
    // The same collection can list a bundle twice only if two folders share a
    // name, which `hcm registry add` already refuses; keep the first regardless.
    if (!existing) byName.set(name, { bundle, requiredBy: [], explicit: true, via: 'requested' });
  }

  const visit = async (entry: ResolvedBundle, stack: string[]): Promise<void> => {
    const name = entry.bundle.manifest.name;
    if (finished.has(name)) return;

    if (stack.includes(name)) {
      throw new HcmError(
        `Dependency cycle: ${[...stack.slice(stack.indexOf(name)), name].join(' -> ')}`,
        'A bundle cannot require something that requires it back. Split the shared part into a third bundle.',
      );
    }
    if (stack.length >= MAX_DEPTH) {
      throw new HcmError(
        `Dependency chain is more than ${MAX_DEPTH} bundles deep (${[...stack, name].join(' -> ')})`,
      );
    }

    const nextStack = [...stack, name];

    for (const dependency of entry.bundle.dependencies) {
      const asked = constraints.get(dependency.name) ?? [];
      if (dependency.version) asked.push({ range: dependency.version, from: name });
      constraints.set(dependency.name, asked);

      let child = byName.get(dependency.name);

      if (!child) {
        child = await locate(dependency, entry.bundle, cwd, options);
        byName.set(dependency.name, child);
      }

      if (!child.requiredBy.includes(name)) child.requiredBy.push(name);
      assertSatisfies(child.bundle, constraints.get(dependency.name) ?? []);

      await visit(child, nextStack);
    }

    finished.add(name);
    order.push(entry);
  };

  for (const bundle of roots) {
    const entry = byName.get(bundle.manifest.name);
    if (entry) await visit(entry, []);
  }

  return { order, byName, hasDependencies: order.some((entry) => !entry.explicit) };
}

/**
 * Every constraint has to hold against the one copy that will be installed --
 * a scope has room for exactly one version of a bundle, so there is nothing to
 * reconcile if two dependents disagree.
 */
function assertSatisfies(
  bundle: LoadedBundle,
  asked: { range: string; from: string }[],
): void {
  const version = bundle.manifest.version;
  const failing = asked.filter((constraint) => !satisfies(version, constraint.range));
  if (failing.length === 0) return;

  const wanted = asked.map((constraint) => `${constraint.from} wants ${constraint.range}`);
  throw new HcmError(
    `"${bundle.manifest.name}" v${version} does not satisfy ${failing
      .map((constraint) => `${constraint.range} (required by ${constraint.from})`)
      .join(' and ')}`,
    asked.length > 1
      ? `Only one version of a bundle can be installed in a scope, and ${wanted.join(', ')}.`
      : `Register a version in range, or relax the range in ${failing[0]?.from}'s manifest.`,
  );
}

// ---------------------------------------------------------------------------
// Finding a dependency
// ---------------------------------------------------------------------------

interface Candidate {
  bundle: LoadedBundle;
  via: ResolvedVia;
  where: string;
}

/**
 * Find the bundle a dependency names. Every place is tried, and the first
 * candidate whose version satisfies the range wins -- so a registered copy that
 * is too old does not mask a `source` that would have worked.
 */
async function locate(
  dependency: BundleDependency,
  requirer: LoadedBundle,
  cwd: string,
  options: ResolveOptions,
): Promise<ResolvedBundle> {
  const found: Candidate[] = [];
  const failures: string[] = [];

  for (const lookup of [fromRegistry, fromSibling, fromRepoSibling, fromDeclaredSource]) {
    try {
      const candidate = await lookup(dependency, requirer, cwd, options);
      if (!candidate) continue;
      if (!dependency.version || satisfies(candidate.bundle.manifest.version, dependency.version)) {
        return {
          bundle: candidate.bundle,
          requiredBy: [],
          explicit: false,
          via: candidate.via,
        };
      }
      found.push(candidate);
    } catch (error) {
      // A dead GitHub ref in one place should not hide a usable copy in another;
      // the reason is kept for the error we raise if nothing works out.
      failures.push((error as Error).message);
    }
  }

  const requirerName = requirer.manifest.name;

  if (found.length > 0) {
    throw new HcmError(
      `"${requirerName}" requires ${dependency.name}@${dependency.version}, ` +
        `and the ${found.length === 1 ? 'copy' : 'copies'} hcm can find ${found.length === 1 ? 'is' : 'are'}: ` +
        found.map((candidate) => `v${candidate.bundle.manifest.version} (${candidate.where})`).join(', '),
      'Update the dependency with "hcm registry add <newer source>", or relax the range.',
    );
  }

  throw new HcmError(
    `"${requirerName}" requires the bundle "${dependency.name}", which hcm cannot find` +
      (failures.length > 0 ? `: ${failures.join('; ')}` : ''),
    dependency.source
      ? `Its manifest points at ${dependency.source}; check that it is reachable.`
      : `Register it first ("hcm registry add <path-or-repo>"), or give the dependency a "source" in ${requirerName}'s manifest.`,
  );
}

async function fromRegistry(
  dependency: BundleDependency,
  _requirer: LoadedBundle,
  _cwd: string,
  options: ResolveOptions,
): Promise<Candidate | undefined> {
  const registry = await readRegistry();
  // By name only: an id is a local handle, not something a manifest can mean.
  const entry = registry.entries.find((candidate) => candidate.name === dependency.name);
  if (!entry) return undefined;

  const bundle = await loadBundle(await entryDir(entry, options), entry.source);
  return { bundle, via: 'registry', where: 'registered' };
}

/**
 * A sibling folder in the same collection on this filesystem. This is what
 * makes a monorepo of bundles work while you are writing it: `kits/consumer`
 * requiring `kits/jira-board` needs nothing registered and no network.
 *
 * Two places are searched, because a registered bundle is a *snapshot* of one
 * directory -- the store copy has no siblings, but the source it was taken from
 * still does.
 */
async function fromSibling(
  dependency: BundleDependency,
  requirer: LoadedBundle,
  _cwd: string,
  _options: ResolveOptions,
): Promise<Candidate | undefined> {
  const parents = [path.dirname(requirer.root)];
  if (requirer.source.type === 'local') parents.push(path.dirname(requirer.source.path));

  for (const parent of new Set(parents.map((dir) => path.resolve(dir)))) {
    const dir = await findSibling(parent, dependency.name, requirer.root);
    if (!dir) continue;
    const bundle = await loadBundle(dir, { type: 'local', path: dir });
    return { bundle, via: 'sibling', where: `beside ${requirer.manifest.name}` };
  }

  return undefined;
}

/**
 * A sibling inside the same repository, for a bundle that came from a
 * subdirectory of one. The tarball is already in the cache, so this costs a
 * directory listing rather than a download.
 */
async function fromRepoSibling(
  dependency: BundleDependency,
  requirer: LoadedBundle,
  _cwd: string,
  options: ResolveOptions,
): Promise<Candidate | undefined> {
  const source = requirer.source;
  // A bundle at the repo root has no siblings inside the repo; anything beside
  // it in the cache belongs to another download entirely.
  if (source.type !== 'github' || !source.subdir) return undefined;

  const parentSubdir = source.subdir.split('/').slice(0, -1).filter(Boolean).join('/');
  const { subdir: _wasHere, ...repo } = source;
  const parentSource: BundleSource = parentSubdir ? { ...repo, subdir: parentSubdir } : repo;

  const parent = await resolveSource(parentSource, options);
  const dir = await findSibling(parent, dependency.name, requirer.root);
  if (!dir) return undefined;

  const name = path.basename(dir);
  const bundle = await loadBundle(dir, {
    ...source,
    subdir: parentSubdir ? `${parentSubdir}/${name}` : name,
  });
  return { bundle, via: 'sibling', where: `beside ${requirer.manifest.name}` };
}

/** The directory in `parent` holding a bundle called `name`, if there is one. */
async function findSibling(
  parent: string,
  name: string,
  exclude: string,
): Promise<string | undefined> {
  if (!(await isDirectory(parent))) return undefined;

  let siblings: string[];
  try {
    siblings = await discoverBundleDirs(parent);
  } catch {
    return undefined;
  }

  for (const dir of siblings) {
    if (path.resolve(dir) === path.resolve(exclude)) continue;
    const manifest = await loadManifest(dir).catch(() => undefined);
    if (manifest?.name === name) return dir;
  }

  return undefined;
}

async function fromDeclaredSource(
  dependency: BundleDependency,
  _requirer: LoadedBundle,
  cwd: string,
  options: ResolveOptions,
): Promise<Candidate | undefined> {
  if (!dependency.source) return undefined;

  const source = parseSource(dependency.source, cwd);
  const bundles = await loadBundlesFrom(source, options);

  // A collection is allowed as a source; take the bundle that has the name.
  const bundle =
    bundles.find((candidate) => candidate.manifest.name === dependency.name) ??
    (bundles.length === 1 ? bundles[0] : undefined);
  if (!bundle) return undefined;

  return { bundle, via: 'source', where: describeSource(source) };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** What gets recorded with an installation, so uninstall knows what it needed. */
export function installedDependencies(
  bundle: LoadedBundle,
  graph: DependencyGraph,
): InstalledDependency[] {
  const dependencies: InstalledDependency[] = [];

  for (const dependency of bundle.dependencies) {
    const resolved = graph.byName.get(dependency.name);
    if (!resolved) continue;
    dependencies.push({
      name: dependency.name,
      version: resolved.bundle.manifest.version,
      ...(dependency.version ? { range: dependency.version } : {}),
    });
  }

  return dependencies;
}

/**
 * The tree as `hcm install` and `hcm info` print it:
 *
 *   my-kit v1.0.0
 *   └─ jira-board v1.4.0  (registered)
 *      └─ team-conventions v2.0.0  (github:acme/kits/conventions#HEAD)
 */
export function formatDependencyTree(graph: DependencyGraph, roots: string[]): string[] {
  const lines: string[] = [];
  const drawn = new Set<string>();

  const walk = (name: string, prefix: string, last: boolean, depth: number): void => {
    const entry = graph.byName.get(name);
    if (!entry) return;

    const branch = depth === 0 ? '' : `${prefix}${last ? '└─ ' : '├─ '}`;
    const version = `v${entry.bundle.manifest.version}`;
    // A bundle needed twice is drawn once; the second mention says where to look.
    const repeat = drawn.has(name) ? '  (see above)' : depth === 0 ? '' : `  (${describeVia(entry)})`;

    lines.push(`${branch}${name} ${version}${repeat}`);
    if (drawn.has(name)) return;
    drawn.add(name);

    const children = entry.bundle.dependencies.map((dependency) => dependency.name);
    const nextPrefix = depth === 0 ? '' : `${prefix}${last ? '   ' : '│  '}`;
    children.forEach((child, index) => {
      walk(child, nextPrefix, index === children.length - 1, depth + 1);
    });
  };

  roots.forEach((root, index) => walk(root, '', index === roots.length - 1, 0));
  return lines;
}

function describeVia(entry: ResolvedBundle): string {
  switch (entry.via) {
    case 'registry':
      return 'registered';
    case 'sibling':
      return 'same collection';
    case 'source':
      return describeSource(entry.bundle.source);
    case 'requested':
      return 'requested';
  }
}
