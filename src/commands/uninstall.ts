/**
 * `hcm uninstall` -- take back exactly what a bundle installed.
 *
 * Two things stand between a record and its removal:
 *
 *   dependents  another installed bundle requires this one. Removing it would
 *               leave that bundle referring to subagents and servers that are
 *               no longer there, so it is refused unless you say what to do.
 *   claims      an individual item is also claimed by an installation that is
 *               staying -- a shared asset, a permission two bundles both ask
 *               for. Those items are held; the last uninstall removes them.
 *
 * And one thing follows it: a dependency that was pulled in automatically and
 * is now needed by nobody goes too, the way it arrived.
 */

import { forgetContext } from '../core/context.js';
import { HcmError } from '../core/errors.js';
import { detectHarnesses, expandTargets, requireTargetChoice } from '../core/harnesses.js';
import { color, log } from '../core/logger.js';
import { describeReaders, sharedFileNotices } from '../core/overlap.js';
import { asList, resolveInstalledName } from '../core/registry.js';
import { rollback, type RemovalResult, type RemovalStatus } from '../core/rollback.js';
import {
  collectClaims,
  findDependents,
  findInstallation,
  findInstallations,
  removeInstallation,
} from '../core/state.js';
import {
  describeReceipt,
  type InstallationRecord,
  type Scope,
  type TargetId,
} from '../core/types.js';
import { getTarget } from '../targets/index.js';

export interface UninstallOptions {
  targets?: string[];
  scope: Scope;
  dryRun?: boolean;
  force?: boolean;
  /** Remove the bundles that depend on this one as well. */
  cascade?: boolean;
  /** Remove it anyway, leaving its dependents installed but incomplete. */
  ignoreDependents?: boolean;
  /** Keep dependencies that were pulled in automatically and are now unused. */
  keepOrphans?: boolean;
  /** Harnesses set up in this folder; see `core/harnesses.ts`. Detected when absent. */
  presentTargets?: TargetId[];
  cwd: string;
}

const STATUS_STYLE: Record<RemovalStatus, (text: string) => string> = {
  removed: color.green,
  restored: color.green,
  missing: color.dim,
  partial: color.yellow,
  modified: color.yellow,
  kept: color.dim,
  held: color.cyan,
};

/**
 * Uninstall one bundle, or several.
 *
 * Several at once is not the same as several commands. The removals are worked
 * out together, so a bundle that depends on another one being removed in the
 * same breath is not a reason to stop, and an item both of them claim comes out
 * once the last of them has gone -- rather than being held by a claim that this
 * very command is about to drop.
 */
export async function uninstallCommand(
  references: string | string[],
  options: UninstallOptions,
): Promise<void> {
  const wanted = asList(references);
  const chosen = expandTargets(options.targets);

  // Every name is resolved before anything is removed: a typo in the third of
  // three should not leave the first two uninstalled.
  const selected: InstallationRecord[] = [];
  const bundleNames = new Set<string>();

  for (const reference of wanted) {
    // Accepts a registry id as well as a name; an unregistered bundle can still
    // be installed, so anything unrecognised is taken as a name.
    const bundleName = await resolveInstalledName(reference);
    const records = await findInstallations(options.scope, options.cwd, bundleName);
    const matching = chosen ? records.filter((record) => chosen.includes(record.target)) : records;

    if (matching.length === 0) {
      throw new HcmError(
        `"${bundleName}" is not installed in ${options.scope} scope` +
          (chosen ? ` in ${chosen.join(', ')}` : ''),
        'Run "hcm list --installed" to see what is installed.',
      );
    }

    bundleNames.add(bundleName);
    for (const record of matching) {
      if (!selected.some((existing) => existing.id === record.id)) selected.push(record);
    }
  }

  // Only ambiguous if it is actually installed into several harnesses: a bundle
  // that only ever went into one needs no `-t`, however many harnesses the
  // folder holds.
  const found = await requireTargetChoice({
    ...(chosen ? { chosen } : {}),
    affected: [...new Set(selected.map((record) => record.target))],
    command: `hcm uninstall ${wanted.join(' ')}`,
    scope: options.scope,
    cwd: options.cwd,
  });
  const presentTargets = found.map((harness) => harness.target);

  const removing = await withDependents(selected, options);
  const pendingIds = removing.map((record) => record.id);

  for (const record of removing) {
    const target = getTarget(record.target);
    const scopeRoot = target.scopeRoot(record.scope, options.cwd);

    // Named bundles get the plain header; anything --cascade dragged in says
    // whose account it is being removed on.
    const cascaded = bundleNames.has(record.bundle)
      ? ''
      : ` ${color.bold(record.bundle)}${color.dim(' (depends on it)')}`;

    log.info('');
    log.info(`${color.bold(target.title)} ${color.dim(`· ${record.scope} · ${scopeRoot}`)}${cascaded}`);

    const removed = await rollbackInstallation(record, {
      ...options,
      alsoRemoving: pendingIds,
      presentTargets,
    });
    if (removed) log.success(`  uninstalled ${record.bundle} from ${target.title}`);
  }

  if (!options.keepOrphans) await pruneOrphans(removing, { ...options, presentTargets });
}

