import { color, log } from '../core/logger.js';
import type { Scope } from '../core/types.js';
import { TARGETS } from '../targets/index.js';

/** Show the supported harnesses and where each scope writes on this machine. */
export function targetsCommand(options: { cwd: string }): void {
  for (const target of TARGETS) {
    log.plain(`${color.bold(target.title)} ${color.dim(`(${target.id})`)}`);
    log.plain(color.dim(`  docs:    ${target.docs}`));
    for (const scope of ['project', 'user'] as Scope[]) {
      log.plain(color.dim(`  ${scope.padEnd(8)} ${target.scopeRoot(scope, options.cwd)}`));
    }
    log.plain(color.dim(`  kinds:   ${target.supports.join(', ')}`));
    log.plain('');
  }
}
