/**
 * `hcm params` — the values bundles are customised with.
 *
 * Two halves. `list` reports what each installation was rendered with, and is
 * read-only on purpose: the values live in the installation ledger because that
 * is the thing they belong to, and editing them there would leave the ledger
 * describing an install that does not exist. Changing one means rendering the
 * bundle again, which is what `hcm install --param` and `hcm update --param` do.
 *
 * `init` writes the other end of the same story: a file with every question a
 * set of bundles will ask, each with whatever answer hcm can already work out,
 * for you to fill in the rest of and hand back with `--params-file`.
 *
 * See `core/parameters.ts` for what a parameter is.
 */

import path from 'node:path';
import YAML from 'yaml';
import { HcmError } from '../core/errors.js';
import { pathExists, writeText } from '../core/fsx.js';
import { appliesTo } from '../core/parameters.js';
import { expandTargets } from '../core/harnesses.js';
import { color, log } from '../core/logger.js';
import { asList, resolveBundles } from '../core/registry.js';
import { readState } from '../core/state.js';
import type {
  InstallationRecord,
  LoadedBundle,
  ParameterDefinition,
  Scope,
  TargetId,
} from '../core/types.js';
import { TARGET_IDS } from '../targets/index.js';

export interface ParamsOptions {
  targets?: string[];
  scope?: Scope | 'all';
  json?: boolean;
  cwd: string;
}

export async function paramsListCommand(
  references: string | string[] | undefined,
  options: ParamsOptions,
): Promise<void> {
  const wanted = references === undefined ? [] : asList(references);
  const names = new Set(wanted);
  const targets = expandTargets(options.targets);
  const scopes: Scope[] =
    options.scope === undefined || options.scope === 'all'
      ? ['project', 'user']
      : [options.scope];

  const rows: InstallationRecord[] = [];
  for (const scope of scopes) {
    const state = await readState(scope, options.cwd);
    rows.push(
      ...state.installations.filter(
        (record) =>
          (names.size === 0 || names.has(record.bundle)) &&
          (!targets || targets.includes(record.target)),
      ),
    );
  }

  if (options.json) {
    log.plain(
      JSON.stringify(
        rows.map((record) => ({
          bundle: record.bundle,
          target: record.target,
          scope: record.scope,
          parameters: record.parameters ?? {},
        })),
        null,
        2,
      ),
    );
    return;
  }

  const withValues = rows.filter((record) => Object.keys(record.parameters ?? {}).length > 0);

  if (withValues.length === 0) {
    log.info(
      rows.length === 0
        ? `Nothing installed in ${scopes.join(' or ')} scope.`
        : 'No installation here was customised with parameters.',
    );
    log.info(color.dim('A bundle declares them in its manifest; see "hcm info <bundle>".'));
    return;
  }

  for (const scope of scopes) {
    const scoped = withValues.filter((record) => record.scope === scope);
    if (scoped.length === 0) continue;

    log.plain(color.bold(`\n${scope} scope`));

    for (const record of scoped) {
      log.plain(`  ${color.bold(record.bundle)} ${color.dim(`→ ${record.target}`)}`);
      const entries = Object.entries(record.parameters ?? {});
      const width = Math.max(...entries.map(([name]) => name.length));
      for (const [name, value] of entries) {
        log.plain(`      ${name.padEnd(width)} ${color.dim('=')} ${value}`);
      }
    }
  }

  log.plain('');
  log.info(
    color.dim(
      'These are what "hcm update" will render the next version with. Change one with: ' +
        `hcm update ${describeOne(withValues[0] as InstallationRecord)} --param NAME=value`,
    ),
  );
  log.info(
    color.dim('Parameters declared "secret" are not recorded, and have to be given again.'),
  );
}

/** A bundle name and, where it matters, the harness -- for the example command. */
function describeOne(record: InstallationRecord): string {
  const target: TargetId = record.target;
  return `${record.bundle} -t ${target}`;
}

// ---------------------------------------------------------------------------
// Writing a file to fill in
// ---------------------------------------------------------------------------

export const DEFAULT_PARAMS_FILE = 'params.yaml';

