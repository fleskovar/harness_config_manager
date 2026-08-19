/**
 * `hcm refs check` and `hcm refs fix`.
 *
 * Checking is a report. Fixing is a round trip through a file the user edits:
 *
 *   1. scan, and for every broken reference work out what it probably meant
 *   2. write that out as JSON -- one entry per broken reference, each with the
 *      candidates ranked best first
 *   3. the user deletes the wrong ones, leaving exactly one per entry
 *   4. on save and close, every entry with one candidate left is applied
 *
 * The list-of-candidates shape is the point. A rename that broke twenty
 * references usually broke them in two or three distinct ways, and picking from
 * a ranked list is a keystroke where typing the path is a fresh chance to get
 * it wrong. Entries left with more than one candidate are not guessed at; they
 * are reported and left alone, so an unfinished pass through the file cannot
 * quietly write something nobody chose.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { HcmError } from '../core/errors.js';
import { fs, pathExists, toPosix } from '../core/fsx.js';
import { color, log } from '../core/logger.js';
import {
  applyRefEdits,
  type BrokenRef,
  type RefEdit,
  type RefScope,
  scanReferences,
  type ScanResult,
} from '../core/refs.js';

export interface RefsCheckOptions extends RefScope {
  path?: string;
  json?: boolean;
  cwd: string;
}

export interface RefsFixOptions extends RefScope {
  path?: string;
  /**
   * Write the fix file and stop, instead of opening an editor. Takes an
   * optional path; `true` means the default name in the working directory.
   */
  write?: boolean | string;
  /** Apply an already-edited fix file rather than producing a new one. */
  file?: string;
  dryRun?: boolean;
  /** Test seam: stands in for the user's editor. */
  edit?: (file: string) => Promise<void>;
  cwd: string;
}

/** The shape written to disk, exactly as documented. */
export interface FixEntry {
  original_ref: string;
  new: string[];
}

export type FixFile = Record<string, FixEntry>;

const DEFAULT_FIX_FILE = 'hcm-refs.json';

/**
 * The scan scope, read off the flags.
 *
 * `check` and `fix` share it because `fix` re-scans before applying: a fix file
 * produced under one scope and applied under another would not find the
 * references it was written for.
 */
function scopeOf(options: RefScope): RefScope {
  return {
    links: options.links ?? false,
    allPaths: options.allPaths ?? false,
    strict: options.strict ?? false,
  };
}

/**
 * The scope as flags again, so a command we print can be pasted and reproduce
 * the same scan. `fix` re-scans, so a hint that dropped them would repair a
 * different set of references than the one just reported.
 */
function scopeFlags(scope: RefScope): string {
  const flags = [
    scope.links === true ? '--links' : '',
    scope.strict === true ? '--strict' : scope.allPaths === true ? '--all-paths' : '',
  ].filter(Boolean);
  return flags.length > 0 ? ` ${flags.join(' ')}` : '';
}

