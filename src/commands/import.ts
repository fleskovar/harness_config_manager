/**
 * Read a bundles file back: register every source it lists, and optionally
 * install them, recreating a setup on another machine.
 */

import path from 'node:path';
import { HcmError } from '../core/errors.js';
import { readTextIfExists } from '../core/fsx.js';
import { color, log } from '../core/logger.js';
import { addToRegistry } from '../core/registry.js';
import type { Scope } from '../core/types.js';
import { DEFAULT_BUNDLES_FILE } from './export.js';
import { installCommand } from './install.js';

export interface ImportOptions {
  install?: boolean;
  targets?: string[];
  scope: Scope;
  force?: boolean;
  dryRun?: boolean;
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
    for (const name of registered) {
      await installCommand(name, {
        scope: options.scope,
        cwd: options.cwd,
        ...(options.targets ? { targets: options.targets } : {}),
        ...(options.force ? { force: true } : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
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
