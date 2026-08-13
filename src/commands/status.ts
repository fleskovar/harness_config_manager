import { detectHarnesses, describeEvidence } from '../core/harnesses.js';
import { color, log } from '../core/logger.js';
import { allSharedFiles } from '../core/overlap.js';
import { auditInstallation } from '../core/rollback.js';
import { readState } from '../core/state.js';
import { describeReceipt, type Scope, type TargetId } from '../core/types.js';
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

  await reportHarnesses(scopes, options.cwd);

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

/**
 * Which harnesses this folder is used by, before anything about bundles.
 *
 * `hcm status` is the "is my setup sane?" command, and in a folder shared
 * between harnesses the first thing to know is that it *is* shared -- and which
 * files that makes ambiguous, since an item in one of those is never removed
 * from just one harness.
 */
async function reportHarnesses(scopes: Scope[], cwd: string): Promise<void> {
  for (const scope of scopes) {
    const found = await detectHarnesses(scope, cwd);
    if (found.length === 0) continue;

    log.plain(color.bold(`\n${scope} harnesses`));
    for (const harness of found) {
      log.plain(
        `  ${color.green('●')} ${color.bold(getTarget(harness.target).title)} ` +
          color.dim(`(${describeEvidence(harness)})`),
      );
    }

    if (found.length < 2) continue;

    const here = new Set(found.map((harness) => harness.target));
    const shared = allSharedFiles(scope, cwd).filter(
      (file) => file.readers.filter((reader) => here.has(reader.target)).length > 1,
    );

    for (const file of shared) {
      const readers = [
        ...new Set(
          file.readers.filter((reader) => here.has(reader.target)).map((reader) => reader.target),
        ),
      ] as TargetId[];
      log.plain(
        color.dim(
          `    ${file.readers[0]?.path}: shared by ` +
            `${readers.map((id) => getTarget(id).title).join(', ')} -- ` +
            'anything installed there is visible to all of them',
        ),
      );
    }
  }
}
