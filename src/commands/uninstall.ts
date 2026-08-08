import { HcmError } from '../core/errors.js';
import { color, log } from '../core/logger.js';
import { resolveInstalledName } from '../core/registry.js';
import { rollback, type RemovalStatus } from '../core/rollback.js';
import { findInstallations, removeInstallation } from '../core/state.js';
import { describeReceipt, type InstallationRecord, type Scope } from '../core/types.js';
import { getTarget } from '../targets/index.js';

export interface UninstallOptions {
  targets?: string[];
  scope: Scope;
  dryRun?: boolean;
  force?: boolean;
  cwd: string;
}

const STATUS_STYLE: Record<RemovalStatus, (text: string) => string> = {
  removed: color.green,
  restored: color.green,
  missing: color.dim,
  partial: color.yellow,
  modified: color.yellow,
  kept: color.dim,
};

export async function uninstallCommand(reference: string, options: UninstallOptions): Promise<void> {
  // Accepts a registry id as well as a name; an unregistered bundle can still
  // be installed, so anything unrecognised is taken as a name.
  const bundleName = await resolveInstalledName(reference);
  const records = await findInstallations(options.scope, options.cwd, bundleName);

  const selected = options.targets?.length
    ? records.filter((record) => options.targets?.includes(record.target))
    : records;

  if (selected.length === 0) {
    throw new HcmError(
      `"${bundleName}" is not installed in ${options.scope} scope`,
      'Run "hcm list --installed" to see what is installed.',
    );
  }

  for (const record of selected) {
    const target = getTarget(record.target);
    const scopeRoot = target.scopeRoot(record.scope, options.cwd);

    log.info('');
    log.info(`${color.bold(target.title)} ${color.dim(`· ${record.scope} · ${scopeRoot}`)}`);

    const removed = await rollbackInstallation(record, options);
    if (removed) log.success(`  uninstalled ${record.bundle} from ${target.title}`);
  }
}

/**
 * Roll one installation back and drop its ledger entry. Returns false when
 * hand-edited items blocked it, or when this was a dry run -- `hcm update`
 * uses that to decide whether reinstalling on top is safe.
 */
export async function rollbackInstallation(
  record: InstallationRecord,
  options: { cwd: string; dryRun?: boolean; force?: boolean },
): Promise<boolean> {
  const target = getTarget(record.target);
  const scopeRoot = target.scopeRoot(record.scope, options.cwd);

  const results = await rollback(record, scopeRoot, {
    force: options.force ?? false,
    dryRun: options.dryRun ?? false,
  });

  for (const result of results) {
    const style = STATUS_STYLE[result.status];
    const detail = result.detail ? color.dim(` (${result.detail})`) : '';
    log.info(`  ${style(pad(result.status))} ${describeReceipt(result.receipt)}${detail}`);
  }

  const blocked = results.filter((result) => result.status === 'modified');

  if (options.dryRun) {
    log.info(color.dim('  (dry run -- nothing changed)'));
    return false;
  }

  if (blocked.length > 0 && !options.force) {
    log.warn(
      `  ${blocked.length} item(s) were modified since install and were left in place; ` +
        'the installation record is kept so you can retry with --force.',
    );
    return false;
  }

  await removeInstallation(record.scope, options.cwd, record.id);
  return true;
}

function pad(status: string): string {
  return status.padEnd(8);
}
