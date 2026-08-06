import { HcmError } from '../core/errors.js';
import { color, log } from '../core/logger.js';
import { rollback, type RemovalStatus } from '../core/rollback.js';
import { findInstallations, removeInstallation } from '../core/state.js';
import { describeReceipt, type Scope } from '../core/types.js';
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
};

export async function uninstallCommand(bundleName: string, options: UninstallOptions): Promise<void> {
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
      continue;
    }

    if (blocked.length > 0 && !options.force) {
      log.warn(
        `  ${blocked.length} item(s) were modified since install and were left in place; ` +
          'the installation record is kept so you can retry with --force.',
      );
      continue;
    }

    await removeInstallation(options.scope, options.cwd, record.id);
    log.success(`  uninstalled ${record.bundle} from ${target.title}`);
  }
}

function pad(status: string): string {
  return status.padEnd(8);
}
