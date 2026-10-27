/**
 * Where `hcm update` reads the next version of an installed bundle.
 *
 * Two kinds of software ship bundles, and they need two answers:
 *
 *   - A tool that a machine has once -- a CLI, an MCP server, an app. Its
 *     bundle is registered once, and each project follows the **registry**.
 *     After `npm update -g my-cli`, `hcm registry update` reads the new bundle,
 *     and `hcm update` in a project installs it.
 *   - A library that each project installs into its own environment -- a
 *     `.venv/`, a `node_modules/`. Two projects can pin two versions, so one
 *     registry entry cannot serve both. Each installation follows its own
 *     **source**, and the registry is not read.
 *
 * An installation records the mode only when somebody chose it (`--track`).
 * Otherwise the mode is inferred when `hcm update` runs: registry when a bundle
 * of that name is registered, else source. That is also what every record
 * written before this module existed means.
 */

import path from 'node:path';
import { toPosix } from './fsx.js';
import { describeSource } from './github.js';
import { color, log } from './logger.js';
import { readRegistry } from './registry.js';
import type { BundleSource, InstallationRecord, LoadedBundle, Scope, TrackMode } from './types.js';

export const TRACK_MODES: readonly TrackMode[] = ['registry', 'source'];

/** The mode a record follows: what it recorded, else what its registration implies. */
export function effectiveTrack(
  record: Pick<InstallationRecord, 'track'>,
  registered: boolean,
): TrackMode {
  return record.track ?? (registered ? 'registry' : 'source');
}

/**
 * A local source as a path relative to the project root, when the source is a
 * folder inside the project. Undefined for every other source.
 *
 * A virtual environment or `node_modules/` sits inside the project, at the same
 * relative place in each checkout. The absolute path is different on each
 * machine, so the relative path is the one worth keeping.
 */
export function sourceInProject(
  source: BundleSource,
  scope: Scope,
  cwd: string,
): string | undefined {
  if (scope !== 'project' || source.type !== 'local') return undefined;

  const relative = path.relative(path.resolve(cwd), path.resolve(source.path));
  if (relative === '' || path.isAbsolute(relative)) return undefined;
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return undefined;
  return toPosix(relative);
}

/**
 * The source that `hcm update` reads for a source-tracked record. The
 * project-relative path comes first, so a teammate's checkout reads its own
 * environment and not the folder of the machine that wrote the record.
 */
export function recordedSource(record: InstallationRecord, cwd: string): BundleSource {
  if (record.scope === 'project' && record.sourceInProject) {
    return { type: 'local', path: path.resolve(cwd, ...record.sourceInProject.split('/')) };
  }
  return record.source;
}

/** How to show the source of a record: the project-relative path when there is one. */
export function describeRecordedSource(record: InstallationRecord): string {
  return record.sourceInProject ?? describeSource(record.source);
}

/**
 * True when two sources name the same place. The ref is not compared: a
 * repository registered at `#v1.2.0` and installed at `#v1.3.0` is still the
 * same origin, one release apart.
 */
export function sameOrigin(a: BundleSource, b: BundleSource): boolean {
  if (a.type === 'local' && b.type === 'local') {
    return path.resolve(a.path).toLowerCase() === path.resolve(b.path).toLowerCase();
  }
  if (a.type === 'github' && b.type === 'github') {
    return (
      a.owner.toLowerCase() === b.owner.toLowerCase() &&
      a.repo.toLowerCase() === b.repo.toLowerCase() &&
      (a.subdir ?? '') === (b.subdir ?? '')
    );
  }
  if (a.type === 'git' && b.type === 'git') {
    return a.url === b.url && (a.subdir ?? '') === (b.subdir ?? '');
  }
  return false;
}

/**
 * The registered version of a bundle, when the registry holds a bundle of that
 * name. The built-in bundles are not in the registry file, so they never match.
 */
export async function registeredVersion(
  name: string,
): Promise<{ version?: string; source: BundleSource } | undefined> {
  const entry = (await readRegistry()).entries.find((candidate) => candidate.name === name);
  if (!entry) return undefined;
  return { ...(entry.version ? { version: entry.version } : {}), source: entry.source };
}

/**
 * Say so when a bundle read from its source has a different version from the
 * registered bundle of the same name. Both can be correct: the project pins
 * one version, the machine has another. But "which one do I have?" has two
 * answers now, and the user has to know that.
 */
export async function warnIfRegistryDiffers(bundle: LoadedBundle): Promise<void> {
  const registered = await registeredVersion(bundle.manifest.name);
  if (!registered?.version || registered.version === bundle.manifest.version) return;

  log.warn(
    `  the registry has ${bundle.manifest.name} v${registered.version}, ` +
      `but the source has v${bundle.manifest.version}`,
  );
  log.warn(color.dim(`  source: ${describeSource(bundle.source)}`));
}