export interface ParamsInitOptions {
  /** Which harnesses the file should cover. Defaults to what is in play. */
  targets?: string[];
  /** Narrow to what an install of these flavors would ask for. */
  flavors?: string[];
  scope: Scope;
  /** Where to write. Defaults to `params.yaml` in the working directory. */
  output?: string;
  /** Print it instead of writing a file. */
  stdout?: boolean;
  /** Replace a file that is already there. */
  force?: boolean;
  cwd: string;
}

/**
 * Write a parameters file for a set of bundles: every question they will ask,
 * each with the best answer hcm can already give.
 *
 * The point is the round trip. `--params-file` is the only way to install a
 * customised bundle with nothing to type and nobody to ask, and working out
 * what belongs in one means reading every manifest by hand. So hcm writes the
 * questions and you write the answers:
 *
 *     hcm params init my-kit          # writes params.yaml
 *     $EDITOR params.yaml             # fill in the blanks
 *     hcm install my-kit --params-file params.yaml
 *
 * Values already known are filled in rather than left blank -- what this
 * project recorded at its last install, or failing that the parameter's own
 * default. Running it against an installed setup therefore produces a file that
 * *reproduces* that setup, which is the form worth committing or handing to
 * somebody setting up the same project.
 */
export async function paramsInitCommand(
  references: string | string[] | undefined,
  options: ParamsInitOptions,
): Promise<void> {
  const wanted = references === undefined ? [] : asList(references);
  const chosen = expandTargets(options.targets);
  const installed = (await readState(options.scope, options.cwd)).installations;

  const bundles = await gather(wanted, installed, options);
  if (bundles.length === 0) return;

  const sections = bundles.map((bundle) =>
    describeSection(bundle, installed, chosen, options.flavors ?? []),
  );
  const asking = sections.filter((section) => section.entries.length > 0);

  if (asking.length === 0) {
    log.info(
      `${bundles.map((bundle) => bundle.manifest.name).join(', ')} ` +
        `${bundles.length === 1 ? 'asks' : 'ask'} for no parameters; there is nothing to fill in.`,
    );
    log.info(color.dim('A bundle declares them under "parameters:" in its manifest.'));
    return;
  }

  const contents = render(asking, wanted);

  if (options.stdout) {
    log.plain(contents.trimEnd());
  } else {
    const target = path.resolve(options.cwd, options.output ?? DEFAULT_PARAMS_FILE);
    if (!options.force && (await pathExists(target))) {
      throw new HcmError(
        `${target} already exists`,
        'Pass --force to replace it, --output to write somewhere else, or --stdout to print it.',
      );
    }
    await writeText(target, contents);

    const total = asking.reduce((count, section) => count + section.entries.length, 0);
    log.success(
      `Wrote ${total} parameter(s) for ${asking.length} bundle(s) to ${target}`,
    );
  }

  reportBlanks(asking);

  const names = asking.map((section) => section.bundle).join(' ');
  log.info(
    color.dim(
      `Fill it in, then: hcm install ${names} --params-file ` +
        `${options.stdout ? DEFAULT_PARAMS_FILE : options.output ?? DEFAULT_PARAMS_FILE}`,
    ),
  );
}

/**
 * The bundles the file should cover: the ones named, or -- naming none -- the
 * ones installed here, which is the "write down what this project is already
 * set up as" case.
 *
 * An installed bundle with no registry entry is reported and skipped rather
 * than thrown from: its parameters are only knowable by reading it, and one
 * unreachable bundle must not cost you the file for all the others.
 */
async function gather(
  wanted: string[],
  installed: InstallationRecord[],
  options: ParamsInitOptions,
): Promise<LoadedBundle[]> {
  if (wanted.length > 0) {
    const bundles: LoadedBundle[] = [];
    for (const reference of wanted) {
      bundles.push(...(await resolveBundles(reference, options.cwd)));
    }
    return bundles;
  }

  const names = [...new Set(installed.map((record) => record.bundle))].sort();
  if (names.length === 0) {
    log.info(`Nothing installed in ${options.scope} scope, and no bundle named.`);
    log.info(color.dim('Name one: hcm params init <bundle...>'));
    return [];
  }

  const bundles: LoadedBundle[] = [];
  for (const name of names) {
    const found = await readInstalled(name, installed, options.cwd);
    if (found.length > 0) {
      bundles.push(...found);
      continue;
    }
    log.warn(`${name} is installed here but cannot be read; leaving it out of the file`);
    log.warn(color.dim('  register its source with: hcm registry add <path|owner/repo>'));
  }
  return bundles;
}

