import path from 'node:path';
import { type AnalyzedEntry, type AnalyzedInstallation, analyzeInstallations } from '../core/analysis.js';
import { flavorNames } from '../core/flavors.js';
import { writeText } from '../core/fsx.js';
import { parameterNames } from '../core/parameters.js';
import { describeSource } from '../core/github.js';
import { color, log } from '../core/logger.js';
import { availableEntries, liveEntries } from '../core/registry.js';
import { collectClaims, readState } from '../core/state.js';
import { describeRecordedSource, effectiveTrack } from '../core/tracking.js';
import type { InstallationRecord, RegistryEntry, Scope, TargetId } from '../core/types.js';
import { getTarget } from '../targets/index.js';

export interface ListOptions {
  installed?: boolean;
  /** `--analysis`: each installed bundle, its items, and the files of each item. */
  analysis?: boolean;
  scope?: Scope | 'all';
  json?: boolean;
  descriptions?: boolean;
  /** `--verbose`: also show the source, flavors and parameters of each bundle. */
  verbose?: boolean;
  /** `--output`: write the listing to this file, relative to `cwd`, not to the console. */
  output?: string;
  cwd: string;
}

/**
 * Where a listing goes. `plain` lines are the listing. `info` lines are notes
 * about it, and `--quiet` stops them on the console.
 */
interface Output {
  plain(text: string): void;
  info(text: string): void;
}

export async function listCommand(options: ListOptions): Promise<void> {
  const lines: string[] = [];
  const out: Output = options.output
    ? { plain: (text) => lines.push(text), info: (text) => lines.push(text) }
    : { plain: (text) => log.plain(text), info: (text) => log.info(text) };

  if (options.analysis) await listAnalysis(options, out);
  else if (options.installed) await listInstalled(options, out);
  else await listAvailable(options, out);

  if (options.output) await writeListing(options.output, lines, options.cwd);
}

/** Write the lines to a file, without colors, and say where they went. */
async function writeListing(output: string, lines: string[], cwd: string): Promise<void> {
  const file = path.resolve(cwd, output);
  // eslint-disable-next-line no-control-regex
  const text = lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  await writeText(file, `${text}\n`);
  log.success(`Wrote the listing to ${file}`);
}

/** The scopes that `--scope` names. Absent or `all` means both. */
function scopesOf(options: ListOptions): Scope[] {
  return options.scope === 'all' || options.scope === undefined ? ['project', 'user'] : [options.scope];
}

/**
 * What every installed bundle brings: one block per bundle and scope, then
 * one per harness, then each item with its files and entries.
 */
async function listAnalysis(options: ListOptions, out: Output): Promise<void> {
  const scopes = scopesOf(options);
  const records: InstallationRecord[] = [];
  for (const scope of scopes) records.push(...(await readState(scope, options.cwd)).installations);

  const analysis = analyzeInstallations(records, await collectClaims(options.cwd), options.cwd);

  if (options.json) {
    out.plain(JSON.stringify(analysis, null, 2));
    return;
  }

  if (analysis.length === 0) {
    out.info(`No bundles installed in ${scopes.join(' or ')} scope.`);
    return;
  }

  for (const scope of scopes) {
    const scoped = analysis.filter((installation) => installation.scope === scope);
    if (scoped.length === 0) continue;

    out.plain(color.bold(`${scope} scope`));
    const bundles = [...new Set(scoped.map((installation) => installation.bundle))].sort();
    for (const bundle of bundles) {
      const installations = scoped.filter((installation) => installation.bundle === bundle);
      printBundleAnalysis(installations, out);
    }
    out.plain('');
  }

  if (analysis.some((installation) => installation.items.some((item) => item.kind === 'unknown'))) {
    out.info(
      color.dim(
        'An "unsorted" item holds files from an install by an older hcm. ' +
          'To sort them by item, run "hcm update".',
      ),
    );
  }
}

