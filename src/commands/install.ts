import { ConflictError, HcmError } from '../core/errors.js';
import { applyPlan } from '../core/executor.js';
import { describeSource } from '../core/github.js';
import { color, log } from '../core/logger.js';
import { buildPlan } from '../core/planner.js';
import { resolveBundles } from '../core/registry.js';
import { upsertInstallation } from '../core/state.js';
import { installationId, type LoadedBundle, type Scope, type TargetId } from '../core/types.js';
import { getTarget, TARGET_IDS } from '../targets/index.js';

export interface InstallOptions {
  targets?: string[];
  scope: Scope;
  dryRun?: boolean;
  force?: boolean;
  refresh?: boolean;
  cwd: string;
}

export async function installCommand(reference: string, options: InstallOptions): Promise<void> {
  const bundles = await resolveBundles(reference, options.cwd, {
    refresh: options.refresh ?? false,
  });

  if (bundles.length > 1) {
    log.info(
      `${color.bold(String(bundles.length))} bundles found: ` +
        bundles.map((bundle) => bundle.manifest.name).join(', '),
    );
  }

  for (const bundle of bundles) {
    await installBundle(bundle, options);
  }
}

async function installBundle(bundle: LoadedBundle, options: InstallOptions): Promise<void> {
  const declared = bundle.manifest.targets;
  const requested = (options.targets?.length ? options.targets : undefined) ?? declared ?? TARGET_IDS;
  const targets = requested.map((id) => getTarget(id).id);

  // Only reachable when the user names a target explicitly; refuse rather than
  // installing nothing and calling it success.
  const undeclared = declared ? targets.filter((id) => !declared.includes(id)) : [];
  if (undeclared.length > 0) {
    throw new HcmError(
      `"${bundle.manifest.name}" does not support: ${undeclared.join(', ')}`,
      `The bundle declares targets: ${declared?.join(', ')}`,
    );
  }

  log.info(
    `${color.bold(bundle.manifest.name)} ${color.dim(`v${bundle.manifest.version}`)} ` +
      `${color.dim(`(${describeSource(bundle.source)})`)}`,
  );

  for (const targetId of targets) {
    await installOne(bundle, targetId, options);
  }
}

async function installOne(
  bundle: LoadedBundle,
  targetId: TargetId,
  options: InstallOptions,
): Promise<void> {
  const target = getTarget(targetId);
  const plan = await buildPlan(bundle, targetId, options.scope, options.cwd);

  log.info('');
  log.info(`${color.bold(target.title)} ${color.dim(`· ${options.scope} · ${plan.scopeRoot}`)}`);

  if (plan.actions.length === 0) {
    log.warn(`  nothing to install (${plan.skipped.length} resource(s) not supported here)`);
    return;
  }

  for (const skip of plan.skipped) {
    log.debug(`skip ${skip.resource.bundlePath}: ${skip.reason}`);
  }

  if (plan.conflicts.length > 0 && !options.force) {
    for (const conflict of plan.conflicts) {
      log.error(`  ${conflict.path}: ${conflict.detail}`);
    }
    throw new ConflictError(
      `${plan.conflicts.length} conflict(s) installing "${bundle.manifest.name}" into ${target.title}`,
      plan.conflicts,
    );
  }

  if (plan.conflicts.length > 0) {
    for (const conflict of plan.conflicts) {
      log.warn(`  overwriting: ${conflict.path}: ${conflict.detail}`);
    }
  }

  for (const action of plan.actions) {
    log.info(`  ${color.green('+')} ${action.describe}`);
  }

  if (options.dryRun) {
    log.info(color.dim('  (dry run -- nothing written)'));
    return;
  }

  const receipts = await applyPlan(plan);

  await upsertInstallation(options.scope, options.cwd, {
    id: installationId(bundle.manifest.name, targetId, options.scope),
    bundle: bundle.manifest.name,
    version: bundle.manifest.version,
    target: targetId,
    scope: options.scope,
    source: bundle.source,
    installedAt: new Date().toISOString(),
    receipts,
  });

  log.success(`  installed ${receipts.length} item(s)`);
}
