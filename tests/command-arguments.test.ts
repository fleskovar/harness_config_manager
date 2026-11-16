/**
 * Command arguments that a harness does not replace.
 *
 * A command body can use `$ARGUMENTS`, `$1`, `$2`. The harness fills them each
 * time the command runs. GitHub Copilot (IDE) and GitHub Copilot CLI do not, so
 * there the model gets the literal text. The install does not fail, so hcm
 * warns about it:
 *
 *   hcm validate   for every harness the bundle can go into; not a failure
 *   hcm install    for the harnesses of this run, before the first question
 *
 * The rule is in `src/core/command-arguments.ts`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { validateCommand } from '../src/commands/validate.js';
import { loadBundle } from '../src/core/bundle.js';
import {
  argumentTokens,
  commandArgumentIssues,
  commandArgumentWarnings,
} from '../src/core/command-arguments.js';
import { configureLogger } from '../src/core/logger.js';
import { makeWorkspace } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await makeWorkspace('command-arguments');
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });

  previousHome = process.env.HCM_HOME;
  process.env.HCM_HOME = path.join(workspace, 'home');
  delete process.env.HCM_REQUIRE_TARGET;
  configureLogger({ quiet: true });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HCM_HOME;
  else process.env.HCM_HOME = previousHome;
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

const WITH_ARGUMENTS = '---\ndescription: Plans a migration\n---\n\nMigrate `$1` to `$2`. Notes: $ARGUMENTS.\n';
const WITHOUT_ARGUMENTS = '---\ndescription: Reviews a pull request\n---\n\nReview it.\n';

/** A bundle made of exactly the files named, plus a manifest. */
async function makeKit(files: Record<string, string>, manifest = ''): Promise<string> {
  const root = path.join(workspace, 'kit');
  const all = { 'hcm.yaml': `name: kit\nversion: 1.0.0\n${manifest}`, ...files };

  for (const [relative, contents] of Object.entries(all)) {
    const target = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  return root;
}

/** Every line that `log.warn` writes while `run` runs, also when `run` fails. */
async function captureWarnings(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };

  try {
    await run();
  } catch {
    // The caller asserts on what was said before the failure.
  } finally {
    console.warn = original;
  }

  return lines;
}

// ---------------------------------------------------------------------------

describe('finding argument tokens in a command body', () => {
  it('finds $ARGUMENTS and numbered arguments, each one time, in order', () => {
    expect(argumentTokens('Use $2, then $1, then $ARGUMENTS, then $1 again')).toEqual([
      '$2',
      '$1',
      '$ARGUMENTS',
    ]);
  });

  it('finds $ARGUMENTS before an index or punctuation', () => {
    expect(argumentTokens('First: $ARGUMENTS[0]. All: `$ARGUMENTS`.')).toEqual(['$ARGUMENTS']);
  });

  it('ignores $0, other names, and text with no $', () => {
    expect(argumentTokens('Price $0, $HOME, $ARGUMENTSX, ${input:name}, plain text')).toEqual([]);
  });

  it('ignores <%NAME%> parameters, which hcm fills at install time', () => {
    expect(argumentTokens('You work for the <%TEAM%> team.')).toEqual([]);
  });
});

