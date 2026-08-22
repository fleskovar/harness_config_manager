/**
 * "Into which harness?" -- asked, rather than assumed.
 *
 * `hcm install my-kit` with no `-t` used to mean one of two things, neither of
 * them what anybody typed. In a folder set up for one harness it meant "all
 * five of them", which quietly created `.reasonix/`, `.pi/` and the rest. In a
 * folder set up for several, `requireTargetChoice` refused the command outright
 * -- a reasonable thing to do to a script, and a poor thing to do to someone
 * sitting at a terminal who can simply be asked.
 *
 * So install asks, and the menu opens on what the folder already says about
 * itself: the harnesses hcm has installed into here, or -- before there is a
 * ledger to read -- the ones whose own directories are lying around.
 *
 * Three layers are tested, from the inside out:
 *
 *   initializedTargets  what the folder already says, and which of the two
 *                       sources of that answer wins
 *   chooseTargets       when there is a question at all, and what it opens with
 *   installCommand      that the answer is what actually gets written, and that
 *                       supplying `-t` still skips the whole thing
 *
 * `targetChooser` is the test seam: it stands in for the terminal, and every
 * test that uses it also asserts on the question it was handed, because a menu
 * that offers the wrong options is as broken as one that ignores the answer.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import {
  chooseTargets,
  initializedTargets,
  type TargetQuestion,
} from '../src/core/harnesses.js';
import { configureLogger } from '../src/core/logger.js';
import { readSelection } from '../src/core/prompt.js';
import { readState } from '../src/core/state.js';
import type { TargetId } from '../src/core/types.js';
import { TARGET_IDS } from '../src/targets/index.js';
import { makeWorkspace } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let kit: string;
let previousHome: string | undefined;

/** A bundle with one subagent, which lands somewhere different in every harness. */
async function makeBundle(name: string, targets?: TargetId[]): Promise<string> {
  const root = path.join(workspace, name);
  await fs.mkdir(path.join(root, 'subagents'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'hcm.yaml'),
    `name: ${name}\nversion: 1.0.0\n` + (targets ? `targets: [${targets.join(', ')}]\n` : ''),
  );
  await fs.writeFile(
    path.join(root, 'subagents', `${name}-reviewer.md`),
    `---\ndescription: Reviews ${name}\n---\n\nReview it.\n`,
  );
  return root;
}

beforeEach(async () => {
  workspace = await makeWorkspace('target-selection');
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });
  kit = await makeBundle('review-kit');

  previousHome = process.env.HCM_HOME;
  process.env.HCM_HOME = path.join(workspace, 'home');
  configureLogger({ quiet: true });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HCM_HOME;
  else process.env.HCM_HOME = previousHome;
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

/** Set a harness's own directory up in the project, without installing anything. */
const setUpHarness = (relative: string): Promise<string | undefined> =>
  fs.mkdir(path.join(projectDir, relative), { recursive: true });

/** The harnesses the ledger says something was installed into. */
const installedTargets = async (): Promise<TargetId[]> =>
  [...new Set((await readState('project', projectDir)).installations.map((r) => r.target))].sort();

/**
 * A stand-in for the terminal that answers with `answer` and records what it
 * was asked, so a test can assert on the menu as well as on the outcome.
 */
function chooser(answer: TargetId[]): {
  answer: TargetChooserSpy;
  asked: TargetQuestion[];
} {
  const asked: TargetQuestion[] = [];
  return {
    answer: (question) => {
      asked.push(question);
      return Promise.resolve(answer);
    },
    asked,
  };
}

type TargetChooserSpy = (question: TargetQuestion) => Promise<TargetId[]>;

// ---------------------------------------------------------------------------

