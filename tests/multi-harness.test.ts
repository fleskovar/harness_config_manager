/**
 * One folder, several harnesses.
 *
 * A project directory is not one harness's. The same checkout can hold
 * `.claude/`, `.reasonix/` and `.pi/` because the person working in it uses all
 * three -- and then "install this bundle" stops being a complete instruction,
 * because it does not say into which of them.
 *
 * Three things are asserted here, in that order:
 *
 *   detection  which harnesses a folder is used by, from their own files and
 *              from hcm's ledger
 *   the gate   a command that would span several of them is refused until it
 *              is told which one, and `-t all` is how you say "every one"
 *   overlap    `.mcp.json` and `AGENTS.md` are read by more than one harness,
 *              so an install into one reaches the others, and an uninstall
 *              from one does not necessarily take it away from them
 *
 * The last is the interesting one. It is not a bug to be fixed -- one file
 * cannot be two -- so what is tested is that hcm knows it and says so.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { uninstallCommand } from '../src/commands/uninstall.js';
import { detectHarnesses, expandTargets } from '../src/core/harnesses.js';
import { configureLogger } from '../src/core/logger.js';
import { sharedFileNotices, sharedFiles } from '../src/core/overlap.js';
import { readState } from '../src/core/state.js';
import type { TargetId } from '../src/core/types.js';
import { exists, makeWorkspace, readJson } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let kit: string;
let previousHome: string | undefined;

/**
 * A bundle with one item of each kind that lands in a shared file -- an MCP
 * server (`.mcp.json`) and a context section (`AGENTS.md`) -- plus a subagent,
 * which lands somewhere different in every harness and so is the control.
 */
async function makeBundle(name: string, targets?: TargetId[]): Promise<string> {
  const root = path.join(workspace, name);
  const files: Record<string, string> = {
    'hcm.yaml':
      `name: ${name}\nversion: 1.0.0\n` +
      (targets ? `targets: [${targets.join(', ')}]\n` : ''),
    'mcp/light-plan.json': JSON.stringify({ command: 'light-plan', args: ['--stdio'] }),
    'context/10-conventions.md': '## Conventions\n\n- Keep the diff small.\n',
    [`subagents/${name}-reviewer.md`]: `---\ndescription: Reviews ${name}\n---\n\nReview it.\n`,
  };

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  return root;
}

const install = (targets: string[], reference = kit): Promise<void> =>
  installCommand(reference, { targets, scope: 'project', cwd: projectDir, onConflict: 'abort' });

const installed = async (): Promise<string[]> =>
  (await readState('project', projectDir)).installations.map((record) => record.id).sort();

const detected = async (): Promise<TargetId[]> =>
  (await detectHarnesses('project', projectDir)).map((harness) => harness.target);

beforeEach(async () => {
  workspace = await makeWorkspace('multi-harness');
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });
  kit = await makeBundle('light-kit');

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

// ---------------------------------------------------------------------------

