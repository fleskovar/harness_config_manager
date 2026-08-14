import { validateBundle } from '../core/bundle.js';
import { formatDependencyTree, resolveDependencyGraph } from '../core/deps.js';
import { assertFlavorsAvailable, expandFlavors } from '../core/flavors.js';
import { describeSource } from '../core/github.js';
import { color, log } from '../core/logger.js';
import { sharedFiles } from '../core/overlap.js';
import { buildPlan } from '../core/planner.js';
import { asList, readRegistry, resolveBundles } from '../core/registry.js';
import type {
  LoadedBundle,
  ResourceKind,
  Scope,
  TargetId,
  TargetOptions,
} from '../core/types.js';
import { TARGET_IDS, getTarget } from '../targets/index.js';

export interface InfoOptions {
  scope: Scope;
  /** Preview the layout for a machine with these extensions installed. */
  targetOptions?: TargetOptions;
  /** Preview a narrowed install rather than the whole bundle. */
  flavors?: string[];
  cwd: string;
}

/** Show what a bundle contains and where each item would land in every target. */
export async function infoCommand(
  references: string | string[],
  options: InfoOptions,
): Promise<void> {
  const bundles: LoadedBundle[] = [];
  for (const reference of asList(references)) {
    bundles.push(...(await resolveBundles(reference, options.cwd)));
  }

  // The same refusal `hcm install` gives, so previewing a flavor you have
  // misspelled says so rather than showing you a suspiciously small bundle.
  options = { ...options, flavors: expandFlavors(options.flavors) ?? [] };
  assertFlavorsAvailable(bundles, options.flavors as string[]);

  const registry = await readRegistry();

  for (const [index, bundle] of bundles.entries()) {
    if (index > 0) log.plain(color.dim('\n' + '─'.repeat(60)));
    const entry = registry.entries.find((candidate) => candidate.name === bundle.manifest.name);
    await describeBundle(bundle, options, entry?.id);
  }
}

async function describeBundle(
  bundle: LoadedBundle,
  options: InfoOptions,
  id?: string,
): Promise<void> {
  const { manifest } = bundle;

  const handle = id ? `${color.dim(`[${id}]`)} ` : '';
  log.plain(`${handle}${color.bold(manifest.name)} ${color.dim(`v${manifest.version}`)}`);
  if (manifest.description) log.plain(manifest.description);
  log.plain(color.dim(describeSource(bundle.source)));
  if (manifest.author) log.plain(color.dim(`author: ${manifest.author}`));
  if (manifest.tags?.length) log.plain(color.dim(`tags: ${manifest.tags.join(', ')}`));

  await describeDependencies(bundle, options);
  describeFlavors(bundle, options);

  const byKind = new Map<ResourceKind, string[]>();
  for (const resource of bundle.resources) {
    const list = byKind.get(resource.kind) ?? [];
    // Marked rather than hidden: what a flavor leaves out is as much a part of
    // reading a bundle as what it takes.
    const flavors = resource.flavors.length ? color.dim(` (${resource.flavors.join('/')})`) : '';
    list.push(`${resource.name}${flavors}`);
    byKind.set(resource.kind, list);
  }

  log.plain(color.bold('\nContents'));
  if (byKind.size === 0) log.plain(color.dim('  (empty)'));
  for (const [kind, names] of byKind) {
    log.plain(`  ${kind.padEnd(9)} ${names.join(', ')}`);
  }

  const targets = manifest.targets?.length ? manifest.targets : TARGET_IDS;

  for (const targetId of targets) {
    const target = getTarget(targetId);
    const plan = await buildPlan(
      bundle,
      targetId,
      options.scope,
      options.cwd,
      options.targetOptions ?? {},
      options.flavors ?? [],
    );

    log.plain(color.bold(`\n${target.title}`) + color.dim(` · ${options.scope}`));
    for (const action of plan.actions) log.plain(`  ${action.describe}`);
    for (const skip of plan.skipped) {
      log.plain(color.dim(`  (skipped ${skip.resource.name}: ${skip.reason})`));
    }

    // Where this harness's layout forces a reference to be written differently
    // -- the thing you cannot work out by reading the bundle.
    for (const rewrite of plan.references?.rewrites ?? []) {
      log.plain(color.dim(`  ↳ ${rewrite.path}: ${rewrite.from} → ${rewrite.to}`));
    }
    for (const miss of plan.references?.dropped ?? []) {
      log.plain(color.yellow(`  ! ${miss.path}: "${miss.ref}" ${miss.reason}`));
    }
    if (plan.conflicts.length > 0) {
      for (const conflict of plan.conflicts) {
        log.plain(color.yellow(`  ! ${conflict.path}: ${conflict.detail}`));
      }
    }
  }

  describeSharedLandings(bundle, targets, options);

  const problems = validateBundle(bundle);
  if (problems.length > 0) {
    log.plain(color.bold('\nWarnings'));
    for (const problem of problems) log.plain(color.yellow(`  ${problem}`));
  }
}

