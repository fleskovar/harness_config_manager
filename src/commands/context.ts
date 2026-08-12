/**
 * `hcm context` -- keeping standing instructions alive in files their own
 * harness rewrites.
 *
 * See `core/context.ts` for why the cache exists. This file is the user's view
 * of it: which sections are tracked, whether each one is still in the file, and
 * the three ways of putting that right.
 */

import {
  appendContext,
  type ContextApplyOptions,
  type ContextFile,
  type ContextFileResult,
  type ContextItemResult,
  type ContextOutcome,
  cachedSectionPath,
  contextFiles,
  inspectContext,
  overrideContext,
  removeContext,
  syncBlockReceipts,
  touchPlacements,
  trackedBundles,
} from '../core/context.js';
import { HcmError } from '../core/errors.js';
import { color, log } from '../core/logger.js';
import { confirm, isInteractive } from '../core/prompt.js';
import { resolveInstalledName } from '../core/registry.js';
import type { Scope } from '../core/types.js';
import { getTarget } from '../targets/index.js';

export interface ContextOptions {
  targets?: string[];
  scope?: Scope | 'all';
  dryRun?: boolean;
  /** append: write every section anyway. override: do not ask before clearing. */
  force?: boolean;
  json?: boolean;
  /** Test seam: answers the "this will discard N lines" question. */
  confirmer?: (question: string) => Promise<boolean>;
  cwd: string;
}

const OUTCOME_STYLE: Record<ContextOutcome, (text: string) => string> = {
  appended: color.green,
  rewritten: color.green,
  removed: color.green,
  present: color.dim,
  unmarked: color.yellow,
  missing: color.dim,
};

const OUTCOME_NOTE: Partial<Record<ContextOutcome, string>> = {
  present: 'already in the file',
  unmarked: 'text is there without markers -- not appended again',
  missing: 'nothing to do',
};

function scopesOf(options: ContextOptions): Scope[] {
  return options.scope === 'all' || options.scope === undefined
    ? ['project', 'user']
    : [options.scope];
}

/**
 * Work out which bundles were asked for. References are matched the way every
 * other command matches them -- name or registry id -- and a reference naming
 * nothing tracked is an error rather than a silent no-op.
 */
async function selectBundles(
  references: string[],
  options: ContextOptions,
): Promise<string[] | undefined> {
  if (references.length === 0) return undefined;

  const tracked = new Set<string>();
  for (const scope of scopesOf(options)) {
    for (const bundle of await trackedBundles(scope, options.cwd)) tracked.add(bundle);
  }

  const selected: string[] = [];
  const unknown: string[] = [];

  for (const reference of references) {
    const name = await resolveInstalledName(reference);
    if (tracked.has(name)) selected.push(name);
    else unknown.push(reference);
  }

  if (unknown.length > 0) {
    throw new HcmError(
      `No context is tracked for: ${unknown.join(', ')}`,
      tracked.size > 0
        ? `Tracked bundles: ${[...tracked].sort().join(', ')}`
        : 'Context is cached when you install a bundle that has a context/ directory.',
    );
  }

  return selected;
}

async function gather(references: string[], options: ContextOptions): Promise<ContextFile[]> {
  const bundles = await selectBundles(references, options);
  const targets = options.targets?.length ? options.targets.map((id) => getTarget(id).id) : undefined;

  const files: ContextFile[] = [];
  for (const scope of scopesOf(options)) {
    files.push(
      ...(await contextFiles(scope, options.cwd, {
        ...(bundles ? { bundles } : {}),
        ...(targets ? { targets } : {}),
      })),
    );
  }
  return files;
}

/** Nothing tracked at all is worth explaining rather than printing an empty list. */
function nothingTracked(options: ContextOptions): void {
  log.info('No context sections are tracked here.');
  log.info(
    color.dim(
      'They are cached when you install a bundle with a context/ directory ' +
        `(${options.scope === 'user' ? 'user' : 'project'} scope).`,
    ),
  );
}

function fileHeader(file: ContextFile): void {
  // Two harnesses can share one file, and both own the block that lands in it.
  const titles = file.targets.map((id) => getTarget(id).title).join(', ');
  log.info('');
  log.info(
    `${color.bold(file.path)} ${color.dim(`· ${titles} · ${file.scope} · ${file.absolutePath}`)}`,
  );
}

function report(results: ContextItemResult[]): void {
  for (const { item, outcome } of results) {
    const note = OUTCOME_NOTE[outcome];
    const detail =
      outcome === 'missing' && item.body === undefined
        ? color.dim('  (cached copy is gone -- reinstall the bundle)')
        : note
          ? color.dim(`  (${note})`)
          : '';
    log.info(
      `  ${OUTCOME_STYLE[outcome](outcome.padEnd(9))} ${item.section.bundle}/${item.section.name}${detail}`,
    );
  }
}

function count(results: ContextFileResult[], ...outcomes: ContextOutcome[]): number {
  return results.reduce(
    (total, result) =>
      total + result.results.filter((item) => outcomes.includes(item.outcome)).length,
    0,
  );
}

/**
 * Persist the bookkeeping the three operations share, then say what happened.
 * A dry run reports the same counts in the conditional, since nothing was
 * written and nothing was recorded.
 */
