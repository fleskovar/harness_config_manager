/**
 * Everything `sample-kit` ships, installed into Pi.
 *
 * This folder is the whole test: `input/sample-kit` goes in, `expected/` is
 * what has to come out, and the test below is the sentence "install one into an
 * empty project and you get the other". Both sides are files you can open.
 *
 *   npx tsx src/cli.ts install tests/target-pi/input/sample-kit -t pi
 *   diff -r . <repo>/tests/target-pi/expected
 *
 * Pi is deliberately the smallest of the harnesses, and every kind still lands
 * somewhere:
 *
 *   subagent  no agents directory in stock Pi, so it is a skill invoked as
 *             `/skill:<name>` -- and Agent Skills frontmatter is `name` and
 *             `description` only, so `tools`, `model` and `color` are dropped.
 *             `--pi-subagents` changes that; see tests/pi-subagents.test.ts
 *   rule      no glob-scoped rule format -- it joins context in AGENTS.md
 *   mcp       the shared `.mcp.json`, in the same shape Claude Code uses --
 *             inert until an MCP extension is installed, correct once it is
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
  workspace = await makeWorkspace('target-pi');
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
  await installCommand(kit, { targets: ['pi'], scope: 'project', cwd: projectDir });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HCM_HOME;
  else process.env.HCM_HOME = previousHome;
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('sample-kit into Pi', () => {
  it('produces exactly the tree in expected/', async () => {
    expect(await readTree(projectDir)).toEqual(await readTree(EXPECTED));
  });

  it('files one resource of each kind where Pi looks for it', async () => {
    expect(await listTree(projectDir)).toEqual([
      '.mcp.json', // mcp -- the file Claude Code also reads
      '.pi/prompts/review-pr.md', // command
      '.pi/settings.json', // settings
      '.pi/skills/code-reviewer/SKILL.md', // subagent -- a skill here
      '.pi/skills/dependency-audit/SKILL.md', // skill
      '.pi/skills/dependency-audit/checklist.md',
      'AGENTS.md', // context *and* rule
    ]);
  });

  it('writes the subagent as a plain skill, keeping only what Agent Skills defines', async () => {
    const agent = await readText(projectDir, '.pi/skills/code-reviewer/SKILL.md');

    expect(agent).toContain('name: code-reviewer');
    expect(agent).toContain('description: Reviews changed code for correctness and clarity.');
    // Stock Pi has no profile-level allowlist, model override or colour, and no
    // delegation -- the prompt runs in the main context. So all three go.
    expect(agent).not.toContain('tools');
    expect(agent).not.toContain('model');
    expect(agent).not.toContain('color');
    // The prompt itself is what survives, and it is what `/skill:code-reviewer` runs.
    expect(agent).toContain('You are a meticulous code reviewer.');
  });

  it('names the skill and keeps its supporting files verbatim', async () => {
    expect(await readText(projectDir, '.pi/skills/dependency-audit/SKILL.md')).toContain(
      'name: dependency-audit',
    );
    expect(await readText(projectDir, '.pi/skills/dependency-audit/checklist.md')).toBe(
      await readText(INPUT, 'skills/dependency-audit/checklist.md'),
    );
  });

  it('writes the command as a prompt template', async () => {
    const prompt = await readText(projectDir, '.pi/prompts/review-pr.md');

    expect(prompt).toContain('argument-hint: "[base-branch]"');
    expect(prompt).toContain('`$ARGUMENTS`'); // substituted by Pi, as elsewhere
    expect(prompt).not.toContain('allowed-tools');
  });

  it('puts the rule in AGENTS.md, its globs stated in prose', async () => {
    const agentsMd = await readText(projectDir, 'AGENTS.md');

    // A block of its own, so it is removable on its own.
    expect(agentsMd).toContain('<!-- hcm:begin sample-kit/rules/typescript -->');
    expect(agentsMd).toContain('<!-- hcm:end sample-kit/rules/typescript -->');
    // No loader here can enforce the globs, so they are said out loud instead.
    expect(agentsMd).toContain('**Applies to:** `**/*.ts`, `**/*.tsx`');
  });

  it('writes both context sections into AGENTS.md, in filename order', async () => {
    const agentsMd = await readText(projectDir, 'AGENTS.md');

    expect(agentsMd).toContain('<!-- hcm:begin sample-kit/10-conventions -->');
    expect(agentsMd).toContain('<!-- hcm:end sample-kit/10-conventions -->');
    expect(agentsMd).toContain('<!-- hcm:begin sample-kit/20-pull-requests -->');
    expect(agentsMd.indexOf('## Review conventions')).toBeLessThan(
      agentsMd.indexOf('## Pull requests'),
    );
    // The rule shares the file, and comes after the context sections.
    expect(agentsMd.indexOf('## Pull requests')).toBeLessThan(agentsMd.indexOf('**Applies to:**'));
  });

  it('writes the MCP server into the shared .mcp.json, verbatim', async () => {
    // Byte-identical to what Claude Code is given, because it is the same file
    // and the same convention -- which is what makes installing into both
    // harnesses write it once and claim it twice.
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

  it('merges the settings fragment into .pi/settings.json', async () => {
    expect(await readJson(projectDir, '.pi/settings.json')).toEqual({
      permissions: {
        defaultMode: 'acceptEdits',
        allow: ['Bash(git diff:*)', 'Bash(npm test:*)'],
      },
    });
  });

  it('repoints the bundle’s references at the Pi layout', async () => {
    const agent = await readText(projectDir, '.pi/skills/code-reviewer/SKILL.md');
    // The rule is not a file here, so a reference to it lands on AGENTS.md --
    // three directories up from a skill.
    expect(agent).toContain('`../../../AGENTS.md`');
    // Subagent and skill are siblings under skills/, so this is one hop.
    expect(agent).toContain('`../dependency-audit/checklist.md`');

    expect(await readText(projectDir, '.pi/skills/dependency-audit/SKILL.md')).toContain(
      '`../code-reviewer/SKILL.md`',
    );
    expect(await readText(projectDir, '.pi/prompts/review-pr.md')).toContain(
      '`../skills/code-reviewer/SKILL.md`',
    );
    // AGENTS.md sits at the project root, so it has nothing to climb out of.
    expect(await readText(projectDir, 'AGENTS.md')).toContain(
      '`.pi/skills/dependency-audit/checklist.md`',
    );
  });
});
