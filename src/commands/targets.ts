import { detectHarnesses, type HarnessPresence, describeEvidence } from '../core/harnesses.js';
import { color, log } from '../core/logger.js';
import { allSharedFiles } from '../core/overlap.js';
import type { Scope } from '../core/types.js';
import { getTarget, TARGETS } from '../targets/index.js';

/**
 * Show the supported harnesses and where each scope writes on this machine --
 * and, since a folder can be used by several of them at once, which ones are
 * actually set up here and which files they would be sharing.
 */
export async function targetsCommand(options: { cwd: string }): Promise<void> {
  const detected = await detectHarnesses('project', options.cwd);
  const found = new Map(detected.map((harness) => [harness.target, harness]));

  for (const target of TARGETS) {
    const here = found.get(target.id);
    const mark = here ? `${color.green(' ●')} ${color.dim('in this folder')}` : '';
    log.plain(`${color.bold(target.title)} ${color.dim(`(${target.id})`)}${mark}`);
    log.plain(color.dim(`  docs:    ${target.docs}`));
    for (const scope of ['project', 'user'] as Scope[]) {
      log.plain(color.dim(`  ${scope.padEnd(8)} ${target.scopeRoot(scope, options.cwd)}`));
    }
    log.plain(color.dim(`  kinds:   ${target.supports.join(', ')}`));
    if (here) log.plain(color.dim(`  found:   ${describeEvidence(here)}`));
    for (const [index, note] of (target.notes ?? []).entries()) {
      log.plain(color.dim(`  ${index === 0 ? 'note:   ' : '        '} ${note}`));
    }
    log.plain('');
  }

  reportSharedFiles(detected, options.cwd);
}

/**
 * The files that are not any one harness's.
 *
 * Listed for the harnesses actually here rather than for all five, because that
 * is the list that matters: an overlap between two harnesses you do not use is
 * a fact about the world, not about this folder.
 */
function reportSharedFiles(detected: HarnessPresence[], cwd: string): void {
  if (detected.length < 2) return;

  const here = new Set(detected.map((harness) => harness.target));
  const shared = allSharedFiles('project', cwd).filter((file) => {
    const readers = new Set(file.readers.map((reader) => reader.target));
    return [...readers].filter((id) => here.has(id)).length > 1;
  });

  log.plain(color.bold('Shared between the harnesses in this folder'));
  if (shared.length === 0) {
    log.plain(color.dim('  nothing: each of them writes only its own files'));
    return;
  }

  for (const file of shared) {
    const readers = file.readers
      .filter((reader) => here.has(reader.target))
      .map((reader) => `${getTarget(reader.target).title} (${reader.kinds.join(', ')})`);
    log.plain(`  ${color.bold(file.readers[0]?.path ?? file.key)}  ${color.dim(readers.join(' · '))}`);
  }

  log.plain('');
  log.plain(
    color.dim(
      '  One file, several readers: what one harness installs there the others also see, ' +
        'and it is removed only when the last bundle claiming it is uninstalled.',
    ),
  );
}