describe('which commands and harnesses are affected', () => {
  it('names the Copilot harnesses for a bundle that installs everywhere', async () => {
    const bundle = await loadBundle(await makeKit({ 'commands/migrate.md': WITH_ARGUMENTS }));

    expect(commandArgumentIssues(bundle, ['claude-code', 'copilot', 'copilot-cli', 'pi'])).toEqual([
      {
        bundle: 'kit',
        bundlePath: 'commands/migrate.md',
        tokens: ['$1', '$2', '$ARGUMENTS'],
        targets: ['copilot', 'copilot-cli'],
      },
    ]);
  });

  it('is empty when the run installs only into harnesses that replace arguments', async () => {
    const bundle = await loadBundle(await makeKit({ 'commands/migrate.md': WITH_ARGUMENTS }));

    expect(commandArgumentIssues(bundle, ['claude-code', 'opencode', 'reasonix', 'pi'])).toEqual([]);
  });

  it('is empty for a command with no arguments', async () => {
    const bundle = await loadBundle(await makeKit({ 'commands/review.md': WITHOUT_ARGUMENTS }));

    expect(commandArgumentIssues(bundle, ['copilot'])).toEqual([]);
  });

  it('leaves out a harness that the manifest does not declare', async () => {
    const bundle = await loadBundle(
      await makeKit({ 'commands/migrate.md': WITH_ARGUMENTS }, 'targets: [claude-code, copilot]\n'),
    );

    expect(commandArgumentIssues(bundle, ['copilot', 'copilot-cli'])[0]?.targets).toEqual(['copilot']);
  });

  it('leaves out a command that is not in the flavors of the run', async () => {
    const bundle = await loadBundle(
      await makeKit(
        {
          'commands/migrate.md':
            '---\ndescription: Plans a migration\nflavors: [python]\n---\n\nMigrate `$1`.\n',
        },
        'flavors: [python, csharp]\n',
      ),
    );

    expect(commandArgumentIssues(bundle, ['copilot'], ['csharp'])).toEqual([]);
    expect(commandArgumentIssues(bundle, ['copilot'], ['python'])).toHaveLength(1);
  });
});

describe('hcm validate', () => {
  it('warns, names the file, the tokens and the harnesses, and does not fail', async () => {
    const kit = await makeKit({ 'commands/migrate.md': WITH_ARGUMENTS });

    let ok: boolean | undefined;
    const warnings = await captureWarnings(async () => {
      ok = await validateCommand(kit, { cwd: projectDir });
    });

    expect(ok).toBe(true);
    expect(warnings.join('\n')).toContain(
      'commands/migrate.md: uses $1, $2, $ARGUMENTS, which GitHub Copilot and GitHub Copilot CLI ' +
        'do not replace; the command gets the literal text there',
    );
  });

  it('says nothing when the manifest declares no Copilot harness', async () => {
    const kit = await makeKit({ 'commands/migrate.md': WITH_ARGUMENTS }, 'targets: [claude-code]\n');

    expect(commandArgumentWarnings(await loadBundle(kit))).toEqual([]);
  });
});

describe('hcm install', () => {
  it('warns for a Copilot target', async () => {
    const kit = await makeKit({ 'commands/migrate.md': WITH_ARGUMENTS });

    const warnings = await captureWarnings(() =>
      installCommand(kit, { targets: ['copilot'], scope: 'project', cwd: projectDir, onConflict: 'abort' }),
    );

    expect(warnings.join('\n')).toContain(
      'kit: commands/migrate.md: uses $1, $2, $ARGUMENTS, which GitHub Copilot does not replace',
    );
  });

  it('says nothing for a harness that replaces arguments', async () => {
    const kit = await makeKit({ 'commands/migrate.md': WITH_ARGUMENTS });

    const warnings = await captureWarnings(() =>
      installCommand(kit, { targets: ['claude-code'], scope: 'project', cwd: projectDir, onConflict: 'abort' }),
    );

    expect(warnings.join('\n')).not.toMatch(/does not replace|do not replace/);
  });

  it('warns before it asks for a parameter, so the user can stop the run first', async () => {
    // TEAM is required and nobody gives it. The run stops at the question, and
    // the warning must already be out by then.
    const kit = await makeKit(
      { 'commands/migrate.md': '---\ndescription: Plans a migration\n---\n\n<%TEAM%>: migrate `$1`.\n' },
      'parameters: [TEAM]\n',
    );

    const warnings = await captureWarnings(() =>
      installCommand(kit, {
        targets: ['copilot-cli'],
        scope: 'project',
        cwd: projectDir,
        onConflict: 'abort',
        prompt: false,
      }),
    );

    expect(warnings.join('\n')).toContain('which GitHub Copilot CLI does not replace');
    await expect(fs.readdir(path.join(projectDir, '.github'))).rejects.toThrow();
  });
});