/** The scope in a few words, so the report says what it did and did not read. */
function describeScope(scope: RefScope): string {
  if (scope.links === true) return 'links and wikilinks only';
  if (scope.strict === true) return 'every path, including bare filenames with no match';
  if (scope.allPaths === true) return 'every path, including implicit ones';
  return 'links, wikilinks and explicitly relative paths';
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

export async function refsCheckCommand(options: RefsCheckOptions): Promise<boolean> {
  const root = await resolveRoot(options.path, options.cwd);
  const result = await scanReferences(root, scopeOf(options));

  if (options.json) {
    log.plain(JSON.stringify(toReport(result), null, 2));
    return result.broken.length === 0;
  }

  log.plain(
    `${color.bold(toPosix(path.relative(options.cwd, root)) || root)} ` +
      color.dim(
        `· ${result.scanned.length} file(s) · ${result.refs.length} reference(s) · ` +
          `${result.bundles.length} bundle(s)`,
      ),
  );
  log.plain(color.dim(`  scope: ${describeScope(result.scope)}`));

  if (result.broken.length === 0) {
    log.success('  No broken references.');
    return true;
  }

  for (const [file, refs] of groupByFile(result.broken)) {
    log.plain(`\n${color.bold(file)}`);
    for (const ref of refs) {
      log.plain(
        `  ${color.red('✖')} ${color.dim(`line ${ref.line}`)}  ${ref.ref} ` +
          color.dim(`(${ref.syntax}${ref.confidence === 'weak' ? ', unsure' : ''})`),
      );
      for (const suggestion of ref.suggestions) {
        const note = suggestion.crossBundle ? color.yellow('  [another bundle]') : '';
        log.plain(`      ${color.dim('→')} ${suggestion.ref}${note}`);
      }
      if (ref.suggestions.length === 0) log.plain(color.dim('      (nothing similar found)'));
    }
  }

  log.plain('');
  log.warn(
    `${result.broken.length} broken reference(s) in ${groupByFile(result.broken).size} file(s)`,
  );
  log.info(
    color.dim(
      `Run "hcm refs fix --path ${quote(options.path ?? '.')}${scopeFlags(result.scope)}" ` +
        'to repair them.',
    ),
  );
  return false;
}

function toReport(result: ScanResult): unknown {
  return {
    root: result.root,
    scope: result.scope,
    scanned: result.scanned.length,
    references: result.refs.length,
    broken: result.broken.map((ref) => ({
      file: ref.fileRelative,
      line: ref.line,
      ref: ref.ref,
      syntax: ref.syntax,
      confidence: ref.confidence,
      suggestions: ref.suggestions.map((suggestion) => ({
        ref: suggestion.ref,
        crossBundle: suggestion.crossBundle,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// fix
// ---------------------------------------------------------------------------

export async function refsFixCommand(options: RefsFixOptions): Promise<boolean> {
  // --file skips the scan entirely: the decisions have already been made, and
  // re-deriving them would only risk disagreeing with the file being applied.
  if (options.file) return applyFixFile(options.file, options);

  const root = await resolveRoot(options.path, options.cwd);
  const result = await scanReferences(root, scopeOf(options));

  if (result.broken.length === 0) {
    log.success('No broken references — nothing to fix.');
    return true;
  }

  const fixFile = buildFixFile(result);
  const destination = options.write
    ? path.resolve(options.cwd, typeof options.write === 'string' ? options.write : DEFAULT_FIX_FILE)
    : path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-refs-')), DEFAULT_FIX_FILE);

  await fs.writeFile(destination, `${JSON.stringify(fixFile, null, 2)}\n`, 'utf8');

  log.info(
    `${color.bold(String(result.broken.length))} broken reference(s) written to ` +
      color.bold(toPosix(path.relative(options.cwd, destination)) || destination),
  );

  // --write is the non-interactive half of the round trip: hand the file over
  // and stop, so it can be edited by whatever, whenever, and applied later.
  if (options.write) {
    log.info(
      color.dim(
        'Leave exactly one entry in each "new" list, then apply it with:\n' +
          `  hcm refs fix --path ${quote(options.path ?? '.')}${scopeFlags(result.scope)} ` +
            `--file ${quote(toPosix(path.relative(options.cwd, destination)) || destination)}`,
      ),
    );
    return true;
  }

  log.info(color.dim('Leave exactly one entry in each "new" list, then save and close.'));
  await (options.edit ?? openInEditor)(destination);

  return applyFixFile(destination, options);
}

/**
 * One entry per broken reference.
 *
 * The key is the file the reference is in, which is what makes the file
 * readable -- but a file may well have broken several references at once, and
 * JSON objects do not keep duplicate keys. Later entries for the same file get
 * a `#2`, `#3` suffix; `original_ref` is what actually identifies the
 * reference, so nothing depends on the suffix.
 */
export function buildFixFile(result: ScanResult): FixFile {
  const out: FixFile = {};
  const seen = new Map<string, number>();

  for (const ref of result.broken) {
    const count = (seen.get(ref.fileRelative) ?? 0) + 1;
    seen.set(ref.fileRelative, count);
    const key = count === 1 ? ref.fileRelative : `${ref.fileRelative}#${count}`;

    out[key] = {
      original_ref: ref.ref,
      new: ref.suggestions.map((suggestion) => suggestion.ref),
    };
  }

  return out;
}

/** `path/to/file.md#3` -> `path/to/file.md`. */
function keyToFile(key: string): string {
  return key.replace(/#\d+$/, '');
}

async function applyFixFile(file: string, options: RefsFixOptions): Promise<boolean> {
  const absolute = path.resolve(options.cwd, file);
  const text = await fs.readFile(absolute, 'utf8').catch(() => undefined);
  if (text === undefined) throw new HcmError(`No such fix file: ${absolute}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new HcmError(
      `${absolute} is not valid JSON: ${(error as Error).message}`,
      'Re-run without --file to generate a fresh one.',
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HcmError(`${absolute} should be an object keyed by file path`);
  }

  // Paths in the fix file are relative to the folder that was scanned, which is
  // not necessarily where the file ended up or where hcm is being run from.
  const root = await resolveRoot(options.path, options.cwd);

  // Re-scan so the offsets are current: whatever the user did to the JSON, the
  // bundle itself may have been edited in the same sitting.
  const result = await scanReferences(root, scopeOf(options));
  const located = new Map<string, BrokenRef[]>();
  for (const ref of result.broken) {
    const list = located.get(ref.fileRelative) ?? [];
    list.push(ref);
    located.set(ref.fileRelative, list);
  }

  const edits: RefEdit[] = [];
  const undecided: string[] = [];
  const unknown: string[] = [];

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = value as Partial<FixEntry> | undefined;
    if (!entry || typeof entry.original_ref !== 'string' || !Array.isArray(entry.new)) {
      throw new HcmError(
        `Entry "${key}" is malformed`,
        'Each entry needs "original_ref" (a string) and "new" (a list of paths).',
      );
    }

    const choices = entry.new.filter(
      (choice): choice is string => typeof choice === 'string' && choice.trim() !== '',
    );

    if (choices.length !== 1) {
      undecided.push(
        `${key}: ${choices.length === 0 ? 'no replacement chosen' : `${choices.length} left in "new"`}`,
      );
      continue;
    }

    const fileRelative = keyToFile(key);
    const match = (located.get(fileRelative) ?? []).find(
      (candidate) => candidate.ref === entry.original_ref,
    );

    const target = path.resolve(root, ...fileRelative.split('/'));
    if (!(await pathExists(target))) {
      unknown.push(`${key}: no such file under ${root}`);
      continue;
    }

    edits.push({
      file: target,
      original: entry.original_ref,
      replacement: (choices[0] as string).trim(),
      ...(match ? { start: match.start, end: match.end } : {}),
    });

    // Consume it, so two entries for the same file do not both aim at the same
    // occurrence when several references share a spelling.
    if (match) {
      const list = located.get(fileRelative) as BrokenRef[];
      list.splice(list.indexOf(match), 1);
    }
  }

  for (const problem of undecided) log.warn(`  skipped ${problem}`);
  for (const problem of unknown) log.warn(`  skipped ${problem}`);

  if (edits.length === 0) {
    log.warn('Nothing to apply — every entry still needs exactly one choice in "new".');
    return false;
  }

  const outcomes = await applyRefEdits(edits, { dryRun: options.dryRun ?? false });

  for (const outcome of outcomes) {
    const where = toPosix(path.relative(root, outcome.file));
    if (outcome.applied) {
      log.info(
        `  ${color.green('✔')} ${where}: ${color.dim(outcome.original)} → ${outcome.replacement}`,
      );
    } else {
      log.warn(`  ${where}: ${outcome.reason}`);
    }
  }

  const applied = outcomes.filter((outcome) => outcome.applied).length;
  const failed = outcomes.length - applied;

  if (options.dryRun) {
    log.info(color.dim(`(dry run — nothing written; ${applied} reference(s) would change)`));
    return failed === 0;
  }

  log.success(`Fixed ${applied} reference(s)${failed > 0 ? `, ${failed} left alone` : ''}`);
  return failed === 0 && undecided.length === 0 && unknown.length === 0;
}

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

/** A folder, normally -- but a single file is a reasonable thing to check too. */
async function resolveRoot(target: string | undefined, cwd: string): Promise<string> {
  const root = path.resolve(cwd, target ?? '.');
  if (!(await pathExists(root))) {
    throw new HcmError(
      `No such path: ${root}`,
      'Point --path at a bundle, or at a folder holding several.',
    );
  }
  return root;
}

function groupByFile(refs: BrokenRef[]): Map<string, BrokenRef[]> {
  const groups = new Map<string, BrokenRef[]>();
  for (const ref of refs) {
    const list = groups.get(ref.fileRelative) ?? [];
    list.push(ref);
    groups.set(ref.fileRelative, list);
  }
  return groups;
}

function quote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * Open the fix file and wait for the editor to close.
 *
 * `$VISUAL` then `$EDITOR`, as every other tool that does this uses; failing
 * that, whatever the platform will open a `.json` with. The wait is the whole
 * mechanism -- an editor that forks (`code` without `--wait`) would have us
 * read the file back before it had been touched -- so the ones known to fork
 * are given the flag that makes them stay.
 */
async function openInEditor(file: string): Promise<void> {
  const configured = process.env.VISUAL || process.env.EDITOR;
  const { command, args } = editorCommand(configured, file);

  log.info(color.dim(`  opening ${command} …`));

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: !configured });
    child.on('error', (error) =>
      reject(
        new HcmError(
          `Could not open an editor (${command}): ${error.message}`,
          'Set $EDITOR, or use --write to save the file and edit it yourself.',
        ),
      ),
    );
    child.on('exit', () => resolve());
  });
}

export function editorCommand(
  configured: string | undefined,
  file: string,
): { command: string; args: string[] } {
  if (!configured) {
    // No editor named: hand it to the platform. On Windows `start` needs a
    // title argument first, or it takes the path as one.
    if (process.platform === 'win32') return { command: 'notepad', args: [file] };
    if (process.platform === 'darwin') return { command: 'open', args: ['-W', '-t', file] };
    return { command: 'nano', args: [file] };
  }

  const parts = configured.split(/\s+/).filter(Boolean);
  const command = parts[0] as string;
  const args = parts.slice(1);

  // GUI editors return immediately unless told to wait, which would apply the
  // file before it had been edited.
  const forks = ['code', 'code-insiders', 'codium', 'subl', 'atom', 'gedit', 'cursor', 'windsurf'];
  if (forks.includes(path.basename(command, path.extname(command))) && !args.includes('--wait')) {
    args.push('--wait');
  }

  return { command, args: [...args, file] };
}
