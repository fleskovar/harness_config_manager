/**
 * `hcm install -r [file]`: install the bundles that a project's requirements
 * file lists. See `core/requirements.ts` for the file.
 *
 * The run has two phases. First, every line is read and every source is
 * downloaded, and each named bundle is found. Then the bundles are installed.
 * Thus a typing error on the last line stops the run before the first bundle
 * is written.
 */

import path from 'node:path';
import type { Resolution } from '../core/conflicts.js';
import { HcmError } from '../core/errors.js';
import { readTextIfExists } from '../core/fsx.js';
import { sourceReference } from '../core/github.js';
import { color, log } from '../core/logger.js';
import { availableEntries, matchEntry } from '../core/registry.js';
import {
  DEFAULT_REQUIREMENTS_FILE,
  locateRequirement,
  parseRequirements,
  type Requirement,
} from '../core/requirements.js';
import type { BundleSource } from '../core/types.js';
import { type InstallOptions, installCommand } from './install.js';

export type RequirementsInstallOptions = Omit<InstallOptions, 'track'>;

/** One line, ready to install: the reference that `installCommand` reads. */
interface ResolvedRequirement {
  requirement: Requirement;
  reference: string;
  /** Where the bundle came from, for the log. Absent for the registry. */
  source?: BundleSource;
}

export async function installRequirementsCommand(
  file: string | undefined,
  options: RequirementsInstallOptions,
): Promise<void> {
  const target = path.resolve(options.cwd, file ?? DEFAULT_REQUIREMENTS_FILE);
  const contents = await readTextIfExists(target);
  if (contents === undefined) {
    throw new HcmError(
      `No such file: ${target}`,
      `Create ${DEFAULT_REQUIREMENTS_FILE} with one line per bundle: "<bundle> @ <url>[@ref]", or "<bundle>".`,
    );
  }

  const requirements = parseRequirements(contents, path.dirname(target));
  if (requirements.length === 0) {
    log.warn(`${target} lists no bundles.`);
    return;
  }

  log.info(`Reading ${requirements.length} bundle(s) from ${target}`);
  const resolved = await resolveRequirements(requirements, options);

  // One memory of conflict answers and parameter answers for the whole file,
  // as `hcm import` does: five bundles that want AGENT_NAME ask for it once.
  const decisions = options.decisions ?? new Map<string, Resolution>();
  const answers = options.answers ?? new Map<string, string>();

  for (const { requirement, reference } of resolved) {
    await installCommand(reference, {
      ...options,
      decisions,
      answers,
      ...(requirement.targets ? { targets: requirement.targets } : {}),
      ...(requirement.flavors ? { flavors: requirement.flavors } : {}),
      params: [...(options.params ?? []), ...scopedParams(requirement)],
      // A line with a source pins the installation to that source, so that
      // "hcm update" reads the same branch or tag, not the registry.
      ...(requirement.source ? { track: 'source' as const } : {}),
      // Every source was downloaded in the first phase; read that copy.
      refresh: false,
    });
  }

  log.info('');
  log.success(
    `${resolved.length} bundle(s) from ${path.basename(target)} ` +
      `${options.dryRun ? 'checked (dry run)' : 'installed'}.`,
  );
}

/**
 * Find the bundle of every line. All lines are tried, and all errors are
 * reported together.
 *
 * Each source is downloaded again, so a branch gives its latest commit. A
 * repository that several lines use is downloaded once.
 */
async function resolveRequirements(
  requirements: Requirement[],
  options: RequirementsInstallOptions,
): Promise<ResolvedRequirement[]> {
  const fetched = new Set<string>();
  const entries = await availableEntries();
  const resolved: ResolvedRequirement[] = [];
  const problems: string[] = [];
  let unregistered = false;

  for (const requirement of requirements) {
    try {
      if (requirement.source) {
        const source = await locateRequirement(
          { ...requirement, source: requirement.source },
          { refresh: options.refresh ?? true, fetched },
        );
        resolved.push({ requirement, reference: sourceReference(source), source });
        log.info(`  ${color.bold(requirement.name)} ${color.dim(sourceReference(source))}`);
        continue;
      }

      const entry = matchEntry(entries, requirement.name);
      if (!entry) {
        unregistered = true;
        throw new HcmError(
          `"${requirement.name}" gives no source, and no bundle of that name is registered`,
        );
      }
      resolved.push({ requirement, reference: entry.name });
      log.info(`  ${color.bold(requirement.name)} ${color.dim('(registry)')}`);
    } catch (error) {
      if (!(error instanceof HcmError)) throw error;
      problems.push(`line ${requirement.line} (${requirement.name}): ${error.message}`);
      if (error.hint) problems.push(`  ${error.hint}`);
    }
  }

  if (problems.length > 0) {
    throw new HcmError(
      `Cannot install the requirements file, so nothing was installed:\n  ${problems.join('\n  ')}`,
      unregistered
        ? 'For a line with no source, register the bundle with "hcm registry add <path|url>", ' +
            'or give its source as "<bundle> @ <url>".'
        : undefined,
    );
  }
  return resolved;
}

/**
 * The `--param` values of one line, limited to the bundle of that line. An
 * unscoped `NAME=value` on the line becomes `<bundle>:NAME=value`, so that it
 * does not apply to the dependencies of the bundle.
 */
function scopedParams(requirement: Requirement): string[] {
  return (requirement.params ?? []).map((assignment) => {
    const key = assignment.slice(0, assignment.indexOf('='));
    return key.includes(':') ? assignment : `${requirement.name}:${assignment}`;
  });
}
