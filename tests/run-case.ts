/**
 * inputs/ on disk -> the documents a case expects, keyed by name.
 *
 * Deliberately free of Vitest: the same function backs the test runner, the
 * debug entry point at the bottom, and the baseline regenerator. Run one case
 * with a clean call stack and no test-framework frames:
 *
 *   npx tsx tests/run-case.ts claude-code-every-kind
 *   npm run debug:case -- claude-code-every-kind
 *
 * ---------------------------------------------------------------------------
 * What a case is
 * ---------------------------------------------------------------------------
 *
 * The unit under test is `hcm` itself: a bundle and a command go in, a project
 * directory comes out. So a case folder is a project before, a project after,
 * and the commands in between:
 *
 *   tests/cases/<case-name>/
 *     inputs/
 *       case.json                  the commands to run, in order
 *       bundles/<name>/...         the bundle(s) those commands install
 *       project/...                what the project already had (optional)
 *       <anything>.md              text a step writes into the project (optional)
 *     outputs/
 *       tree/...                   every file in the project afterwards
 *       state.json                 the installation ledger, normalised (optional)
 *       report.json                what a reporting command returned (optional)
 *       error.txt                  the message a failing step produced (optional)
 *     README.md                    the walkthrough
 *
 * `outputs/tree/` is exhaustive: a file that is not in it must not be in the
 * project. That is what makes one comparison enough, and it is why the
 * narrative assertions these cases replaced ("the rule's globs became paths")
 * live in the README rather than in a test -- the tree already proves them, and
 * prose says why they are what they are.
 *
 * Everything the run depends on is inside `inputs/`: the bundles, the project,
 * the harnesses to install into. Nothing reads the machine's real `~/.hcm`, the
 * clock never reaches an output, and no absolute path survives normalisation --
 * so a case gives the same answer on any machine, in any month.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCommand } from '../src/commands/install.js';
import { uninstallCommand } from '../src/commands/uninstall.js';
import { updateCommand } from '../src/commands/update.js';
import { validateCommand } from '../src/commands/validate.js';
import {
  contextAppendCommand,
  contextOverrideCommand,
  contextRemoveCommand,
} from '../src/commands/context.js';
import type { ConflictPolicy, ConflictResolver } from '../src/core/conflicts.js';
import { configureLogger } from '../src/core/logger.js';
import { loadBundle, validateBundle } from '../src/core/bundle.js';
import { addToRegistry } from '../src/core/registry.js';
import { scanReferences } from '../src/core/refs.js';
import { readState } from '../src/core/state.js';
import type { InstallationRecord, Scope, StateFile } from '../src/core/types.js';

export const CASES_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cases');
export const JSON_INDENT = 2;

// ---------------------------------------------------------------------------
// The step vocabulary
// ---------------------------------------------------------------------------

/**
 * One thing a case does. Each verb is one hcm command with its flags, or one
 * edit to the project between commands -- an agent rewriting `CLAUDE.md`, a
 * developer appending a note, an upstream release replacing a bundle.
 *
 * Kept deliberately small: every verb here exists because a real behaviour
 * needs it, and a case that needs a tenth verb is usually a case that should be
 * two cases.
 */
export type CaseStep =
  /** `hcm install <bundle...>` */
  | {
      install: string | string[];
      targets?: string[];
      scope?: Scope;
      flavors?: string[];
      params?: string[];
      paramsFiles?: string[];
      onConflict?: ConflictPolicy;
      /** Stands in for the user answering the conflict prompt. */
      resolve?: { choice: 'skip' | 'overwrite' | 'rename' | 'abort'; newName?: string };
      noDeps?: boolean;
      force?: boolean;
      dryRun?: boolean;
      register?: boolean;
      fails?: boolean;
    }
  /** `hcm update [bundle...]` */
  | {
      update: string | string[] | null;
      targets?: string[];
      scope?: Scope;
      flavors?: string[];
      params?: string[];
      reconfigure?: boolean;
      force?: boolean;
      dryRun?: boolean;
      fails?: boolean;
    }
  /** `hcm uninstall <bundle...>` */
  | {
      uninstall: string | string[];
      targets?: string[];
      scope?: Scope;
      force?: boolean;
      cascade?: boolean;
      keepOrphans?: boolean;
      ignoreDependents?: boolean;
      dryRun?: boolean;
      fails?: boolean;
    }
  /** `hcm context append|override|remove` */
  | {
      context: 'append' | 'override' | 'remove';
      bundles?: string[];
      targets?: string[];
      scope?: Scope;
      force?: boolean;
      dryRun?: boolean;
    }
  /** `hcm validate <bundle>` -> outputs/report.json */
  | { validate: string }
  /** `hcm refs check <bundle>` -> outputs/report.json */
  | { refs: string }
  /** Register a bundle so a later step can name it. `--dev` reads it in place. */
  | { register: string; dev?: boolean }
  /** An upstream release: replace one bundle's files with another's. */
  | { replaceBundle: string; with: string }
  /** Somebody edits a file in the project -- an agent, or a developer. */
  | { writeFile: string; from?: string; text?: string }
  | { appendFile: string; text: string };

