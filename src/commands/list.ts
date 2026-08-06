import { describeSource } from '../core/github.js';
import { color, log } from '../core/logger.js';
import { readRegistry } from '../core/registry.js';
import { readState } from '../core/state.js';
import type { InstallationRecord, Scope } from '../core/types.js';

export interface ListOptions {
  installed?: boolean;
  scope?: Scope | 'all';
  json?: boolean;
  cwd: string;
}

export async function listCommand(options: ListOptions): Promise<void> {
  if (options.installed) return listInstalled(options);
  return listAvailable(options);
}

async function listAvailable(options: ListOptions): Promise<void> {
  const registry = await readRegistry();

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
        registry.entries.map((entry) => ({ ...entry, installed: installed.has(entry.name) })),
        null,
        2,
      ),
    );
    return;
  }

  if (registry.entries.length === 0) {
    log.info('No bundles registered.');
    log.info(color.dim('Add one with: hcm registry add <path|owner/repo>'));
    return;
  }

  const width = Math.max(...registry.entries.map((entry) => entry.name.length));

  for (const entry of registry.entries) {
    const marker = installed.has(entry.name) ? color.green('●') : color.dim('○');
    const version = entry.version ? color.dim(` v${entry.version}`) : '';
    log.plain(`${marker} ${color.bold(entry.name.padEnd(width))}${version}`);
    if (entry.description) log.plain(`  ${color.dim(entry.description)}`);
    log.plain(`  ${color.dim(describeSource(entry.source))}`);
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
      log.plain(
        `  ${color.green('●')} ${color.bold(record.bundle)} ${color.dim(`v${record.version}`)} ` +
          `→ ${record.target} ${color.dim(`· ${record.receipts.length} item(s) · ${when}`)}`,
      );
    }
  }
}
