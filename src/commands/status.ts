import { color, log } from '../core/logger.js';
import { auditInstallation } from '../core/rollback.js';
import { readState } from '../core/state.js';
import { describeReceipt, type Scope } from '../core/types.js';
import { getTarget } from '../targets/index.js';

export interface StatusOptions {
  scope?: Scope | 'all';
  cwd: string;
}

/**
 * Verify that what the ledger claims is still true on disk: useful after a
 * teammate edits a shared file, or before an uninstall you want to be clean.
 */
export async function statusCommand(options: StatusOptions): Promise<void> {
  const scopes: Scope[] =
    options.scope === 'all' || options.scope === undefined ? ['project', 'user'] : [options.scope];

  let total = 0;
  let drifted = 0;

  for (const scope of scopes) {
    const state = await readState(scope, options.cwd);
    if (state.installations.length === 0) continue;

    log.plain(color.bold(`\n${scope} scope`));

    for (const record of state.installations) {
      const target = getTarget(record.target);
      const scopeRoot = target.scopeRoot(record.scope, options.cwd);
      const results = await auditInstallation(record, scopeRoot);

      const missing = results.filter((result) => result.status === 'missing');
      const modified = results.filter((result) => result.status === 'modified');
      const adopted = results.filter((result) => result.status === 'kept');
      total += results.length;
      drifted += missing.length + modified.length;

      const summary =
        missing.length === 0 && modified.length === 0
          ? color.green('ok')
          : color.yellow(`${modified.length} modified, ${missing.length} missing`);
      const adoptedNote =
        adopted.length > 0 ? color.dim(`  (${adopted.length} adopted)`) : '';

      log.plain(`  ${color.bold(record.bundle)} → ${record.target}  ${summary}${adoptedNote}`);

      for (const result of [...modified, ...missing]) {
        log.plain(`    ${color.dim(result.status)} ${describeReceipt(result.receipt)}`);
      }
    }
  }

  if (total === 0) {
    log.info('Nothing installed.');
    return;
  }

  log.plain('');
  if (drifted === 0) log.success(`${total} item(s) tracked, all intact.`);
  else log.warn(`${total} item(s) tracked, ${drifted} drifted from the recorded state.`);
}
