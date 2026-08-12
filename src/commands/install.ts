import {
  type ConflictPolicy,
  type ConflictResolver,
  type Resolution,
  resolvePlanConflicts,
} from '../core/conflicts.js';
import { captureContext } from '../core/context.js';
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
  /** Shorthand for `onConflict: 'overwrite'`. */
  force?: boolean;
  /** What to do about collisions; defaults to asking when there is a terminal. */
  onConflict?: ConflictPolicy;
  /** Test seam: answers the conflict questions instead of the terminal. */
  resolver?: ConflictResolver;
  /**
   * Answers remembered across targets and bundles in one run, so installing
   * into three harnesses asks each question once. Created here when absent.
   */
  decisions?: Map<string, Resolution>;
  refresh?: boolean;
  cwd: string;
}

export async function installCommand(reference: string, options: InstallOptions): Promise<void> {
  const bundles = await resolveBundles(reference, options.cwd, {
    refresh: options.refresh ?? false,
  });

  // One shared memory of answers for the whole command.
  const decisions = options.decisions ?? new Map<string, Resolution>();
  options = { ...options, decisions };

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
    logTargetHeader(targetId, options);
    await installInto(bundle, targetId, options);
  }
}

/** The "Claude Code · project · /path" banner each target's output sits under. */
export function logTargetHeader(targetId: TargetId, options: { scope: Scope; cwd: string }): void {
  const target = getTarget(targetId);
  log.info('');
  log.info(
    `${color.bold(target.title)} ${color.dim(`· ${options.scope} · ${target.scopeRoot(options.scope, options.cwd)}`)}`,
  );
}

/**
 * Install one bundle into one target. Exported because `hcm update` reinstalls
 * a bundle target by target, following what the ledger says is already there.
 */
export async function installInto(
  bundle: LoadedBundle,
  targetId: TargetId,
  options: InstallOptions,
): Promise<void> {
  const target = getTarget(targetId);
  const built = await buildPlan(bundle, targetId, options.scope, options.cwd);

  if (built.actions.length === 0) {
    log.warn(`  nothing to install (${built.skipped.length} resource(s) not supported here)`);
    return;
  }

  for (const skip of built.skipped) {
    log.debug(`skip ${skip.resource.bundlePath}: ${skip.reason}`);
  }

  const { plan, outcomes } = await resolveConflicts(built, target.title, options);

  for (const outcome of outcomes) {
    log.info(`  ${color.cyan(outcome.choice)} ${outcome.label} ${color.dim(`(${outcome.detail})`)}`);
  }

  // What is left is what the user said to overwrite.
  for (const conflict of plan.conflicts) {
    log.warn(`  overwriting: ${conflict.path}: ${conflict.detail}`);
  }

  if (plan.actions.length === 0) {
    log.warn('  nothing left to install after resolving conflicts');
    return;
  }

  for (const action of plan.actions) {
    const mark = action.adopt ? color.dim('=') : color.green('+');
    const note = action.adopt ? color.dim('  (already present -- adopted, not ours to remove)') : '';
    log.info(`  ${mark} ${action.describe}${note}`);
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

  // Keep a copy of the context sections. The harness's own agent rewrites
  // CLAUDE.md and AGENTS.md; a receipt records where a section was, not what it
  // said, so without this there would be nothing to put back. See core/context.ts.
  const cached = await captureContext(bundle, targetId, options.scope, options.cwd, plan.actions);

  const adopted = receipts.filter(
    (receipt) => (receipt.op === 'file' || receipt.op === 'json-value') && receipt.preexisting,
  ).length;

  log.success(
    `  installed ${receipts.length} item(s)` +
      (adopted > 0 ? color.dim(` (${adopted} already present, left as they are)`) : ''),
  );
  if (cached > 0) {
    log.debug(`cached ${cached} context section(s) for "hcm context append"`);
  }
}

/**
 * Ask (or apply the policy) about every collision, and report the conflicts we
 * could not get past the way `hcm` always has.
 */
async function resolveConflicts(
  plan: Awaited<ReturnType<typeof buildPlan>>,
  targetTitle: string,
  options: InstallOptions,
): ReturnType<typeof resolvePlanConflicts> {
  try {
    return await resolvePlanConflicts(plan, {
      policy: options.onConflict ?? (options.force ? 'overwrite' : 'prompt'),
      ...(options.resolver ? { resolver: options.resolver } : {}),
      ...(options.decisions ? { decisions: options.decisions } : {}),
      cwd: options.cwd,
    });
  } catch (error) {
    if (error instanceof ConflictError) {
      for (const conflict of error.conflicts) {
        log.error(`  ${conflict.path}: ${conflict.detail}`);
      }
      throw new ConflictError(
        `${error.conflicts.length} conflict(s) installing "${plan.bundle.manifest.name}" into ${targetTitle}`,
        error.conflicts,
      );
    }
    throw error;
  }
}