/**
 * The landing places above that are not one harness's alone.
 *
 * The per-target listings read as if each harness had its own file, and for
 * almost everything they do. Where they do not, installing into one harness
 * installs into the other as well -- worth knowing before installing rather
 * than after uninstalling.
 */
function describeSharedLandings(
  bundle: LoadedBundle,
  targets: readonly TargetId[],
  options: InfoOptions,
): void {
  if (targets.length < 2) return;

  const kinds = new Set(bundle.resources.map((resource) => resource.kind));
  const shared = sharedFiles(targets, options.scope, options.cwd, options.targetOptions ?? {})
    .filter((file) => file.readers.some((reader) => reader.kinds.some((kind) => kinds.has(kind))));
  if (shared.length === 0) return;

  log.plain(color.bold('\nShared between targets'));
  for (const file of shared) {
    const readers = [...new Set(file.readers.map((reader) => reader.target))];
    log.plain(
      `  ${file.readers[0]?.path} ` +
        color.dim(`← ${readers.map((id) => getTarget(id).title).join(', ')}`),
    );
  }
  log.plain(
    color.dim('  Written once; uninstalling from one of them leaves it for the others.'),
  );
}

/**
 * The subsets this bundle can be installed as, and what each one holds.
 *
 * Printed against the *whole* bundle even when `--flavor` narrowed the preview,
 * because the question it answers -- what else could I have asked for -- is
 * exactly the one a narrowed listing cannot.
 */
function describeFlavors(bundle: LoadedBundle, options: InfoOptions): void {
  if (bundle.flavors.length === 0) return;

  const requested = new Set((options.flavors ?? []).map((name) => name.toLowerCase()));
  log.plain(color.bold('\nFlavors'));

  for (const flavor of bundle.flavors) {
    const members = bundle.resources.filter((resource) =>
      resource.flavors.some((name) => name.toLowerCase() === flavor.name.toLowerCase()),
    );
    const mark = requested.has(flavor.name.toLowerCase()) ? color.green('●') : color.dim('○');

    log.plain(
      `  ${mark} ${color.bold(flavor.name)} ` +
        color.dim(`${members.length} resource(s)`) +
        (flavor.description ? ` ${color.dim(`— ${flavor.description}`)}` : ''),
    );
    for (const member of members) log.plain(color.dim(`      ${member.bundlePath}`));
  }

  const common = bundle.resources.filter((resource) => resource.flavors.length === 0);
  log.plain(
    color.dim(
      `  ${common.length} resource(s) belong to no flavor and install whatever you ask for.`,
    ),
  );
  if (requested.size === 0) {
    log.plain(color.dim('  Installing without --flavor installs all of it.'));
  }
}

/**
 * What this bundle needs, and whether hcm can find it. Resolution is attempted
 * rather than assumed: a dependency that cannot be located is the thing you
 * most want `hcm info` to tell you, and it costs nothing to look.
 */
async function describeDependencies(bundle: LoadedBundle, options: InfoOptions): Promise<void> {
  if (bundle.dependencies.length === 0) return;

  log.plain(color.bold('\nRequires'));

  try {
    const graph = await resolveDependencyGraph([bundle], options.cwd);
    for (const line of formatDependencyTree(graph, [bundle.manifest.name]).slice(1)) {
      log.plain(`  ${line}`);
    }
  } catch (error) {
    for (const dependency of bundle.dependencies) {
      const range = dependency.version ? ` ${dependency.version}` : '';
      log.plain(`  ${dependency.name}${color.dim(range)}`);
    }
    log.plain(color.yellow(`  ! ${(error as Error).message}`));
  }
}
