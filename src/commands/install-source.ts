/**
 * `hcm install <bundle...> --source <repository> [--ref <ref>]`: install
 * bundles by name from one repository, into this project, without the
 * registry.
 *
 *   hcm install review-kit --source https://dev.azure.com/acme/platform/_git/kits -t copilot
 *   hcm install review-kit db-kit --source acme/agent-kits --ref v2.0.0
 *
 * The repository can hold many bundles, in any folder. hcm finds each bundle
 * by the name in its manifest, as for a line of a requirements file. Each
 * installation records the folder of its bundle, with the ref, and follows
 * that source. Then `hcm update` reads the same repository again, and the
 * registry of the machine plays no part.
 *
 * With no bundle name, each bundle of the source is installed.
 */

import { HcmError } from '../core/errors.js';
import { sourceReference } from '../core/github.js';
import { color, log } from '../core/logger.js';
import { parseSource } from '../core/registry.js';
import { bundlesInSource, locateRequirement } from '../core/requirements.js';
import type { BundleSource } from '../core/types.js';
import { type InstallOptions, installCommand } from './install.js';

export interface SourceInstallOptions extends Omit<InstallOptions, 'track'> {
  /** The repository or folder that holds the bundles. */
  source: string;
  /** The branch, tag or commit to read. Replaces the default branch. */
  ref?: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export async function installFromSourceCommand(
  names: string[],
  options: SourceInstallOptions,
): Promise<void> {
  const { source: spec, ref, ...installOptions } = options;
  const source = withRef(parseSource(spec, options.cwd), ref, spec);

  const refresh = options.refresh ?? true;
  const references =
    names.length === 0
      ? await locateEach(source, refresh)
      : await locateAll(names, source, refresh);

  await installCommand(references, {
    ...installOptions,
    // A source install follows its source: "hcm update" reads the same
    // repository and ref again, and never the registry.
    track: 'source',
    // The source was downloaded above; read that copy.
    refresh: false,
  });
}

/** The folder of each bundle in the source, for an install with no bundle name. */
async function locateEach(source: BundleSource, refresh: boolean): Promise<string[]> {
  const bundles = await bundlesInSource(source, { refresh });
  for (const bundle of bundles) {
    log.info(`  ${color.bold(bundle.name)} ${color.dim(sourceReference(bundle.source))}`);
  }
  return bundles.map((bundle) => sourceReference(bundle.source));
}

/**
 * The folder of each named bundle in the source. All names are tried, and all
 * errors are reported together, so that nothing is installed when one name is
 * wrong.
 */
async function locateAll(
  names: string[],
  source: BundleSource,
  refresh: boolean,
): Promise<string[]> {
  const fetched = new Set<string>();
  const references: string[] = [];
  const problems: string[] = [];

  for (const [index, name] of names.entries()) {
    if (!NAME_PATTERN.test(name)) {
      problems.push(`"${name}" is not a bundle name`);
      continue;
    }
    try {
      const located = await locateRequirement(
        { line: index + 1, name, source },
        { refresh, fetched },
      );
      references.push(sourceReference(located));
      log.info(`  ${color.bold(name)} ${color.dim(sourceReference(located))}`);
    } catch (error) {
      if (!(error instanceof HcmError)) throw error;
      problems.push(error.message);
      if (error.hint) problems.push(`  ${error.hint}`);
    }
  }

  if (problems.length > 0) {
    throw new HcmError(
      `Cannot install from the source, so nothing was installed:\n  ${problems.join('\n  ')}`,
      'Give the names from the "name" field of each hcm.yaml in the source.',
    );
  }
  return references;
}

/** Apply `--ref`. A source that already names another ref is an error. */
function withRef(source: BundleSource, ref: string | undefined, spec: string): BundleSource {
  if (ref === undefined) return source;
  if (source.type === 'local') {
    throw new HcmError(
      `--ref needs a repository, but "${spec}" is a folder`,
      'Remove --ref, or give the URL of the repository.',
    );
  }
  if (source.ref !== 'HEAD' && source.ref !== ref) {
    throw new HcmError(
      `"${spec}" names the ref "${source.ref}", and --ref names "${ref}"`,
      'Give the ref one time: in the source, or with --ref.',
    );
  }
  return { ...source, ref };
}