/**
 * Read an installed bundle, to find out what it asks for.
 *
 * The registry first, since that is the copy `hcm update` would reinstall from
 * and therefore the one whose questions matter. Failing that, the source the
 * installation itself recorded -- a bundle installed straight from a path was
 * never registered, and refusing to write its parameters down would be a
 * strange way to reward the shorter command.
 */
async function readInstalled(
  name: string,
  installed: InstallationRecord[],
  cwd: string,
): Promise<LoadedBundle[]> {
  try {
    return await resolveBundles(name, cwd);
  } catch {
    // Fall through to the recorded source.
  }

  const source = installed.find((record) => record.bundle === name)?.source;
  if (source?.type !== 'local') return [];

  try {
    return await resolveBundles(source.path, cwd);
  } catch {
    return [];
  }
}

/** One parameter as it will appear in the file. */
interface Entry {
  parameter: ParameterDefinition;
  /** The value to write, or undefined to leave a blank for the user. */
  value?: string;
  /** The harness this one belongs under, for a parameter scoped to harnesses. */
  target?: TargetId;
}

interface Section {
  bundle: string;
  entries: Entry[];
}

/**
 * What one bundle contributes, and what each of its parameters should say.
 *
 * A value already settled is written rather than blanked: what this project
 * recorded last time, then the parameter's own default. A secret is always
 * blank -- it was deliberately never recorded, so pretending to know it would
 * be the one lie this file could tell.
 */
function describeSection(
  bundle: LoadedBundle,
  installed: InstallationRecord[],
  chosen: TargetId[] | undefined,
  flavors: string[],
): Section {
  const records = installed.filter((record) => record.bundle === bundle.manifest.name);
  const targets = targetsInPlay(bundle, records, chosen);
  const entries: Entry[] = [];

  for (const parameter of bundle.parameters) {
    // Narrowing by flavor here answers "what will *this* install ask me",
    // which is the file you want when you already know how you are installing.
    if (flavors.length > 0 && !appliesTo(parameter, { target: targets[0] as TargetId, flavors })) {
      continue;
    }

    if (parameter.targets.length === 0) {
      entries.push({ parameter, ...blankOr(recorded(records, parameter.name), parameter) });
      continue;
    }

    // A harness-scoped parameter is a fact about a harness, so it gets one
    // entry per harness it applies to -- which is also where a reader learns
    // that any parameter can be given a different value per harness.
    for (const target of targets) {
      if (!parameter.targets.includes(target)) continue;
      const from = records.find((record) => record.target === target);
      entries.push({
        parameter,
        target,
        ...blankOr(from?.parameters?.[parameter.name], parameter),
      });
    }
  }

  return { bundle: bundle.manifest.name, entries };
}

/** The value to write for one entry: what is known, or nothing at all. */
function blankOr(known: string | undefined, parameter: ParameterDefinition): { value?: string } {
  if (parameter.secret) return {};
  const value = known ?? parameter.default;
  return value === undefined ? {} : { value };
}

