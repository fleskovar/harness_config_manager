/**
 * Everything `sample-kit` ships, installed into Claude Code.
 *
 * This folder is the whole test: `input/sample-kit` goes in, `expected/` is
 * what has to come out, and the test below is the sentence "install one into an
 * empty project and you get the other". Both sides are files you can open.
 *
 *   npx tsx src/cli.ts install tests/target-claude-code/input/sample-kit -t claude-code
 *   diff -r . <repo>/tests/target-claude-code/expected
 *
 * Every path in `expected/` is the one the README's "Where things land" table
 * gives for Claude Code, and the individual `it`s below say what changed on the
 * way in -- the frontmatter Claude Code wants, and the references repointed at
 * the layout it files things under. The tree comparison is the exhaustive one;
 * the rest are there to name the thing that broke.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../../src/commands/install.js';
import { configureLogger } from '../../src/core/logger.js';
import {
  copyDirectory,
  listTree,
  makeWorkspace,
  readJson,
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
  workspace = await makeWorkspace('target-claude-code');
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
  await installCommand(kit, { targets: ['claude-code'], scope: 'project', cwd: projectDir });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HCM_HOME;
  else process.env.HCM_HOME = previousHome;
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('sample-kit into Claude Code', () => {
  it('produces exactly the tree in expected/', async () => {
    expect(await readTree(projectDir)).toEqual(await readTree(EXPECTED));
  });

  it('files one resource of each kind where Claude Code looks for it', async () => {
    expect(await listTree(projectDir)).toEqual([
      '.claude/agents/code-reviewer.md', // subagent
      '.claude/commands/review-pr.md', // command
      '.claude/rules/typescript.md', // rule
      '.claude/settings.json', // settings
      '.claude/skills/dependency-audit/SKILL.md', // skill
      '.claude/skills/dependency-audit/checklist.md',
      '.mcp.json', // mcp
      'CLAUDE.md', // context
    ]);
  });

  it('gives the subagent a comma-separated tools string, and drops what it cannot use', async () => {
    const agent = await readText(projectDir, '.claude/agents/code-reviewer.md');

    expect(agent).toContain('name: code-reviewer'); // added, from the filename
    expect(agent).toContain('tools: Read, Grep, Bash, mcp__filesystem__read_text_file');
    expect(agent).toContain('model: sonnet');
    // The bundle says `color: blue`; Claude Code's agent frontmatter has no
    // such field, so it goes rather than being passed through.
    expect(agent).not.toContain('color');
  });

  it('names the skill and keeps its supporting files verbatim', async () => {
    expect(await readText(projectDir, '.claude/skills/dependency-audit/SKILL.md')).toContain(
      'name: dependency-audit',
    );
    expect(await readText(projectDir, '.claude/skills/dependency-audit/checklist.md')).toBe(
      await readText(INPUT, 'skills/dependency-audit/checklist.md'),
    );
  });

  it('hyphenates the command’s frontmatter and joins its tools', async () => {
    const command = await readText(projectDir, '.claude/commands/review-pr.md');

    expect(command).toContain('argument-hint: "[base-branch]"'); // was argumentHint
    expect(command).toContain('allowed-tools: Read, Grep, Bash'); // was a YAML list
  });

  it('turns the rule’s appliesTo globs into paths', async () => {
    const rule = await readText(projectDir, '.claude/rules/typescript.md');

    expect(rule).toContain('paths:\n  - "**/*.ts"\n  - "**/*.tsx"');
    expect(rule).not.toContain('appliesTo');
  });

  it('writes the MCP server under mcpServers, verbatim', async () => {
    expect(await readJson(projectDir, '.mcp.json')).toEqual({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          env: { FS_LOG: 'warn' },
        },
      },
    });
  });

  it('merges the settings fragment into .claude/settings.json', async () => {
    expect(await readJson(projectDir, '.claude/settings.json')).toEqual({
      permissions: {
        defaultMode: 'acceptEdits',
        allow: ['Bash(git diff:*)', 'Bash(npm test:*)'],
      },
    });
  });

  it('writes both context sections into CLAUDE.md, in filename order', async () => {
    const claudeMd = await readText(projectDir, 'CLAUDE.md');

    expect(claudeMd).toContain('<!-- hcm:begin sample-kit/10-conventions -->');
    expect(claudeMd).toContain('<!-- hcm:end sample-kit/10-conventions -->');
    expect(claudeMd).toContain('<!-- hcm:begin sample-kit/20-pull-requests -->');
    // 10- before 20-: the numeric prefixes are what orders the sections.
    expect(claudeMd.indexOf('## Review conventions')).toBeLessThan(
      claudeMd.indexOf('## Pull requests'),
    );
  });

  it('repoints the bundle’s references at the Claude Code layout', async () => {
    // Each of these is "from where this file landed, how do you reach where
    // that file landed" -- countable by hand from the file list above.
    const agent = await readText(projectDir, '.claude/agents/code-reviewer.md');
    expect(agent).toContain('`../rules/typescript.md`');
    expect(agent).toContain('`../skills/dependency-audit/checklist.md`');

    const skill = await readText(projectDir, '.claude/skills/dependency-audit/SKILL.md');
    expect(skill).toContain('`checklist.md`'); // same directory, unchanged
    expect(skill).toContain('`../../agents/code-reviewer.md`');

    // CLAUDE.md sits at the project root, so it has nothing to climb out of.
    expect(await readText(projectDir, 'CLAUDE.md')).toContain(
      '`.claude/skills/dependency-audit/checklist.md`',
    );
  });
});
