import { HcmError } from '../core/errors.js';
import { describeSource } from '../core/github.js';
import { color, log } from '../core/logger.js';
import { addToRegistry, readRegistry, removeFromRegistry } from '../core/registry.js';

export async function registryAddCommand(
  source: string,
  options: { name?: string; cwd: string },
): Promise<void> {
  const entry = await addToRegistry(source, options.cwd, { name: options.name });
  log.success(
    `Registered ${color.bold(entry.name)} v${entry.version} ${color.dim(describeSource(entry.source))}`,
  );
  log.info(color.dim(`Install it with: hcm install ${entry.name}`));
}

export async function registryRemoveCommand(name: string): Promise<void> {
  const removed = await removeFromRegistry(name);
  if (!removed) throw new HcmError(`"${name}" is not registered`);
  log.success(`Unregistered ${name}`);
  log.info(color.dim('Already-installed copies are untouched; use "hcm uninstall" for those.'));
}

export async function registryListCommand(options: { json?: boolean }): Promise<void> {
  const registry = await readRegistry();

  if (options.json) {
    log.plain(JSON.stringify(registry.entries, null, 2));
    return;
  }

  if (registry.entries.length === 0) {
    log.info('No bundles registered.');
    return;
  }

  for (const entry of registry.entries) {
    log.plain(`${color.bold(entry.name)} ${color.dim(`v${entry.version ?? '?'}`)}`);
    log.plain(`  ${color.dim(describeSource(entry.source))}`);
  }
}