describe('what the folder already says about itself', () => {
  it('is nothing at all in a fresh checkout', async () => {
    expect(await initializedTargets('project', projectDir, TARGET_IDS)).toEqual([]);
  });

  it('is the harnesses whose own directories are here, before anything is installed', async () => {
    await setUpHarness('.claude');
    await setUpHarness('.pi');

    expect(await initializedTargets('project', projectDir, TARGET_IDS)).toEqual([
      'claude-code',
      'pi',
    ]);
  });

  it('is what hcm has installed here once there is a ledger to read', async () => {
    await installCommand(kit, {
      targets: ['reasonix'],
      scope: 'project',
      cwd: projectDir,
      onConflict: 'abort',
    });

    expect(await initializedTargets('project', projectDir, TARGET_IDS)).toEqual(['reasonix']);
  });

  it('prefers the ledger, because an install here is a decision and a directory is not', async () => {
    // `hcm install -t reasonix` creates `.reasonix/`, so both sources have
    // something to say. Only one of them is the user's answer.
    await setUpHarness('.claude');
    await installCommand(kit, {
      targets: ['reasonix'],
      scope: 'project',
      cwd: projectDir,
      onConflict: 'abort',
    });

    expect(await initializedTargets('project', projectDir, TARGET_IDS)).toEqual(['reasonix']);
  });

  it('never names a harness that is not on offer', async () => {
    await setUpHarness('.claude');
    await setUpHarness('.pi');

    expect(await initializedTargets('project', projectDir, ['pi'])).toEqual(['pi']);
  });
});

// ---------------------------------------------------------------------------

describe('whether there is a question to ask', () => {
  const ask = (
    available: TargetId[],
    answer: TargetId[],
  ): Promise<TargetId[] | undefined> =>
    chooseTargets({
      available,
      scope: 'project',
      cwd: projectDir,
      chooser: () => Promise.resolve(answer),
    });

  it('does not ask when the bundle supports only one harness', async () => {
    expect(await ask(['pi'], ['pi'])).toBeUndefined();
  });

  it('does not ask without a terminal and without a chooser', async () => {
    // vitest is not a TTY, which is the same position a CI run is in.
    expect(
      await chooseTargets({ available: TARGET_IDS, scope: 'project', cwd: projectDir }),
    ).toBeUndefined();
  });

  it('does not ask when prompting is off, however many harnesses are on offer', async () => {
    const spy = chooser(['pi']);

    expect(
      await chooseTargets({
        available: TARGET_IDS,
        scope: 'project',
        cwd: projectDir,
        chooser: spy.answer,
        prompt: false,
      }),
    ).toBeUndefined();
    expect(spy.asked).toHaveLength(0);
  });

  it('treats an answer of nothing as "you decide", not as "install nowhere"', async () => {
    expect(await ask(TARGET_IDS, [])).toBeUndefined();
  });
});

describe('what the question opens with', () => {
  const question = async (available: TargetId[] = TARGET_IDS): Promise<TargetQuestion> => {
    const spy = chooser(['pi']);
    await chooseTargets({
      available,
      scope: 'project',
      cwd: projectDir,
      chooser: spy.answer,
    });
    return spy.asked[0] as TargetQuestion;
  };

  it('ticks the harnesses this folder is already set up for', async () => {
    await setUpHarness('.claude');
    await setUpHarness('.pi');

    const asked = await question();
    expect(asked.here).toEqual(['claude-code', 'pi']);
    expect(asked.preselected).toEqual(['claude-code', 'pi']);
  });

  it('ticks everything in a folder that is set up for nothing, as it always installed', async () => {
    const asked = await question();

    expect(asked.here).toEqual([]);
    expect(asked.preselected).toEqual(TARGET_IDS);
  });

  it('offers only what it was given, so an unsupported harness is never on the menu', async () => {
    const asked = await question(['claude-code', 'pi']);

    expect(asked.available).toEqual(['claude-code', 'pi']);
  });
});

// ---------------------------------------------------------------------------

