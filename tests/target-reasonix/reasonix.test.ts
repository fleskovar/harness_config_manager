/**
 * Everything `sample-kit` ships, installed into Reasonix.
 *
 * This folder is the whole test: `input/sample-kit` goes in, `expected/` is
 * what has to come out, and the test below is the sentence "install one into an
 * empty project and you get the other". Both sides are files you can open.
 *
 *   npx tsx src/cli.ts install tests/target-reasonix/input/sample-kit -t reasonix
 *   diff -r . <repo>/tests/target-reasonix/expected
 *
 * Reasonix is where the bundle's vocabulary bends furthest, so `expected/` has
 * two fewer files than the Claude Code one and three things worth looking at:
 *
 *   subagent  no agents directory -- it is a skill carrying `runAs: subagent`,
 *             which puts it in the same namespace as the real skill
 *   rule      no glob-scoped rule format -- it joins context in REASONIX.md,
 *             with its globs stated in prose for the model to honour
 *   mcp       reasonix.toml, as a `[[plugins]]` entry inside a marker block,
 *             appended rather than merged so the file's comments survive
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../../src/commands/install.js';
import { configureLogger } from '../../src/core/logger.js';
import { parseToml } from '../../src/merge/toml.js';
import {
  copyDirectory,
  listTree,
  makeWorkspace,
  readText,
  readTree,
} from '../support/fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const INPUT = path.join(here, 'input', 'sample-kit');
const EXPECTED = path.join(here, 'expected');

let workspace: string;
let projectDir: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await makeWorkspace('target-reasonix');
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });

  // The registry, store and user-scope state go inside the workspace, so no
  // test reads or writes the machine's real ~/.hcm.
  previousHome = process.env.HCM_HOME;
  process.env.HCM_HOME = path.join(workspace, 'home');
  configureLogger({ quiet: true });

  // A copy, because installing reads the bundle and nothing should be able to
  // reach back into the checked-in fixture.
  const kit = await copyDirectory(INPUT, path.join(workspace, 'sample-kit'));
  await installCommand(kit, { targets: ['reasonix'], scope: 'project', cwd: projectDir });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HCM_HOME;
  else process.env.HCM_HOME = previousHome;
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('sample-kit into Reasonix', () => {
  it('produces exactly the tree in expected/', async () => {
    expect(await readTree(projectDir)).toEqual(await readTree(EXPECTED));
  });

  it('files one resource of each kind where Reasonix looks for it', async () => {
    expect(await listTree(projectDir)).toEqual([
      '.reasonix/commands/review-pr.md', // command
      '.reasonix/skills/code-reviewer/SKILL.md', // subagent -- a skill here
      '.reasonix/skills/dependency-audit/SKILL.md', // skill
      '.reasonix/skills/dependency-audit/checklist.md',
      'REASONIX.md', // context *and* rule
      'reasonix.toml', // mcp *and* settings
    ]);
  });

  it('writes the subagent as a manually-invoked subagent skill', async () => {
    const agent = await readText(projectDir, '.reasonix/skills/code-reviewer/SKILL.md');

    expect(agent).toContain('name: code-reviewer');
    // What makes a skill file a subagent profile, and keeps it out of the
    // pinned skill index so it is only ever called by name.
    expect(agent).toContain('runAs: subagent');
    expect(agent).toContain('invocation: manual');
    // A profile-level allowlist, written as a YAML list under its own key.
    expect(agent).toContain(
      'allowed-tools:\n  - Read\n  - Grep\n  - Bash\n  - mcp__filesystem__read_text_file',
    );
    // Reasonix profiles do have a colour, so unlike Claude Code's this survives.
    expect(agent).toContain('color: blue');
    expect(agent).toContain('model: sonnet');
  });

  it('names the skill and keeps its supporting files verbatim', async () => {
    const skill = await readText(projectDir, '.reasonix/skills/dependency-audit/SKILL.md');

    expect(skill).toContain('name: dependency-audit');
    // The two share `skills/`, which is why `hcm validate` insists their names differ.
    expect(skill).not.toContain('runAs: subagent');
    expect(await readText(projectDir, '.reasonix/skills/dependency-audit/checklist.md')).toBe(
      await readText(INPUT, 'skills/dependency-audit/checklist.md'),
    );
  });

  it('keeps the command’s argument hint and drops the tools it cannot scope', async () => {
    const command = await readText(projectDir, '.reasonix/commands/review-pr.md');

    expect(command).toContain('argument-hint: "[base-branch]"');
    expect(command).not.toContain('allowed-tools');
  });

  it('puts the rule in REASONIX.md, its globs stated in prose', async () => {
    const reasonixMd = await readText(projectDir, 'REASONIX.md');

    // A block of its own, so it is removable on its own.
    expect(reasonixMd).toContain('<!-- hcm:begin sample-kit/rules/typescript -->');
    expect(reasonixMd).toContain('<!-- hcm:end sample-kit/rules/typescript -->');
    // No loader here can enforce the globs, so they are said out loud instead.
    expect(reasonixMd).toContain('**Applies to:** `**/*.ts`, `**/*.tsx`');
  });

  it('writes both context sections into REASONIX.md, in filename order', async () => {
    const reasonixMd = await readText(projectDir, 'REASONIX.md');

    expect(reasonixMd).toContain('<!-- hcm:begin sample-kit/10-conventions -->');
    expect(reasonixMd).toContain('<!-- hcm:end sample-kit/10-conventions -->');
    expect(reasonixMd).toContain('<!-- hcm:begin sample-kit/20-pull-requests -->');
    expect(reasonixMd.indexOf('## Review conventions')).toBeLessThan(
      reasonixMd.indexOf('## Pull requests'),
    );
    // The rule shares the file, and comes after the context sections.
    expect(reasonixMd.indexOf('## Pull requests')).toBeLessThan(
      reasonixMd.indexOf('**Applies to:**'),
    );
  });

  it('writes the MCP server as a [[plugins]] entry and the settings as a table', async () => {
    const toml = await readText(projectDir, 'reasonix.toml');

    // Both live in marker blocks: TOML files carry comments people care about,
    // so hcm appends and excises rather than parsing and restringifying.
    expect(toml).toContain('# hcm:begin sample-kit/plugins/filesystem');
    expect(toml).toContain('# hcm:end sample-kit/plugins/filesystem');
    expect(toml).toContain('# hcm:begin sample-kit/settings/settings');
    // `env` as an inline table, so the entry stays self-contained -- a
    // sub-table would rebind to whatever [[plugins]] header preceded it.
    expect(toml).toContain('env = { FS_LOG = "warn" }');

    // And it has to parse to the right thing, not merely contain the right text.
    expect(parseToml(toml)).toEqual({
      plugins: [
        {
          name: 'filesystem',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          env: { FS_LOG: 'warn' },
        },
      ],
      permissions: {
        defaultMode: 'acceptEdits',
        allow: ['Bash(git diff:*)', 'Bash(npm test:*)'],
      },
    });
  });

  it('repoints the bundle’s references at the Reasonix layout', async () => {
    const agent = await readText(projectDir, '.reasonix/skills/code-reviewer/SKILL.md');
    // The rule is not a file here, so a reference to it lands on REASONIX.md --
    // three directories up from a skill.
    expect(agent).toContain('`../../../REASONIX.md`');
    // Subagent and skill are siblings under skills/, so this is one hop.
    expect(agent).toContain('`../dependency-audit/checklist.md`');

    expect(await readText(projectDir, '.reasonix/skills/dependency-audit/SKILL.md')).toContain(
      '`../code-reviewer/SKILL.md`',
    );
    expect(await readText(projectDir, '.reasonix/commands/review-pr.md')).toContain(
      '`../skills/code-reviewer/SKILL.md`',
    );
    // REASONIX.md sits at the project root, so it has nothing to climb out of.
    expect(await readText(projectDir, 'REASONIX.md')).toContain(
      '`.reasonix/skills/dependency-audit/checklist.md`',
    );
  });
});