describe('detecting the harnesses a folder is used by', () => {
  it('finds nothing in an empty folder', async () => {
    expect(await detected()).toEqual([]);
  });

  it('finds a harness from files it did not install', async () => {
    // The usual case: the harness was set up long before hcm was involved.
    await fs.mkdir(path.join(projectDir, '.claude', 'agents'), { recursive: true });
    await fs.mkdir(path.join(projectDir, '.reasonix'), { recursive: true });

    expect(await detected()).toEqual(['claude-code', 'reasonix']);
  });

  it('ignores the files no single harness owns', async () => {
    // Both of these are read by two harnesses, so finding one says nothing
    // about which harness put it there -- and guessing would be worse than
    // admitting it, since the whole gate below is built on this answer.
    await fs.writeFile(path.join(projectDir, 'AGENTS.md'), '# Notes\n');
    await fs.writeFile(path.join(projectDir, '.mcp.json'), '{}\n');

    expect(await detected()).toEqual([]);
  });

  it('finds a harness hcm installed into, before its own files exist', async () => {
    await install(['pi']);
    const found = await detectHarnesses('project', projectDir);

    expect(found.map((harness) => harness.target)).toEqual(['pi']);
    expect(found[0]?.installed).toBe(true);
  });

  it('reports what the evidence was', async () => {
    await fs.writeFile(path.join(projectDir, 'CLAUDE.md'), '# Project\n');
    const found = await detectHarnesses('project', projectDir);

    expect(found).toEqual([
      { target: 'claude-code', root: projectDir, markers: ['CLAUDE.md'], installed: false },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('installing into several harnesses', () => {
  it('keeps one record per harness, each with its own receipts', async () => {
    await install(['claude-code', 'reasonix', 'pi']);

    expect(await installed()).toEqual([
      'light-kit@claude-code@project',
      'light-kit@pi@project',
      'light-kit@reasonix@project',
    ]);

    // Each record holds only its own harness's paths -- the ledger is what
    // makes uninstalling from one of them exact.
    const state = await readState('project', projectDir);
    const paths = (target: TargetId): string[] =>
      (state.installations.find((record) => record.target === target)?.receipts ?? [])
        .map((receipt) => receipt.path)
        .sort();

    expect(paths('claude-code')).toContain('.claude/agents/light-kit-reviewer.md');
    expect(paths('reasonix')).toContain('.reasonix/skills/light-kit-reviewer/SKILL.md');
    expect(paths('pi')).toContain('.pi/skills/light-kit-reviewer/SKILL.md');
  });

  it('adds a harness to a folder that already has one', async () => {
    await install(['claude-code']);
    await install(['reasonix']);

    expect(await installed()).toEqual([
      'light-kit@claude-code@project',
      'light-kit@reasonix@project',
    ]);
    expect(await detected()).toEqual(['claude-code', 'reasonix']);
  });
});

// ---------------------------------------------------------------------------

describe('the ambiguity gate', () => {
  /** Two harnesses on disk, so every blanket command below is ambiguous. */
  async function makeMultiHarnessFolder(): Promise<void> {
    await fs.mkdir(path.join(projectDir, '.claude'), { recursive: true });
    await fs.mkdir(path.join(projectDir, '.reasonix'), { recursive: true });
  }

  it('refuses an install that would span harnesses nobody named', async () => {
    await makeMultiHarnessFolder();

    await expect(
      installCommand(kit, { scope: 'project', cwd: projectDir }),
    ).rejects.toThrow(/set up for more than one harness \(Claude Code and Reasonix\)/);

    // Nothing was written: the gate closes before the first plan is applied.
    expect(await installed()).toEqual([]);
    expect(await exists(projectDir, '.mcp.json')).toBe(false);
  });

  it('accepts a named harness', async () => {
    await makeMultiHarnessFolder();
    await install(['claude-code']);

    expect(await installed()).toEqual(['light-kit@claude-code@project']);
  });

  it('accepts "all" as the answer', async () => {
    await makeMultiHarnessFolder();
    await install(['all']);

    const records = (await readState('project', projectDir)).installations;
    expect(records).toHaveLength(5);
  });

  it('says nothing in a folder used by one harness', async () => {
    // One harness is not ambiguous: there is nothing to ask.
    await fs.mkdir(path.join(projectDir, '.claude'), { recursive: true });
    await installCommand(kit, { scope: 'project', cwd: projectDir });

    expect((await readState('project', projectDir)).installations).toHaveLength(5);
  });

  it('lets a bundle that supports one harness through untouched', async () => {
    await makeMultiHarnessFolder();
    const single = await makeBundle('pi-only-kit', ['pi']);

    // The manifest already answers the question, so there is nothing to ask.
    await installCommand(single, { scope: 'project', cwd: projectDir });
    expect(await installed()).toEqual(['pi-only-kit@pi@project']);
  });

  it('refuses an uninstall that would span harnesses', async () => {
    await install(['claude-code', 'reasonix']);

    await expect(
      uninstallCommand('light-kit', { scope: 'project', cwd: projectDir }),
    ).rejects.toThrow(/"hcm uninstall light-kit" needs to be told which one/);

    expect(await installed()).toHaveLength(2);
  });

  it('lets an uninstall through when the bundle is only in one harness', async () => {
    // Two harnesses in the folder, but this bundle is in one of them -- so the
    // command is unambiguous and the gate stays out of the way.
    await fs.mkdir(path.join(projectDir, '.reasonix'), { recursive: true });
    await install(['claude-code']);

    await uninstallCommand('light-kit', { scope: 'project', cwd: projectDir });
    expect(await installed()).toEqual([]);
  });

  it('honours requireTarget=never', async () => {
    await makeMultiHarnessFolder();
    process.env.HCM_REQUIRE_TARGET = 'never';

    try {
      await installCommand(kit, { scope: 'project', cwd: projectDir });
      expect((await readState('project', projectDir)).installations).toHaveLength(5);
    } finally {
      delete process.env.HCM_REQUIRE_TARGET;
    }
  });

  it('honours requireTarget=always in a folder with no harness at all', async () => {
    process.env.HCM_REQUIRE_TARGET = 'always';

    try {
      await expect(
        installCommand(kit, { scope: 'project', cwd: projectDir }),
      ).rejects.toThrow(/requireTarget is set to "always"/);
    } finally {
      delete process.env.HCM_REQUIRE_TARGET;
    }
  });

  it('expands "all" and rejects a name that is not a harness', () => {
    expect(expandTargets(undefined)).toBeUndefined();
    expect(expandTargets([])).toBeUndefined();
    expect(expandTargets(['all'])).toEqual([
      'claude-code',
      'copilot',
      'reasonix',
      'opencode',
      'pi',
    ]);
    expect(expandTargets(['pi', 'claude-code'])).toEqual(['pi', 'claude-code']);
    expect(() => expandTargets(['nope'])).toThrow(/Unknown target "nope"/);
  });
});

// ---------------------------------------------------------------------------

describe('the files two harnesses share', () => {
  it('finds the overlaps between harness layouts', () => {
    const shared = sharedFiles(['claude-code', 'pi'], 'project', projectDir);
    expect(shared.map((file) => file.readers[0]?.path)).toEqual(['.mcp.json']);

    const agents = sharedFiles(['opencode', 'pi'], 'project', projectDir);
    expect(agents.map((file) => file.readers[0]?.path)).toEqual(['AGENTS.md']);
  });

  it('finds none between harnesses that keep to themselves', () => {
    expect(sharedFiles(['claude-code', 'copilot'], 'project', projectDir)).toEqual([]);
    expect(sharedFiles(['claude-code', 'reasonix'], 'project', projectDir)).toEqual([]);
  });

  it('says which kinds land in the shared file', () => {
    const [mcp] = sharedFiles(['claude-code', 'pi'], 'project', projectDir);
    expect(mcp?.readers.map((reader) => ({ target: reader.target, kinds: reader.kinds }))).toEqual([
      { target: 'claude-code', kinds: ['mcp'] },
      { target: 'pi', kinds: ['mcp'] },
    ]);
  });

  it('only flags a path when the other harness is actually here', () => {
    const notices = (present: TargetId[]) =>
      sharedFileNotices({
        target: 'claude-code',
        paths: ['.mcp.json', '.claude/agents/x.md'],
        scope: 'project',
        cwd: projectDir,
        present,
      });

    expect(notices(['claude-code'])).toEqual([]);
    expect(notices(['claude-code', 'copilot'])).toEqual([]);
    expect(notices(['claude-code', 'pi'])).toEqual([{ path: '.mcp.json', others: ['pi'] }]);
  });
});

// ---------------------------------------------------------------------------

describe('uninstalling from one harness when the file is shared', () => {
  /**
   * The case the whole feature exists for. `.mcp.json` is read by Claude Code
   * and by Pi. Install into both, uninstall from Pi, and the server stays --
   * because Claude Code still claims it -- which means Pi, reading the same
   * file, still has the server it was just "uninstalled" from.
   */
  it('leaves the server in place, and Pi still reads it', async () => {
    await install(['claude-code', 'pi']);
    expect(await readJson(projectDir, '.mcp.json')).toHaveProperty(
      'mcpServers.light-plan.command',
      'light-plan',
    );

    await uninstallCommand('light-kit', {
      targets: ['pi'],
      scope: 'project',
      cwd: projectDir,
    });

    // The ledger no longer says Pi has it...
    expect(await installed()).toEqual(['light-kit@claude-code@project']);
    // ...but the file Pi reads is unchanged, which is the surprise hcm warns
    // about: uninstalling for one harness cannot take it from the other.
    expect(await readJson(projectDir, '.mcp.json')).toHaveProperty(
      'mcpServers.light-plan.command',
      'light-plan',
    );
    // Pi's own files, which nothing else reads, are gone.
    expect(await exists(projectDir, '.pi/skills/light-kit-reviewer/SKILL.md')).toBe(false);
    expect(await exists(projectDir, '.claude/agents/light-kit-reviewer.md')).toBe(true);
  });

  it('takes the shared item away with the last harness holding it', async () => {
    await install(['claude-code', 'pi']);

    await uninstallCommand('light-kit', { targets: ['pi'], scope: 'project', cwd: projectDir });
    await uninstallCommand('light-kit', {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
    });

    expect(await installed()).toEqual([]);
    expect(await exists(projectDir, '.mcp.json')).toBe(false);
  });

  it('warns that the item was held, naming the harness that still sees it', async () => {
    await install(['claude-code', 'pi']);

    const warnings = await captureWarnings(() =>
      uninstallCommand('light-kit', { targets: ['pi'], scope: 'project', cwd: projectDir }),
    );

    expect(warnings.join('\n')).toMatch(
      /\.mcp\.json is shared with Claude Code: 1 item\(s\) were left in place/,
    );
  });

  it('warns on the way in, too', async () => {
    // Pi is set up here; installing an MCP server for Claude Code alone still
    // puts it somewhere Pi will read it.
    await fs.mkdir(path.join(projectDir, '.pi'), { recursive: true });

    const warnings = await captureWarnings(() => install(['claude-code']));

    expect(warnings.join('\n')).toMatch(/\.mcp\.json is shared with Pi/);
  });

  it('says nothing about a harness the folder does not use', async () => {
    const warnings = await captureWarnings(() => install(['claude-code']));
    expect(warnings.join('\n')).not.toMatch(/shared with/);
  });
});

/**
 * Warnings are the whole point of the overlap machinery -- advice reaching
 * somebody who was not expecting it -- so they are worth asserting on. They go
 * through `log.warn`, which prints whatever `--quiet` says, so nothing about
 * the logger needs changing to catch them.
 */
async function captureWarnings(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };

  try {
    await run();
  } finally {
    console.warn = original;
  }

  return lines;
}