/** What any installation of this bundle recorded for a name, whichever harness. */
function recorded(records: InstallationRecord[], name: string): string | undefined {
  for (const record of records) {
    const value = record.parameters?.[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * The harnesses the file should have sections for: the ones asked for, else the
 * ones this bundle is already installed into, else the ones it supports.
 */
function targetsInPlay(
  bundle: LoadedBundle,
  records: InstallationRecord[],
  chosen: TargetId[] | undefined,
): TargetId[] {
  if (chosen?.length) return chosen;
  const installed = [...new Set(records.map((record) => record.target))];
  if (installed.length > 0) return installed;
  return bundle.manifest.targets?.length ? bundle.manifest.targets : [...TARGET_IDS];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The file itself.
 *
 * Written by hand rather than by `YAML.stringify`, because the comments are
 * most of the value: what each parameter is for, whether it has to be answered,
 * what it will accept. Only the scalars go through the YAML writer, which is
 * what keeps a value with a colon in it from breaking the file.
 */
function render(sections: Section[], wanted: string[]): string {
  const lines: string[] = [
    '# hcm parameters file',
    `# generated ${new Date().toISOString()}`,
    '#',
    '# Fill in the blanks, then install with:',
    `#   hcm install ${sections.map((section) => section.bundle).join(' ')} --params-file <this file>`,
    '#',
    '# A blank means "not said": hcm falls back to the default, or asks. Write',
    '# KEY: "" to mean the value really is empty.',
    '#',
    '# Values can be given at three levels, the narrowest winning:',
    '#   at the top of this file      any bundle that asks for that name',
    '#   under bundles.<name>         that bundle',
    '#   under bundles.<name>.targets.<harness>   that bundle, in one harness',
    ...(wanted.length === 0
      ? ['#', '# Prefilled from what this project is installed as.']
      : []),
    '',
    'bundles:',
  ];

  for (const [index, section] of sections.entries()) {
    if (index > 0) lines.push('');
    lines.push(`  ${section.bundle}:`);

    for (const entry of section.entries.filter((one) => one.target === undefined)) {
      lines.push(...entryLines(entry, '    '));
    }

    const scoped = section.entries.filter((one) => one.target !== undefined);
    if (scoped.length === 0) continue;

    lines.push('    # Values for one harness only. Any parameter above can be moved');
    lines.push('    # in here to give it a different value per harness.');
    lines.push('    targets:');

    for (const target of [...new Set(scoped.map((one) => one.target as TargetId))]) {
      lines.push(`      ${target}:`);
      for (const entry of scoped.filter((one) => one.target === target)) {
        lines.push(...entryLines(entry, '        '));
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

/** One parameter: its notes, then the key and whatever value we could supply. */
function entryLines(entry: Entry, indent: string): string[] {
  const { parameter } = entry;
  const lines: string[] = [];

  if (parameter.description) lines.push(`${indent}# ${parameter.description}`);

  const notes = [
    ...(entry.value === undefined && parameter.required ? ['REQUIRED — no default'] : []),
    ...(parameter.secret ? ['secret — never recorded, so it must be given every time'] : []),
    ...(parameter.choices ? [`one of: ${parameter.choices.join(', ')}`] : []),
    ...(parameter.pattern ? [`must match: ${parameter.pattern}`] : []),
    ...(parameter.flavors.length > 0
      ? [`only asked for with --flavor ${parameter.flavors.join(' ')}`]
      : []),
  ];
  for (const note of notes) lines.push(`${indent}# ${note}`);

  lines.push(
    `${indent}${parameter.name}:${entry.value === undefined ? '' : ` ${scalar(entry.value)}`}`,
  );
  return lines;
}

/**
 * One value, quoted the way YAML needs it. Folding is off: a long value broken
 * across lines would still parse, but nobody wants to edit that.
 */
function scalar(value: string): string {
  return YAML.stringify(value, { lineWidth: 0 }).trimEnd();
}

/** Say how many blanks are left, since that is what the file is for. */
function reportBlanks(sections: Section[]): void {
  const blanks = sections.flatMap((section) =>
    section.entries
      .filter((entry) => entry.value === undefined)
      .map((entry) => ({ bundle: section.bundle, entry })),
  );
  if (blanks.length === 0) {
    log.info(color.dim('Every value was already known; nothing is left blank.'));
    return;
  }

  const required = blanks.filter(({ entry }) => entry.parameter.required);
  log.warn(
    `${blanks.length} value(s) left blank` +
      (required.length > 0 ? `, ${required.length} of which must be filled in:` : ':'),
  );
  for (const { bundle, entry } of blanks) {
    const where = entry.target ? color.dim(` (${entry.target})`) : '';
    const why = entry.parameter.secret
      ? color.dim(' — secret')
      : entry.parameter.required
        ? color.yellow(' — required')
        : color.dim(' — optional');
    log.plain(`  ${color.dim(`${bundle}.`)}${entry.parameter.name}${where}${why}`);
  }
}