describe('hcm install with no -t', () => {
  const install = (options: Partial<Parameters<typeof installCommand>[1]> = {}): Promise<void> =>
    installCommand(kit, { scope: 'project', cwd: projectDir, onConflict: 'abort', ...options });

  it('installs into exactly the harnesses that were picked', async () => {
    const spy = chooser(['claude-code', 'pi']);

    await install({ targetChooser: spy.answer });

    expect(await installedTargets()).toEqual(['claude-code', 'pi']);
  });

  it('offers every harness the bundle supports', async () => {
    const spy = chooser(['pi']);

    await install({ targetChooser: spy.answer });

    expect(spy.asked).toHaveLength(1);
    expect(spy.asked[0]?.available).toEqual(TARGET_IDS);
  });

  it('offers only the harnesses the manifest declares', async () => {
    const narrow = await makeBundle('claude-only-kit', ['claude-code', 'pi']);
    const spy = chooser(['pi']);

    await installCommand(narrow, {
      scope: 'project',
      cwd: projectDir,
      onConflict: 'abort',
      targetChooser: spy.answer,
    });

    expect(spy.asked[0]?.available).toEqual(['claude-code', 'pi']);
  });

  it('opens on the harnesses of the last install, which is what re-running usually means', async () => {
    await install({ targets: ['reasonix'] });

    const spy = chooser(['reasonix']);
    await install({ targetChooser: spy.answer });

    expect(spy.asked[0]?.preselected).toEqual(['reasonix']);
    expect(spy.asked[0]?.here).toEqual(['reasonix']);
  });

  it('asks instead of refusing in a folder set up for more than one harness', async () => {
    // Without an answer this is the ambiguity gate's case, and it throws.
    await setUpHarness('.claude');
    await setUpHarness('.pi');
    await expect(install()).rejects.toThrow(/needs to be told which one to act on/);

    const spy = chooser(['claude-code']);
    await install({ targetChooser: spy.answer });

    expect(await installedTargets()).toEqual(['claude-code']);
  });

  it('does not ask when -t already said, and installs where it said', async () => {
    const spy = chooser(['pi']);

    await install({ targets: ['reasonix'], targetChooser: spy.answer });

    expect(spy.asked).toHaveLength(0);
    expect(await installedTargets()).toEqual(['reasonix']);
  });

  it('does not ask with --no-prompt, so a script behaves as it always did', async () => {
    const spy = chooser(['pi']);

    await install({ prompt: false, targetChooser: spy.answer });

    expect(spy.asked).toHaveLength(0);
    expect(await installedTargets()).toEqual([...TARGET_IDS].sort());
  });
});

// ---------------------------------------------------------------------------

describe('reading a multiple-choice answer', () => {
  const menu = [
    { value: 'claude-code' as const, label: 'Claude Code' },
    { value: 'copilot' as const, label: 'GitHub Copilot' },
    { value: 'pi' as const, label: 'Pi' },
  ];

  it('takes numbers, separated by spaces or commas or both', () => {
    expect(readSelection('1 3', menu)).toEqual(['claude-code', 'pi']);
    expect(readSelection('1,3', menu)).toEqual(['claude-code', 'pi']);
    expect(readSelection('1, 3', menu)).toEqual(['claude-code', 'pi']);
  });

  it('takes the names themselves, in any case', () => {
    expect(readSelection('pi CLAUDE-CODE', menu)).toEqual(['claude-code', 'pi']);
  });

  it('answers in menu order however the answer was typed', () => {
    expect(readSelection('3 1', menu)).toEqual(['claude-code', 'pi']);
  });

  it('takes "all" for every option, whatever else was typed beside it', () => {
    expect(readSelection('all', menu)).toEqual(['claude-code', 'copilot', 'pi']);
    expect(readSelection('2 all', menu)).toEqual(['claude-code', 'copilot', 'pi']);
  });

  it('counts one option said twice once', () => {
    expect(readSelection('1 1 claude-code', menu)).toEqual(['claude-code']);
  });

  it('refuses an answer that names something not on the menu', () => {
    // The whole answer, not the part it understood: a typo that quietly
    // selected less than was meant is the one outcome a menu must not have.
    expect(readSelection('1 rust', menu)).toBeUndefined();
    expect(readSelection('4', menu)).toBeUndefined();
    expect(readSelection('0', menu)).toBeUndefined();
    expect(readSelection('1x', menu)).toBeUndefined();
  });

  it('refuses an answer that names nothing', () => {
    expect(readSelection('', menu)).toBeUndefined();
    expect(readSelection('   ', menu)).toBeUndefined();
  });
});
