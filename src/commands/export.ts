/**
 * Export the current setup as a plain list of bundle sources.
 *
 * Only GitHub-backed bundles are exported: a local path means nothing on
 * another machine, so those are reported as skipped rather than written out.
 */

import path from 'node:path';
import { describeSource } from '../core/github.js';
import { color, log } from '../core/logger.js';
import { readRegistry } from '../core/registry.js';
import { readState } from '../core/state.js';
import { writeText } from '../core/fsx.js';
import type { BundleSource, Scope } from '../core/types.js';

export const DEFAULT_BUNDLES_FILE = 'bundles.txt';

export interface ExportOptions {
  /** Export the registry rather than what is installed here. */
  registry?: boolean;
  scope?: Scope | 'all';
  /** Write to stdout instead of a file. */
  stdout?: boolean;
  cwd: string;
}

/** The reference form we write out, which `hcm import` can read back. */
export function sourceToReference(source: BundleSource): string | undefined {
  if (source.type !== 'github') return undefined;
  const subdir = source.subdir ? `/${source.subdir}` : '';
  const ref = source.ref && source.ref !== 'HEAD' ? `#${source.ref}` : '';
  return `${source.owner}/${source.repo}${subdir}${ref}`;
}

export async function exportCommand(file: string | undefined, options: ExportOptions): Promise<void> {
  const collected = options.registry
    ? await collectFromRegistry()
    : await collectFromState(options);

  const lines: string[] = [
    '# hcm bundles file',
    `# generated ${new Date().toISOString()}`,
    `# source: ${options.registry ? 'local registry' : `installed bundles (${options.scope ?? 'all'} scope)`}`,
    '#',
    '# Recreate this setup with:  hcm import bundles.txt --install',
    '',
  ];

  for (const item of collected.exported) {
    if (item.note) lines.push(`# ${item.note}`);
    lines.push(item.reference);
  }

  if (collected.exported.length === 0) {
    lines.push('# (nothing to export)');
  }

  const contents = `${lines.join('\n')}\n`;

  if (options.stdout) {
    log.plain(contents.trimEnd());
  } else {
    const target = path.resolve(options.cwd, file ?? DEFAULT_BUNDLES_FILE);
    await writeText(target, contents);
    log.success(`Wrote ${collected.exported.length} bundle(s) to ${target}`);
  }

  if (collected.skipped.length > 0) {
    log.warn(
      `Skipped ${collected.skipped.length} local bundle(s), which cannot be fetched elsewhere:`,
    );
    for (const skipped of collected.skipped) {
      log.plain(color.dim(`  ${skipped.name} (${skipped.location})`));
    }
  }
}

interface Collected {
  exported: { reference: string; note?: string }[];
  skipped: { name: string; location: string }[];
}

async function collectFromRegistry(): Promise<Collected> {
  const registry = await readRegistry();
  const exported: Collected['exported'] = [];
  const skipped: Collected['skipped'] = [];

  for (const entry of registry.entries) {
    const reference = sourceToReference(entry.source);
    if (!reference) {
      skipped.push({ name: entry.name, location: describeSource(entry.source) });
      continue;
    }
    exported.push({
      reference,
      ...(entry.description ? { note: `${entry.name} - ${entry.description}` } : { note: entry.name }),
    });
  }

  return { exported, skipped };
}

async function collectFromState(options: ExportOptions): Promise<Collected> {
  const scopes: Scope[] =
    options.scope === 'all' || options.scope === undefined ? ['project', 'user'] : [options.scope];

  const exported: Collected['exported'] = [];
  const skipped: Collected['skipped'] = [];
  // One bundle can be installed into several targets; export it once, but
  // record every target so the note explains what the setup actually was.
  const seen = new Map<
    string,
    { source: BundleSource; targets: string[]; version: string; flavors?: string[] }
  >();

  for (const scope of scopes) {
    const state = await readState(scope, options.cwd);
    for (const record of state.installations) {
      const existing = seen.get(record.bundle);
      if (existing) {
        if (!existing.targets.includes(record.target)) existing.targets.push(record.target);
        continue;
      }
      seen.set(record.bundle, {
        source: record.source,
        targets: [record.target],
        version: record.version,
        ...(record.flavors?.length ? { flavors: record.flavors } : {}),
      });
    }
  }

  for (const [name, info] of seen) {
    const reference = sourceToReference(info.source);
    if (!reference) {
      skipped.push({ name, location: describeSource(info.source) });
      continue;
    }
    // The file is a list of sources, with no room to say "part of this one" --
    // so a narrowed install is recorded in the comment, for whoever reads it to
    // pass `--flavor` themselves.
    const part = info.flavors?.length ? ` (installed as: --flavor ${info.flavors.join(' ')})` : '';
    exported.push({
      reference,
      note: `${name} v${info.version} -> ${info.targets.join(', ')}${part}`,
    });
  }

  return { exported, skipped };
}