async function persist(
  results: ContextFileResult[],
  options: ContextOptions,
  summary: (count: number, would: boolean) => string,
  outcomes: ContextOutcome[],
): Promise<void> {
  if (!options.dryRun) {
    for (const scope of scopesOf(options)) {
      const forScope = results.filter((result) => result.file.scope === scope);
      if (forScope.length === 0) continue;
      await syncBlockReceipts(scope, options.cwd, forScope);
      await touchPlacements(scope, options.cwd, forScope);
    }
  }

  log.info('');
  const message = summary(count(results, ...outcomes), options.dryRun === true);
  if (options.dryRun) log.info(`${color.dim('(dry run)')} ${message}`);
  else log.success(message);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function contextListCommand(
  references: string[],
  options: ContextOptions,
): Promise<void> {
  const files = await gather(references, options);

  if (options.json) {
    const payload = [];
    for (const file of files) {
      for (const { item, presence } of await inspectContext(file)) {
        payload.push({
          bundle: item.section.bundle,
          section: item.section.name,
          order: item.section.order,
          targets: item.targets,
          scope: file.scope,
          path: file.path,
          blockId: item.placement.blockId,
          cached: cachedSectionPath(file.scope, options.cwd, item.section),
          presence,
        });
      }
    }
    log.plain(JSON.stringify(payload, null, 2));
    return;
  }

  if (files.length === 0) {
    nothingTracked(options);
    return;
  }

  let absent = 0;
  let unmarked = 0;

  for (const file of files) {
    fileHeader(file);
    for (const { item, presence } of await inspectContext(file)) {
      if (presence === 'absent') absent += 1;
      if (presence === 'unmarked') unmarked += 1;
      const style =
        presence === 'present' ? color.green : presence === 'unmarked' ? color.yellow : color.red;
      log.info(`  ${style(presence.padEnd(9))} ${item.section.bundle}/${item.section.name}`);
    }
  }

  log.info('');
  if (absent === 0 && unmarked === 0) {
    log.success('Every tracked section is in place.');
    return;
  }
  if (unmarked > 0) {
    log.warn(`${unmarked} section(s) present but no longer inside their markers.`);
    log.info(color.dim('  "hcm context append --force" re-wraps them; that will duplicate the text if the file kept a copy.'));
  }
  if (absent > 0) {
    log.warn(`${absent} section(s) missing. Put them back with "hcm context append".`);
  }
}

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------

export async function contextAppendCommand(
  references: string[],
  options: ContextOptions,
): Promise<void> {
  const files = await gather(references, options);
  if (files.length === 0) {
    nothingTracked(options);
    return;
  }

  const apply: ContextApplyOptions = {
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.force ? { force: true } : {}),
  };

  const results: ContextFileResult[] = [];
  for (const file of files) {
    fileHeader(file);
    const result = await appendContext(file, apply);
    report(result.results);
    results.push(result);
  }

  await persist(
    results,
    options,
    (written, would) =>
      written === 0
        ? 'Nothing missing; every section was already in place.'
        : `${written} section(s) ${would ? 'would be ' : ''}written.`,
    ['appended', 'rewritten'],
  );
}

// ---------------------------------------------------------------------------
// override
// ---------------------------------------------------------------------------

export async function contextOverrideCommand(
  references: string[],
  options: ContextOptions,
): Promise<void> {
  const files = await gather(references, options);
  if (files.length === 0) {
    nothingTracked(options);
    return;
  }

  const apply: ContextApplyOptions = { ...(options.dryRun ? { dryRun: true } : {}) };
  const results: ContextFileResult[] = [];

  for (const file of files) {
    fileHeader(file);

    // Overriding throws away everything hcm did not write. Say how much that is
    // and get an answer before doing it, the way a conflict is put to the user.
    const preview = await overrideContext(file, { dryRun: true });
    if (!(await agreeToDiscard(file, preview.discardedLines ?? 0, options))) {
      log.info(`  ${color.dim('skipped')}`);
      continue;
    }

    const result = await overrideContext(file, apply);
    report(result.results);
    if (result.discardedLines) {
      log.warn(`  discarded ${result.discardedLines} line(s) that hcm did not write`);
    }
    results.push(result);
  }

  await persist(
    results,
    options,
    (written, would) => `${written} section(s) ${would ? 'would be ' : ''}written.`,
    ['appended', 'rewritten'],
  );
}

/**
 * `--force` means "do not ask". Without a terminal there is nobody to ask, so
 * refuse rather than quietly deleting somebody's notes -- the same bargain
 * `hcm install` makes with conflicts.
 */
async function agreeToDiscard(
  file: ContextFile,
  discardedLines: number,
  options: ContextOptions,
): Promise<boolean> {
  if (discardedLines === 0 || options.force || options.dryRun) return true;

  const question =
    `  ${color.yellow('!')} ${file.path} holds ${discardedLines} line(s) hcm did not write. ` +
    'Override discards them.\n  Replace the file with the cached context?';

  const ask = options.confirmer;
  if (ask) return ask(question);

  if (!isInteractive()) {
    throw new HcmError(
      `${file.path} holds ${discardedLines} line(s) hcm did not write`,
      'Re-run interactively to confirm, pass --force to discard them, or use ' +
        '"hcm context append" to add the missing sections without clearing the file.',
    );
  }

  return confirm(question);
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

export async function contextRemoveCommand(
  references: string[],
  options: ContextOptions,
): Promise<void> {
  const files = await gather(references, options);
  if (files.length === 0) {
    nothingTracked(options);
    return;
  }

  const apply: ContextApplyOptions = { ...(options.dryRun ? { dryRun: true } : {}) };
  const results: ContextFileResult[] = [];

  for (const file of files) {
    fileHeader(file);
    const result = await removeContext(file, apply);
    report(result.results);
    if (result.deleted) log.info(`  ${color.dim('deleted')} ${file.path} (nothing else was in it)`);
    results.push(result);
  }

  await persist(
    results,
    options,
    (removed, would) => `${removed} section(s) ${would ? 'would be ' : ''}removed.`,
    ['removed'],
  );

  if (count(results, 'removed') > 0 && !options.dryRun) {
    log.info(color.dim('The cached copies are kept; "hcm context append" puts them back.'));
  }
}
