import { spawn } from 'node:child_process';
import { HcmError } from '../core/errors.js';
import { ensureDir } from '../core/fsx.js';
import { describeSource } from '../core/github.js';
import { color, log } from '../core/logger.js';
import { storeDir } from '../core/paths.js';
import { addToRegistry, readRegistry, removeFromRegistry, requireEntry } from '../core/registry.js';
import { storeEntryDir } from '../core/store.js';
import { readState } from '../core/state.js';
import type { RegistryEntry, Scope } from '../core/types.js';

export async function registryAddCommand(
  source: string,
  options: { name?: string; dev?: boolean; cwd: string },
): Promise<void> {
  const entries = await addToRegistry(source, options.cwd, {
    name: options.name,
    dev: options.dev,
  });

  for (const entry of entries) {
    const mode = entry.dev ? color.yellow(' [dev]') : '';
    log.success(
      `Registered ${color.dim(`[${entry.id}]`)} ${color.bold(entry.name)} v${entry.version}${mode} ` +
        `${color.dim(describeSource(entry.source))}`,
    );
  }

  if (entries.some((entry) => entry.dev)) {
    log.info(
      color.dim(
        'Dev bundles are read from that directory every time, so edit and re-run "hcm install" freely.',
      ),
    );
  } else {
    log.info(
      color.dim('Copied into the store; run "hcm update" to pick up later changes at the source.'),
    );
  }

  const ids = entries.map((entry) => entry.id);
  log.info(
    color.dim(
      ids.length === 1
        ? `Install it with: hcm install ${ids[0]}`
        : `Install them with: ${ids.map((id) => `hcm install ${id}`).join(' && ')}`,
    ),
  );
}

export async function registryRemoveCommand(
  references: string[],
  options: { cwd: string },
): Promise<void> {
  for (const reference of references) {
    const removed = await removeFromRegistry(reference);
    if (!removed) throw new HcmError(`"${reference}" is not registered`);

    const { entry, storeRemoved } = removed;
    log.success(`Removed ${color.dim(`[${entry.id}]`)} ${color.bold(entry.name)}`);

    if (storeRemoved) log.info(color.dim(`  deleted the stored copy (${entry.store})`));
    else if (entry.dev) {
      log.info(color.dim(`  left your working copy alone (${describeSource(entry.source)})`));
    }

    const installed = await installationsOf(entry.name, options.cwd);
    if (installed.length > 0) {
      log.warn(
        `  still installed in ${installed.join(', ')} — ` +
          `run "hcm uninstall ${entry.name}" to remove those items.`,
      );
    }
  }
}

/** Where a bundle is currently installed, as "target (scope)" labels. */
async function installationsOf(bundle: string, cwd: string): Promise<string[]> {
  const labels: string[] = [];
  for (const scope of ['project', 'user'] as Scope[]) {
    const state = await readState(scope, cwd);
    for (const record of state.installations) {
      if (record.bundle === bundle) labels.push(`${record.target} (${scope})`);
    }
  }
  return labels;
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

  const width = Math.max(...registry.entries.map((entry) => entry.id.length));

  for (const entry of registry.entries) {
    const mode = entry.dev ? color.yellow(' [dev]') : '';
    log.plain(
      `${color.dim(entry.id.padStart(width))}  ${color.bold(entry.name)} ` +
        `${color.dim(`v${entry.version ?? '?'}`)}${mode}`,
    );
    log.plain(`  ${' '.repeat(width)}${color.dim(describeSource(entry.source))}`);
  }
}

/**
 * Show -- and open -- the store: the one directory holding every registered
 * bundle's files. With a reference, opens that bundle's folder instead.
 */
export async function registryOpenCommand(
  reference: string | undefined,
  options: { open?: boolean },
): Promise<void> {
  const target = reference ? await bundleDir(reference) : await storeDir();

  // Opening a directory that does not exist yet fails on every platform, and a
  // fresh install has never written the store.
  await ensureDir(target);
  log.plain(target);

  if (options.open === false) return;

  const opened = await openInFileManager(target);
  if (!opened) {
    log.info(color.dim('Could not open a file manager here; the path is printed above.'));
  }
}

/** The directory a registered bundle's files live in, dev or stored. */
async function bundleDir(reference: string): Promise<string> {
  const entry = await requireEntry(reference);
  if (entry.dev) return devPath(entry);
  if (entry.store) return storeEntryDir(entry.store);

  throw new HcmError(
    `"${entry.name}" has no directory in the store`,
    'Run "hcm update ' + entry.id + '" to populate it.',
  );
}

function devPath(entry: RegistryEntry): string {
  if (entry.source.type !== 'local') {
    throw new HcmError(`"${entry.name}" is marked dev but has no local path`);
  }
  return entry.source.path;
}

/** Hand a directory to the platform's file manager. Never throws. */
function openInFileManager(target: string): Promise<boolean> {
  const [command, args] =
    process.platform === 'win32'
      ? ['explorer.exe', [target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];

  return new Promise((resolve) => {
    try {
      const child = spawn(command as string, args as string[], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', () => resolve(false));
      child.unref();
      // Explorer returns a non-zero exit code even when it worked, so a
      // successful spawn is as much confirmation as we are going to get.
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}