/** One bundle in one scope: the installations of each harness, item by item. */
function printBundleAnalysis(installations: AnalyzedInstallation[], out: Output): void {
  const [first] = installations;
  if (!first) return;

  const versions = [...new Set(installations.map((installation) => `v${installation.version}`))];
  out.plain(`\n  ${color.bold(first.bundle)} ${color.dim(versions.join(', '))}`);

  for (const installation of installations) {
    const entries = installation.items.reduce((total, item) => total + item.entries.length, 0);
    out.plain(
      `    ${getTarget(installation.target).title} ` +
        color.dim(
          `· ${count(installation.items.length, 'item', 'items')}, ${count(entries, 'entry', 'entries')}`,
        ),
    );
    for (const item of installation.items) {
      const label = item.kind === 'unknown' ? 'unsorted' : `${item.kind} ${item.name}`;
      out.plain(`      ${color.cyan(label)}`);
      for (const entry of item.entries) out.plain(`        ${entry.location}${entryNotes(entry)}`);
    }
  }
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The marks after an entry: adopted, or claimed by another bundle too. */
function entryNotes(entry: AnalyzedEntry): string {
  const notes: string[] = [];
  if (entry.adopted) notes.push(color.dim(' (there before hcm: not removed on uninstall)'));
  if (entry.sharedWith.length > 0) {
    notes.push(color.yellow(` (also claimed by ${entry.sharedWith.join(', ')})`));
  }
  return notes.join('');
}

/**
 * Where a registered bundle stands in the current project:
 *
 * - `installed`: installed here, and `hcm update` reads it from the registry.
 * - `local`: installed here, but from a source of this project. See `LocalBundle`.
 * - `user`: not installed here, but installed in the user scope.
 * - `absent`: not installed here or in the user scope.
 */
export type ProjectStatus = 'installed' | 'local' | 'user' | 'absent';

/**
 * A bundle that the current project installed from its own source, not from
 * the registry. Usually a library of the project ships it, for example in
 * `.venv/` or `node_modules/`. Each project can have a different version.
 */
export interface LocalBundle {
  name: string;
  version: string;
  /** The source that `hcm update` reads, as `describeRecordedSource` shows it. */
  source: string;
  targets: TargetId[];
  flavors: string[];
  /** Installed only because another bundle requires it. */
  auto: boolean;
}

/** Registry entries by bundle name. The first entry of a name wins, as in lookups. */
function entriesByName(entries: RegistryEntry[]): Map<string, RegistryEntry> {
  const byName = new Map<string, RegistryEntry>();
  for (const entry of entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }
  return byName;
}

/**
 * True when `hcm update` reads this installation from its own source, not from
 * the registry. A built-in bundle always comes with hcm, so it never does.
 */
export function followsItsSource(record: InstallationRecord, entry?: RegistryEntry): boolean {
  return !entry?.builtin && effectiveTrack(record, entry !== undefined) === 'source';
}

/**
 * The bundles of the project that follow their own source, one per bundle name.
 * A bundle installed into several harnesses has one record per harness.
 */
export function localBundles(
  projectRecords: InstallationRecord[],
  entries: RegistryEntry[],
): LocalBundle[] {
  const registered = entriesByName(entries);
  const byName = new Map<string, LocalBundle>();

  for (const record of projectRecords) {
    if (!followsItsSource(record, registered.get(record.bundle))) continue;

    const known = byName.get(record.bundle);
    if (known) {
      if (!known.targets.includes(record.target)) known.targets.push(record.target);
      known.auto &&= record.auto === true;
      continue;
    }
    byName.set(record.bundle, {
      name: record.bundle,
      version: record.version,
      source: describeRecordedSource(record),
      targets: [record.target],
      flavors: record.flavors ?? [],
      auto: record.auto === true,
    });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The status of each registry entry in the current project, by bundle name. */
export function projectStatuses(
  entries: RegistryEntry[],
  projectRecords: InstallationRecord[],
  userRecords: InstallationRecord[],
): Map<string, ProjectStatus> {
  const registered = entriesByName(entries);
  const fromRegistry = new Set<string>();
  const fromSource = new Set<string>();
  for (const record of projectRecords) {
    const followed = followsItsSource(record, registered.get(record.bundle));
    (followed ? fromSource : fromRegistry).add(record.bundle);
  }
  const inUserScope = new Set(userRecords.map((record) => record.bundle));

  const statuses = new Map<string, ProjectStatus>();
  for (const { name } of entries) {
    if (fromRegistry.has(name)) statuses.set(name, 'installed');
    else if (fromSource.has(name)) statuses.set(name, 'local');
    else if (inUserScope.has(name)) statuses.set(name, 'user');
    else statuses.set(name, 'absent');
  }
  return statuses;
}

async function listAvailable(options: ListOptions, out: Output): Promise<void> {
  // A dev entry is a pointer at a working copy, not a copy of it, so what it
  // offers today is in its manifest rather than in the registry. See liveEntry.
  const entries = await liveEntries(await availableEntries());
  const projectRecords = (await readState('project', options.cwd)).installations;
  const userRecords = (await readState('user', options.cwd)).installations;

  if (options.json) {
    // Unchanged for scripts: "installed" means installed in either scope.
    const installed = new Set([...projectRecords, ...userRecords].map((record) => record.bundle));
    out.plain(
      JSON.stringify(
        entries.map((entry) => ({ ...entry, installed: installed.has(entry.name) })),
        null,
        2,
      ),
    );
    return;
  }

  const local = localBundles(projectRecords, entries);

  if (entries.length === 0) {
    out.info('No bundles registered.');
    out.info(color.dim('Add one with: hcm registry add <path|owner/repo>'));
  } else if (options.verbose) {
    printDetailedEntries(entries, [...projectRecords, ...userRecords], options, out);
  } else {
    printCompactEntries(entries, projectStatuses(entries, projectRecords, userRecords), options, out);
  }

  if (local.length > 0) printLocalBundles(local, entries, options, out);

  if (!options.verbose && entries.length > 0) {
    out.info('');
    out.info(color.dim('For sources, flavors and parameters, run "hcm list --verbose".'));
  }
}

const STATUS_LABELS: Record<ProjectStatus, string> = {
  installed: color.green('installed'),
  local: color.green('installed (local source)'),
  user: color.dim('installed in user scope only'),
  absent: color.dim('not installed'),
};

/** One line per registry entry: the id, the name and the status in this project. */
function printCompactEntries(
  entries: RegistryEntry[],
  statuses: Map<string, ProjectStatus>,
  options: ListOptions,
  out: Output,
): void {
  const idWidth = Math.max(...entries.map((entry) => entry.id.length));
  const nameWidth = Math.max(...entries.map((entry) => entry.name.length));

  out.plain(color.bold('Registry'));
  for (const entry of entries) {
    const status = statuses.get(entry.name) ?? 'absent';
    const here = status === 'installed' || status === 'local';
    const marker = here ? color.green('●') : color.dim('○');
    out.plain(
      `  ${marker} ${color.dim(entry.id.padStart(idWidth))}  ` +
        `${color.bold(entry.name.padEnd(nameWidth))}  ${STATUS_LABELS[status]}${entryMode(entry)}`,
    );
    if (options.descriptions && entry.description) {
      out.plain(`${' '.repeat(idWidth + 6)}${color.dim(entry.description)}`);
    }
  }
}

/**
 * The full listing: version, source, flavors and parameters of each entry. A
 * `●` marks a bundle that is installed in the project or in the user scope.
 */
function printDetailedEntries(
  entries: RegistryEntry[],
  records: InstallationRecord[],
  options: ListOptions,
  out: Output,
): void {
  const installed = new Set(records.map((record) => record.bundle));
  const nameWidth = Math.max(...entries.map((entry) => entry.name.length));
  const idWidth = Math.max(...entries.map((entry) => entry.id.length));

  out.plain(color.bold('Registry'));
  for (const entry of entries) {
    const marker = installed.has(entry.name) ? color.green('●') : color.dim('○');
    const version = entry.version ? color.dim(` v${entry.version}`) : '';
    const mode = entryMode(entry);
    out.plain(
      `${marker} ${color.dim(entry.id.padStart(idWidth))}  ` +
        `${color.bold(entry.name.padEnd(nameWidth))}${version}${mode}`,
    );
    const indent = ' '.repeat(idWidth + 4);
    if (options.descriptions && entry.description) {
      out.plain(`${indent}${color.dim(entry.description)}`);
    }
    out.plain(`${indent}${color.dim(describeSource(entry.source))}`);
    // The parts it can be installed as -- "what can I install?" has a longer
    // answer than the name for a bundle that offers flavors.
    if (entry.flavors?.length) {
      out.plain(`${indent}${color.dim(`flavors: ${flavorNames(entry.flavors)}`)}`);
    }
    // And what installing it will ask for, for the same reason.
    if (entry.parameters?.length) {
      out.plain(`${indent}${color.dim(`parameters: ${parameterNames(entry.parameters)}`)}`);
    }
  }
}

/**
 * The bundles that belong to this project and not to the registry. They are
 * not in the registry list, or the registry list does not show where they
 * come from, so they get a section of their own.
 */
function printLocalBundles(
  local: LocalBundle[],
  entries: RegistryEntry[],
  options: ListOptions,
  out: Output,
): void {
  const registered = entriesByName(entries);
  const nameWidth = Math.max(...local.map((bundle) => bundle.name.length));
  const versionWidth = Math.max(...local.map((bundle) => bundle.version.length + 1));

  out.plain(
    `\n${color.bold('Local bundles')} ` +
      color.dim('(from the dependencies of this project, not from the registry)'),
  );
  for (const bundle of local) {
    const why = bundle.auto ? color.dim(' [dependency]') : '';
    const version = `v${bundle.version}`.padEnd(versionWidth);

    if (!options.verbose) {
      out.plain(
        `  ${color.green('●')} ${color.bold(bundle.name.padEnd(nameWidth))}  ` +
          `${color.dim(version)}  ${color.dim(bundle.source)}${why}`,
      );
      continue;
    }

    const part = bundle.flavors.length ? color.yellow(` [${bundle.flavors.join(', ')}]`) : '';
    out.plain(
      `  ${color.green('●')} ${color.bold(bundle.name)} ${color.dim(`v${bundle.version}`)}${why}${part}`,
    );
    const entry = registered.get(bundle.name);
    const gap =
      entry?.version && entry.version !== bundle.version
        ? color.yellow(` · the registry has v${entry.version}`)
        : '';
    out.plain(`      ${color.dim(`follows ${bundle.source}`)}${gap}`);
    out.plain(`      ${color.dim(`→ ${bundle.targets.join(', ')}`)}`);
  }
}

/** How an entry is read: `[dev]` from a working copy, `[built-in]` from hcm itself. */
export function entryMode(entry: RegistryEntry): string {
  if (entry.builtin) return color.cyan(' [built-in]');
  return entry.dev ? color.yellow(' [dev]') : '';
}

async function listInstalled(options: ListOptions, out: Output): Promise<void> {
  const scopes = scopesOf(options);

  const rows: InstallationRecord[] = [];
  for (const scope of scopes) {
    const state = await readState(scope, options.cwd);
    rows.push(...state.installations);
  }

  if (options.json) {
    out.plain(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    out.info(`No bundles installed in ${scopes.join(' or ')} scope.`);
    return;
  }

  // Registered versions by name, to show where `hcm update` reads each one
  // and when a pinned source has drifted from the registry.
  const registered = entriesByName(await availableEntries());

  for (const scope of scopes) {
    const scoped = rows.filter((record) => record.scope === scope);
    if (scoped.length === 0) continue;

    out.plain(color.bold(`\n${scope} scope`));
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
      // Where `hcm update` reads the next version, when that is not the registry.
      const entry = registered.get(record.bundle);
      const follows = followsItsSource(record, entry);
      const mode = follows ? color.magenta(' [source]') : '';
      out.plain(
        `  ${color.green('●')} ${color.bold(record.bundle)} ${color.dim(`v${record.version}`)}${why}${part}${mode} ` +
          `→ ${record.target} ${color.dim(`· ${record.receipts.length} item(s) · ${when}`)}${needs}`,
      );
      if (follows) {
        const gap =
          entry?.version && entry.version !== record.version
            ? color.yellow(` · the registry has v${entry.version}`)
            : '';
        out.plain(`      ${color.dim(`follows ${describeRecordedSource(record)}`)}${gap}`);
      }
      // The values its templates were rendered with, and what `hcm update`
      // will render the next version with unless it is told otherwise.
      const parameters = Object.entries(record.parameters ?? {});
      if (parameters.length > 0) {
        out.plain(
          color.dim(
            `      ${parameters.map(([name, value]) => `${name}=${value}`).join('  ')}`,
          ),
        );
      }
    }
  }
}