export interface CaseDefinition {
  /** One line, used as the test's name after the folder. */
  describes: string;
  steps: CaseStep[];
  /**
   * Also write the installation ledger to `outputs/state.json`. On by default
   * only for cases that ask, since most are about files rather than receipts.
   */
  recordState?: boolean;
}

export interface CaseResult {
  /** Project-relative POSIX path -> file contents. `.hcm/` excluded. */
  tree: Record<string, string>;
  /** `state.json`, `report.json`, `error.txt` -- whatever the steps produced. */
  documents: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Running one
// ---------------------------------------------------------------------------

/**
 * Set the case up in a scratch directory, run its steps, and read the result
 * back. The scratch directory is removed afterwards unless `keep` is set, which
 * is what the debug entry point uses to leave something to look at.
 */
export async function runCase(caseDir: string, options: { keep?: string } = {}): Promise<CaseResult> {
  const definition = await readJson<CaseDefinition>(path.join(caseDir, 'inputs', 'case.json'));
  const workspace = options.keep ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-case-')));
  const projectDir = path.join(workspace, 'project');
  const bundlesDir = path.join(workspace, 'bundles');

  const previousHome = process.env.HCM_HOME;
  process.env.HCM_HOME = path.join(workspace, 'home');
  configureLogger({ quiet: true });

  try {
    // The project starts as whatever `inputs/project/` holds, or empty.
    await fs.mkdir(projectDir, { recursive: true });
    const seed = path.join(caseDir, 'inputs', 'project');
    if (await isDirectory(seed)) await copyDir(seed, projectDir);

    // Bundles are copied, never read in place: a step may rewrite one, and
    // nothing should be able to reach back into the checked-in case folder.
    const inputBundles = path.join(caseDir, 'inputs', 'bundles');
    if (await isDirectory(inputBundles)) await copyDir(inputBundles, bundlesDir);

    const documents: Record<string, unknown> = {};
    const context = { caseDir, workspace, projectDir, bundlesDir, documents };

    for (const step of definition.steps) await runStep(step, context);

    const tree = await readTree(projectDir);
    if (definition.recordState) {
      documents['state.json'] = await normalisedState(projectDir);
    }

    return { tree, documents };
  } finally {
    if (previousHome === undefined) delete process.env.HCM_HOME;
    else process.env.HCM_HOME = previousHome;
    configureLogger({});
    if (!options.keep) await fs.rm(workspace, { recursive: true, force: true });
  }
}

interface RunContext {
  caseDir: string;
  workspace: string;
  projectDir: string;
  bundlesDir: string;
  documents: Record<string, unknown>;
}

async function runStep(step: CaseStep, ctx: RunContext): Promise<void> {
  const at = (name: string): string => path.join(ctx.bundlesDir, name);
  const list = (value: string | string[]): string[] =>
    (Array.isArray(value) ? value : [value]).map(at);

  if ('install' in step) {
    if (step.register) {
      for (const name of Array.isArray(step.install) ? step.install : [step.install]) {
        await addToRegistry(at(name), ctx.projectDir);
      }
    }
    await capture(step.fails, ctx, () =>
      installCommand(list(step.install), {
        scope: step.scope ?? 'project',
        cwd: ctx.projectDir,
        ...(step.targets ? { targets: step.targets } : {}),
        ...(step.flavors ? { flavors: step.flavors } : {}),
        ...(step.params ? { params: step.params } : {}),
        ...(step.paramsFiles
          ? { paramsFiles: step.paramsFiles.map((file) => path.join(ctx.caseDir, 'inputs', file)) }
          : {}),
        ...(step.onConflict ? { onConflict: step.onConflict } : {}),
        ...(step.resolve ? { resolver: fixedResolver(step.resolve) } : {}),
        ...(step.noDeps ? { noDeps: true } : {}),
        ...(step.force ? { force: true } : {}),
        ...(step.dryRun ? { dryRun: true } : {}),
      }),
    );
    return;
  }

  if ('update' in step) {
    await capture(step.fails, ctx, () =>
      updateCommand(step.update === null ? undefined : step.update, {
        cwd: ctx.projectDir,
        ...(step.scope ? { scope: step.scope } : {}),
        ...(step.targets ? { targets: step.targets } : {}),
        ...(step.flavors ? { flavors: step.flavors } : {}),
        ...(step.params ? { params: step.params } : {}),
        ...(step.reconfigure ? { reconfigure: true } : {}),
        ...(step.force ? { force: true } : {}),
        ...(step.dryRun ? { dryRun: true } : {}),
      }),
    );
    return;
  }

  if ('uninstall' in step) {
    await capture(step.fails, ctx, () =>
      uninstallCommand(step.uninstall, {
        scope: step.scope ?? 'project',
        cwd: ctx.projectDir,
        ...(step.targets ? { targets: step.targets } : {}),
        ...(step.force ? { force: true } : {}),
        ...(step.cascade ? { cascade: true } : {}),
        ...(step.keepOrphans ? { keepOrphans: true } : {}),
        ...(step.ignoreDependents ? { ignoreDependents: true } : {}),
        ...(step.dryRun ? { dryRun: true } : {}),
      }),
    );
    return;
  }

  if ('context' in step) {
    const options = {
      scope: step.scope ?? ('project' as const),
      cwd: ctx.projectDir,
      ...(step.targets ? { targets: step.targets } : {}),
      ...(step.force ? { force: true } : {}),
      ...(step.dryRun ? { dryRun: true } : {}),
    };
    const run =
      step.context === 'append'
        ? contextAppendCommand
        : step.context === 'override'
          ? contextOverrideCommand
          : contextRemoveCommand;
    await run(step.bundles ?? [], options);
    return;
  }

  if ('validate' in step) {
    // The report, not the exit code: what a reader wants to check by hand is
    // the list of problems, in the order hcm names them.
    const bundle = await loadBundle(at(step.validate));
    ctx.documents['report.json'] = {
      bundle: bundle.manifest.name,
      ok: await validateCommand(at(step.validate), { cwd: ctx.workspace }),
      problems: validateBundle(bundle),
    };
    return;
  }

  if ('refs' in step) {
    const result = await scanReferences(at(step.refs));
    ctx.documents['report.json'] = {
      // The suggestion's `ref` -- what the reference should have said -- and
      // not its `target`, which is an absolute path on this machine.
      broken: result.broken.map((ref) => ({
        file: ref.fileRelative,
        ref: ref.ref,
        suggestions: ref.suggestions.map((suggestion) => suggestion.ref),
      })),
    };
    return;
  }

  if ('register' in step) {
    await addToRegistry(at(step.register), ctx.projectDir, step.dev ? { dev: true } : {});
    return;
  }

  if ('replaceBundle' in step) {
    // An upstream release: the same name, different files.
    await fs.rm(at(step.replaceBundle), { recursive: true, force: true });
    await copyDir(at(step.with), at(step.replaceBundle));
    return;
  }

  if ('writeFile' in step) {
    const body =
      step.text ??
      normaliseText(
        await fs.readFile(path.join(ctx.caseDir, 'inputs', step.from as string), 'utf8'),
      );
    const target = path.join(ctx.projectDir, ...step.writeFile.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, 'utf8');
    return;
  }

  const target = path.join(ctx.projectDir, ...step.appendFile.split('/'));
  await fs.appendFile(target, step.text, 'utf8');
}

/**
 * Run a step that is expected to fail, and keep its message.
 *
 * A refusal is a behaviour like any other -- "it writes nothing at all" is the
 * point of the abort case -- so the message becomes an output document and the
 * tree that follows proves the refusal was total.
 */
async function capture(
  fails: boolean | undefined,
  ctx: RunContext,
  run: () => Promise<void>,
): Promise<void> {
  if (!fails) {
    await run();
    return;
  }

  try {
    await run();
  } catch (error) {
    ctx.documents['error.txt'] = (error as Error).message;
    return;
  }
  throw new Error('the step was marked "fails" but succeeded');
}

/** The answer a case gives to the conflict prompt, every time it is asked. */
function fixedResolver(resolution: {
  choice: 'skip' | 'overwrite' | 'rename' | 'abort';
  newName?: string;
}): ConflictResolver {
  return async () => ({
    choice: resolution.choice,
    ...(resolution.newName ? { newName: resolution.newName } : {}),
  });
}

// ---------------------------------------------------------------------------
// Reading the result back
// ---------------------------------------------------------------------------

/**
 * Every file in the project, as POSIX path -> text.
 *
 * `.hcm/` is left out: it is hcm's own bookkeeping rather than a harness file,
 * and it holds timestamps and absolute paths that have no place in a baseline.
 * A case that is *about* the ledger asks for `state.json` instead, normalised.
 *
 * Line endings are normalised on both sides. hcm writes `\n`, but a checkout
 * with `core.autocrlf=true` hands the baseline back as `\r\n`, and that is
 * git's business rather than something a case should fail over.
 */
async function readTree(root: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.hcm') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const relative = path.relative(root, full).split(path.sep).join('/');
      tree[relative] = (await fs.readFile(full, 'utf8')).replace(/\r\n/g, '\n');
    }
  }

  await walk(root);
  return Object.fromEntries(Object.entries(tree).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The installation ledger with everything machine-specific taken out.
 *
 * A receipt's hash is a fact about the content and stays; `installedAt` is the
 * clock and goes; a local source path is where *this* run put the bundle and
 * becomes its name. What is left is what a reader can check: who owns what.
 */
async function normalisedState(projectDir: string): Promise<unknown> {
  const state: StateFile = await readState('project', projectDir);

  return {
    installations: state.installations
      .map((record: InstallationRecord) => ({
        id: record.id,
        bundle: record.bundle,
        version: record.version,
        target: record.target,
        scope: record.scope,
        source:
          record.source.type === 'local'
            ? { type: 'local', bundle: path.basename(record.source.path) }
            : record.source,
        receipts: record.receipts
          .map((receipt) => ({ ...receipt }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        ...(record.targetOptions ? { targetOptions: record.targetOptions } : {}),
        ...(record.flavors ? { flavors: record.flavors } : {}),
        ...(record.parameters ? { parameters: record.parameters } : {}),
        ...(record.dependencies ? { dependencies: record.dependencies } : {}),
        ...(record.auto ? { auto: true } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function copyDir(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(source, target);
    else await copyFileNormalising(source, target);
  }
}

/**
 * Copy one file, normalising CRLF to LF when it is text.
 *
 * A fresh Windows checkout with `core.autocrlf=true` hands the case inputs back
 * as CRLF. hcm hashes and writes whatever bytes it reads, so that checkout
 * would change every `file` receipt hash in `state.json`. Normalising here
 * keeps a case identical on any machine -- and honours the `readTree` contract
 * that hcm writes `\n`.
 *
 * Binary files are copied byte-for-byte: anything containing a NUL byte could
 * not survive a UTF-8 round trip, and git would not have re-endowed it anyway.
 */
async function copyFileNormalising(from: string, to: string): Promise<void> {
  const bytes = await fs.readFile(from);
  if (bytes.includes(0)) await fs.writeFile(to, bytes);
  else await fs.writeFile(to, normaliseText(bytes.toString('utf8')), 'utf8');
}

/** CRLF -> LF, the one line-ending difference git's autocrlf introduces. */
function normaliseText(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

// ---------------------------------------------------------------------------
// Debug entry point
// ---------------------------------------------------------------------------

/**
 * `npx tsx tests/run-case.ts <case-name> [--keep]`
 *
 * Prints what the case produced, with no test framework in the call stack --
 * put a breakpoint anywhere in `src/` and step. `--keep` leaves the scratch
 * project on disk and prints where, for poking at by hand.
 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  if (!name) {
    console.error('usage: tsx tests/run-case.ts <case-name> [--keep]');
    process.exit(2);
  }

  const keep = process.argv.includes('--keep')
    ? await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-case-'))
    : undefined;

  const result = await runCase(path.join(CASES_ROOT, name), keep ? { keep } : {});

  console.log(`--- ${name} ---`);
  for (const [file, contents] of Object.entries(result.tree)) {
    console.log(`\n=== ${file} ===\n${contents}`);
  }
  for (const [name_, document] of Object.entries(result.documents)) {
    console.log(
      `\n=== ${name_} ===\n` +
        (typeof document === 'string' ? document : JSON.stringify(document, null, JSON_INDENT)),
    );
  }
  if (keep) console.log(`\nworkspace kept at ${keep}`);
}