/**
 * The records this run should take away.
 *
 * Anything still depending on the bundle stops the run: an installed bundle
 * whose dependency has gone is broken in a way `hcm status` cannot see, since
 * every item it owns is still exactly where it left it. `--cascade` says to
 * remove those bundles too (and whatever depends on *them*); `--ignore-dependents`
 * says to go ahead and leave them as they are.
 */
async function withDependents(
  selected: InstallationRecord[],
  options: UninstallOptions,
): Promise<InstallationRecord[]> {
  const chosen = new Map(selected.map((record) => [record.id, record]));
  const blocked: { record: InstallationRecord; dependents: InstallationRecord[] }[] = [];

  // Breadth-first over "who needs what is going away", so a chain of three
  // bundles unwinds in one command.
  const queue = [...selected];
  while (queue.length > 0) {
    const record = queue.shift() as InstallationRecord;
    const dependents = (
      await findDependents(record.scope, options.cwd, record.bundle, record.target)
    ).filter((dependent) => !chosen.has(dependent.id));

    if (dependents.length === 0) continue;

    if (!options.cascade) {
      blocked.push({ record, dependents });
      continue;
    }

    for (const dependent of dependents) {
      chosen.set(dependent.id, dependent);
      queue.push(dependent);
    }
  }

  if (blocked.length > 0 && !options.ignoreDependents) {
    const detail = blocked
      .map(
        ({ record, dependents }) =>
          `${record.bundle} (${record.target}) is required by ` +
          [...new Set(dependents.map((dependent) => dependent.bundle))].join(', '),
      )
      .join('; ');

    throw new HcmError(
      `Other installed bundles still depend on this one: ${detail}`,
      'Use --cascade to remove them too, or --ignore-dependents to leave them installed without it.',
    );
  }

  if (blocked.length > 0) {
    for (const { record, dependents } of blocked) {
      log.warn(
        `  ${[...new Set(dependents.map((dependent) => dependent.bundle))].join(', ')} ` +
          `still expect ${record.bundle}; removing it anyway (--ignore-dependents)`,
      );
    }
  }

  return dependentsFirst([...chosen.values()]);
}

/**
 * Order records so nothing is removed before the things that require it. A
 * chain of three unwinds from the top; anything left in a cycle (which the
 * resolver refuses, but an old ledger could still hold) keeps its place rather
 * than looping.
 */
function dependentsFirst(records: InstallationRecord[]): InstallationRecord[] {
  const remaining = [...records];
  const ordered: InstallationRecord[] = [];

  while (remaining.length > 0) {
    const index = remaining.findIndex(
      (candidate) =>
        !remaining.some(
          (other) =>
            other !== candidate &&
            other.target === candidate.target &&
            other.scope === candidate.scope &&
            dependsOn(other, candidate.bundle),
        ),
    );
    ordered.push(...remaining.splice(index < 0 ? 0 : index, 1));
  }

  return ordered;
}

function dependsOn(record: InstallationRecord, bundle: string): boolean {
  return (record.dependencies ?? []).some((dependency) => dependency.name === bundle);
}

/**
 * Roll one installation back and drop its ledger entry. Returns false when
 * hand-edited items blocked it, or when this was a dry run -- `hcm update`
 * uses that to decide whether reinstalling on top is safe.
 */
export async function rollbackInstallation(
  record: InstallationRecord,
  options: {
    cwd: string;
    dryRun?: boolean;
    force?: boolean;
    /** Other installations going away in the same run; their claims do not count. */
    alsoRemoving?: string[];
    /** Harnesses set up in this folder; see `core/harnesses.ts`. Detected when absent. */
    presentTargets?: TargetId[];
  },
): Promise<boolean> {
  const target = getTarget(record.target);
  const scopeRoot = target.scopeRoot(record.scope, options.cwd);

  const claims = await collectClaims(options.cwd, {
    excludeIds: [record.id, ...(options.alsoRemoving ?? [])],
  });

  const results = await rollback(record, scopeRoot, {
    force: options.force ?? false,
    dryRun: options.dryRun ?? false,
    claims,
  });

  for (const result of results) {
    const style = STATUS_STYLE[result.status];
    const detail = result.detail ? color.dim(` (${result.detail})`) : '';
    log.info(`  ${style(pad(result.status))} ${describeReceipt(result.receipt)}${detail}`);
  }

  await reportSharedFiles(record, results, options);

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
  // The cached context sections went with the blocks; nothing should offer to
  // put back instructions from a bundle that is no longer installed.
  await forgetContext(record.bundle, record.target, record.scope, options.cwd);
  return true;
}

