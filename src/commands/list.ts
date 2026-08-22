import { flavorNames } from '../core/flavors.js';
import { parameterNames } from '../core/parameters.js';
import { describeSource } from '../core/github.js';
import { color, log } from '../core/logger.js';
import { liveEntries, readRegistry } from '../core/registry.js';
import { readState } from '../core/state.js';
import type { InstallationRecord, Scope } from '../core/types.js';

export interface ListOptions {
  installed?: boolean;
  scope?: Scope | 'all';
  json?: boolean;
  descriptions?: boolean;
  cwd: string;
}

export async function listCommand(options: ListOptions): Promise<void> {
  if (options.installed) return listInstalled(options);
  return listAvailable(options);
}

async function listAvailable(options: ListOptions): Promise<void> {
  const registry = await readRegistry();
  // A dev entry is a pointer at a working copy, not a copy of it, so what it
  // offers today is in its manifest rather than in the registry. See liveEntry.
  const entries = await liveEntries(registry.entries);

  // Mark which registered bundles are installed somewhere, so one listing answers
  // both "what can I install?" and "what is already here?".
  const installed = new Set<string>();
  for (const scope of ['project', 'user'] as Scope[]) {
    const state = await readState(scope, options.cwd);
    for (const record of state.installations) installed.add(record.bundle);
  }

  if (options.json) {
    log.plain(
      JSON.stringify(
        entries.map((entry) => ({ ...entry, installed: installed.has(entry.name) })),
        null,
        2,
      ),
    );
    return;
  }

  if (entries.length === 0) {
    log.info('No bundles registered.');
    log.info(color.dim('Add one with: hcm registry add <path|owner/repo>'));
    return;
  }

  const nameWidth = Math.max(...entries.map((entry) => entry.name.length));
  const idWidth = Math.max(...entries.map((entry) => entry.id.length));

  for (const entry of entries) {
    const marker = installed.has(entry.name) ? color.green('●') : color.dim('○');
    const version = entry.version ? color.dim(` v${entry.version}`) : '';
    const mode = entry.dev ? color.yellow(' [dev]') : '';
    log.plain(
      `${marker} ${color.dim(entry.id.padStart(idWidth))}  ` +
        `${color.bold(entry.name.padEnd(nameWidth))}${version}${mode}`,
    );
    const indent = ' '.repeat(idWidth + 4);
    if (options.descriptions && entry.description) {
      log.plain(`${indent}${color.dim(entry.description)}`);
    }
    log.plain(`${indent}${color.dim(describeSource(entry.source))}`);
    // The parts it can be installed as -- "what can I install?" has a longer
    // answer than the name for a bundle that offers flavors.
    if (entry.flavors?.length) {
      log.plain(`${indent}${color.dim(`flavors: ${flavorNames(entry.flavors)}`)}`);
    }
    // And what installing it will ask for, for the same reason.
    if (entry.parameters?.length) {
      log.plain(`${indent}${color.dim(`parameters: ${parameterNames(entry.parameters)}`)}`);
    }
  }
}

async function listInstalled(options: ListOptions): Promise<void> {
  const scopes: Scope[] =
    options.scope === 'all' || options.scope === undefined ? ['project', 'user'] : [options.scope];

  const rows: InstallationRecord[] = [];
  for (const scope of scopes) {
    const state = await readState(scope, options.cwd);
    rows.push(...state.installations);
  }

  if (options.json) {
    log.plain(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    log.info(`No bundles installed in ${scopes.join(' or ')} scope.`);
    return;
  }

  for (const scope of scopes) {
    const scoped = rows.filter((record) => record.scope === scope);
    if (scoped.length === 0) continue;

    log.plain(color.bold(`\n${scope} scope`));
    for (const record of scoped) {
      const when = record.installedAt.slice(0, 10);
      // A bundle nobody asked for by name is here for something else's sake,
      // and goes when that something else does.
      const why = record.auto ? color.dim(' [dependency]') : '';
      const needs = record.dependencies?.length
        ? color.dim(` · requires ${record.dependencies.map((d) => d.name).join(', ')}`)
        : '';
      // Part of a bundle rather than all of it: without this the item count is
      // the only clue, and it is not one anybody can read.
      const part = record.flavors?.length
        ? color.yellow(` [${record.flavors.join(', ')}]`)
        : '';
      log.plain(
        `  ${color.green('●')} ${color.bold(record.bundle)} ${color.dim(`v${record.version}`)}${why}${part} ` +
          `→ ${record.target} ${color.dim(`· ${record.receipts.length} item(s) · ${when}`)}${needs}`,
      );
      // The values its templates were rendered with, and what `hcm update`
      // will render the next version with unless it is told otherwise.
      const parameters = Object.entries(record.parameters ?? {});
      if (parameters.length > 0) {
        log.plain(
          color.dim(
            `      ${parameters.map(([name, value]) => `${name}=${value}`).join('  ')}`,
          ),
        );
      }
    }
  }
}
