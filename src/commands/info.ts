import { validateBundle } from '../core/bundle.js';
import { describeSource } from '../core/github.js';
import { color, log } from '../core/logger.js';
import { buildPlan } from '../core/planner.js';
import { readRegistry, resolveBundles } from '../core/registry.js';
import type { LoadedBundle, ResourceKind, Scope } from '../core/types.js';
import { TARGET_IDS, getTarget } from '../targets/index.js';

export interface InfoOptions {
  scope: Scope;
  cwd: string;
}

/** Show what a bundle contains and where each item would land in every target. */
export async function infoCommand(reference: string, options: InfoOptions): Promise<void> {
  const bundles = await resolveBundles(reference, options.cwd);
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

  const byKind = new Map<ResourceKind, string[]>();
  for (const resource of bundle.resources) {
    const list = byKind.get(resource.kind) ?? [];
    list.push(resource.name);
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
    const plan = await buildPlan(bundle, targetId, options.scope, options.cwd);

    log.plain(color.bold(`\n${target.title}`) + color.dim(` · ${options.scope}`));
    for (const action of plan.actions) log.plain(`  ${action.describe}`);
    for (const skip of plan.skipped) {
      log.plain(color.dim(`  (skipped ${skip.resource.name}: ${skip.reason})`));
    }
    if (plan.conflicts.length > 0) {
      for (const conflict of plan.conflicts) {
        log.plain(color.yellow(`  ! ${conflict.path}: ${conflict.detail}`));
      }
    }
  }

  const problems = validateBundle(bundle);
  if (problems.length > 0) {
    log.plain(color.bold('\nWarnings'));
    for (const problem of problems) log.plain(color.yellow(`  ${problem}`));
  }
}