/**
 * Say what removing from one harness did to the others.
 *
 * `-t reasonix` reads as "only Reasonix", and for `.reasonix/` it is. For a
 * file two harnesses read it cannot be, and it goes wrong in both directions:
 *
 *   held     another installation still claims the item, so it stays in the
 *            file -- and the harness you removed it from goes on reading that
 *            same file, so it still has it. This is the one that surprises
 *            people: `hcm uninstall -t reasonix` reports success and Reasonix
 *            still has the MCP server, because Claude Code's claim kept the
 *            entry in `.mcp.json`.
 *   removed  nothing else claimed it, so it is gone from the file -- including
 *            for the harnesses that were not named.
 */
async function reportSharedFiles(
  record: InstallationRecord,
  results: RemovalResult[],
  options: { cwd: string; presentTargets?: TargetId[] },
): Promise<void> {
  const present =
    options.presentTargets ??
    (await detectHarnesses(record.scope, options.cwd)).map((harness) => harness.target);

  const notices = sharedFileNotices({
    target: record.target,
    paths: results.map((result) => result.receipt.path),
    scope: record.scope,
    cwd: options.cwd,
    present,
    ...(record.targetOptions ? { options: record.targetOptions } : {}),
  });

  for (const notice of notices) {
    const touched = results.filter((result) => result.receipt.path === notice.path);
    const held = touched.filter((result) => result.status === 'held').length;
    const gone = touched.filter(
      (result) => result.status === 'removed' || result.status === 'partial',
    ).length;
    const readers = describeReaders(notice.others);

    if (held > 0) {
      log.warn(
        `  ${notice.path} is shared with ${readers}: ${held} item(s) were left in place, ` +
          `so ${getTarget(record.target).title} still reads them from this file`,
      );
    }
    if (gone > 0) {
      log.warn(
        `  ${notice.path} is shared with ${readers}: ${gone} item(s) were removed from it, ` +
          `so ${readers} lost them too`,
      );
    }
  }
}

/**
 * Remove dependencies that were only ever installed for the bundles just taken
 * away. A bundle the user installed by name is never pruned, even if it later
 * became somebody's dependency -- `auto` records that difference.
 */
async function pruneOrphans(
  removed: InstallationRecord[],
  options: UninstallOptions,
): Promise<void> {
  // A dry run gets the same reckoning -- the records are all still in the
  // ledger, but `gone` already holds the ids this run would have taken.
  const gone = new Set(removed.map((record) => record.id));
  const queue = removed.flatMap((record) =>
    (record.dependencies ?? []).map((dependency) => ({
      name: dependency.name,
      scope: record.scope,
      target: record.target,
    })),
  );

  const orphans: InstallationRecord[] = [];

  while (queue.length > 0) {
    const wanted = queue.shift() as { name: string; scope: Scope; target: InstallationRecord['target'] };

    const record = await findInstallation(wanted.scope, options.cwd, wanted.name, wanted.target);
    if (!record || !record.auto || gone.has(record.id)) continue;

    const dependents = (
      await findDependents(record.scope, options.cwd, record.bundle, record.target)
    ).filter((dependent) => !gone.has(dependent.id));
    if (dependents.length > 0) continue;

    gone.add(record.id);
    orphans.push(record);
    // Its own automatic dependencies may now be unused too.
    for (const dependency of record.dependencies ?? []) {
      queue.push({ name: dependency.name, scope: record.scope, target: record.target });
    }
  }

  if (orphans.length === 0) return;

  log.info('');
  log.info(
    `${options.dryRun ? 'Would remove' : 'Removing'} ${orphans.length} ` +
      'bundle(s) installed only as dependencies: ' +
      [...new Set(orphans.map((record) => record.bundle))].join(', '),
  );

  // Everything this run has taken away, not just the orphans: on a dry run the
  // earlier records are all still in the ledger, and counting them would make
  // each look like a reason to keep the others' shared items.
  const pendingIds = [...gone];
  for (const orphan of orphans) {
    const target = getTarget(orphan.target);
    log.info('');
    log.info(
      `${color.bold(target.title)} ${color.dim(`· ${orphan.scope}`)} ${color.bold(orphan.bundle)}`,
    );
    const done = await rollbackInstallation(orphan, {
      ...options,
      alsoRemoving: pendingIds,
      ...(options.presentTargets ? { presentTargets: options.presentTargets } : {}),
    });
    if (done) log.success(`  uninstalled ${orphan.bundle} from ${target.title}`);
  }
}

function pad(status: string): string {
  return status.padEnd(8);
}
