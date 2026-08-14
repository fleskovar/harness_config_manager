/**
 * Read a bundles file back: register every source it lists, and optionally
 * install them, recreating a setup on another machine.
 */

import path from 'node:path';
import type { ConflictPolicy, Resolution } from '../core/conflicts.js';
import { HcmError } from '../core/errors.js';
import { readTextIfExists } from '../core/fsx.js';
import { color, log } from '../core/logger.js';
import { addToRegistry } from '../core/registry.js';
import type { Scope, TargetOptions } from '../core/types.js';
import { DEFAULT_BUNDLES_FILE } from './export.js';
import { installCommand } from './install.js';

export interface ImportOptions {
  install?: boolean;
  targets?: string[];
  scope: Scope;
  force?: boolean;
  onConflict?: ConflictPolicy;
  dryRun?: boolean;
  /** With --install, leave each bundle's own dependencies alone. */
  noDeps?: boolean;
  /** With --install, what this machine has; see `TargetOptions`. */
  targetOptions?: TargetOptions;
  /**
   * With --install, narrow every bundle in the file to these flavors. Only
   * usable when they all define them -- see `core/flavors.ts`.
   */
  flavors?: string[];
  cwd: string;
}

/** Strip comments and blank lines; everything else is a bundle reference. */
export function parseBundlesFile(contents: string): string[] {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export async function importCommand(file: string | undefined, options: ImportOptions): Promise<void> {
  const target = path.resolve(options.cwd, file ?? DEFAULT_BUNDLES_FILE);
  const contents = await readTextIfExists(target);

  if (contents === undefined) {
    throw new HcmError(`No such file: ${target}`, 'Generate one with "hcm export".');
  }

  const references = parseBundlesFile(contents);
  if (references.length === 0) {
    log.warn(`${target} lists no bundles.`);
    return;
  }

  log.info(`Importing ${references.length} bundle(s) from ${target}`);

  const registered: string[] = [];
  const failed: { reference: string; reason: string }[] = [];

  for (const reference of references) {
    try {
      const entries = await addToRegistry(reference, options.cwd);
      for (const entry of entries) {
        registered.push(entry.name);
        log.success(`  registered ${color.bold(entry.name)} ${color.dim(`v${entry.version}`)}`);
      }
    } catch (error) {
      // Keep going: one unreachable repo should not abandon the whole import.
      failed.push({ reference, reason: (error as Error).message });
      log.error(`  ${reference}: ${(error as Error).message}`);
    }
  }

  if (options.install && registered.length > 0) {
    log.info('');
    // One memory of conflict answers across every bundle in the file.
    const decisions = new Map<string, Resolution>();
    for (const name of registered) {
      await installCommand(name, {
        scope: options.scope,
        cwd: options.cwd,
        decisions,
        ...(options.targets ? { targets: options.targets } : {}),
        ...(options.force ? { force: true } : {}),
        ...(options.onConflict ? { onConflict: options.onConflict } : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.noDeps ? { noDeps: true } : {}),
        ...(options.targetOptions ? { targetOptions: options.targetOptions } : {}),
        ...(options.flavors?.length ? { flavors: options.flavors } : {}),
      });
    }
  }

  log.info('');
  if (failed.length > 0) {
    log.warn(`${registered.length} imported, ${failed.length} failed.`);
    process.exitCode = 1;
    return;
  }
  log.success(
    `${registered.length} bundle(s) imported${options.install ? ' and installed' : ''}.`,
  );
}
