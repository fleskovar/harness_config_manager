/**
 * Everything `sample-kit` ships, installed into OpenCode.
 *
 * This folder is the whole test: `input/sample-kit` goes in, `expected/` is
 * what has to come out, and the test below is the sentence "install one into an
 * empty project and you get the other". Both sides are files you can open.
 *
 *   npx tsx src/cli.ts install tests/target-opencode/input/sample-kit -t opencode
 *   diff -r . <repo>/tests/target-opencode/expected
 *
 * Three things are OpenCode's own, and `expected/` shows all three:
 *
 *   subagent  `mode: subagent`, and no `tools` -- OpenCode gates tools through
 *             a `permission` object of its own categories, which a canonical
 *             allowlist has no faithful translation into
 *   rule      no glob-scoped rule format, but `instructions` loads extra files
 *             whole -- so a rule is a file *plus* one entry in that array
 *   mcp       one `command` argv array rather than command-plus-args, and
 *             `environment` rather than `env`
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
  workspace = await makeWorkspace('target-opencode');
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
  await installCommand(kit, { targets: ['opencode'], scope: 'project', cwd: projectDir });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HCM_HOME;
  else process.env.HCM_HOME = previousHome;
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('sample-kit into OpenCode', () => {
  it('produces exactly the tree in expected/', async () => {
    expect(await readTree(projectDir)).toEqual(await readTree(EXPECTED));
  });

  it('files one resource of each kind where OpenCode looks for it', async () => {
    expect(await listTree(projectDir)).toEqual([
      '.opencode/agents/code-reviewer.md', // subagent
      '.opencode/commands/review-pr.md', // command
      '.opencode/rules/typescript.md', // rule -- the file half of it
      '.opencode/skills/dependency-audit/SKILL.md', // skill
      '.opencode/skills/dependency-audit/checklist.md',
      'AGENTS.md', // context
      'opencode.json', // mcp, settings, and the rule's instructions[] entry
    ]);
  });

  it('marks the subagent as one, and drops the tools allowlist', async () => {
    const agent = await readText(projectDir, '.opencode/agents/code-reviewer.md');

    // Without this the file would define a primary agent -- one you Tab into --
    // rather than something a primary agent delegates to.
    expect(agent).toContain('mode: subagent');
    expect(agent).toContain('model: sonnet');
    expect(agent).toContain('color: blue');
    // The filename is the agent id, so there is no `name` field to write...
    expect(agent).not.toContain('name:');
    // ...and tool access is a `permission` object of OpenCode's own categories,
    // so a list of tool names has nothing faithful to become.
    expect(agent).not.toContain('tools');
  });

  it('names the skill and keeps its supporting files verbatim', async () => {
    expect(await readText(projectDir, '.opencode/skills/dependency-audit/SKILL.md')).toContain(
      'name: dependency-audit',
    );
    expect(await readText(projectDir, '.opencode/skills/dependency-audit/checklist.md')).toBe(
      await readText(INPUT, 'skills/dependency-audit/checklist.md'),
    );
  });

  it('keeps the command’s body and only the frontmatter OpenCode reads', async () => {
    const command = await readText(projectDir, '.opencode/commands/review-pr.md');

    expect(command).toContain('description: Review the current branch against a base branch.');
    // `$ARGUMENTS` works as it does in Claude Code, so the body passes through.
    expect(command).toContain('`$ARGUMENTS`');
    // Neither of these is an OpenCode command field.
    expect(command).not.toContain('argument-hint');
    expect(command).not.toContain('allowed-tools');
  });

  it('writes the rule as a file *and* an instructions[] entry', async () => {
    const rule = await readText(projectDir, '.opencode/rules/typescript.md');

    // Loaded whole, so the globs cannot be enforced -- they are stated instead.
    expect(rule).toContain('**Applies to:** `**/*.ts`, `**/*.tsx`');
    expect(rule).not.toContain('appliesTo');

    // Appended, never replaced, so several bundles can each list their own.
    const config = await readJson(projectDir, 'opencode.json');
    expect(config.instructions).toEqual(['.opencode/rules/typescript.md']);
  });

  it('writes the MCP server as one argv array under mcp', async () => {
    const config = await readJson(projectDir, 'opencode.json');

    expect(config.mcp).toEqual({
      filesystem: {
        type: 'local', // required here, rather than inferred from `command`
        command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '.'],
        environment: { FS_LOG: 'warn' }, // `env` in the bundle
      },
    });
  });

  it('merges the settings fragment into the same opencode.json', async () => {
    const config = await readJson(projectDir, 'opencode.json');

    expect(config.permissions).toEqual({
      defaultMode: 'acceptEdits',
      allow: ['Bash(git diff:*)', 'Bash(npm test:*)'],
    });
    // One file holds the lot: settings, MCP servers and the rule's entry.
    expect(Object.keys(config).sort()).toEqual(['instructions', 'mcp', 'permissions']);
  });

  it('writes both context sections into AGENTS.md, in filename order', async () => {
    const agentsMd = await readText(projectDir, 'AGENTS.md');

    expect(agentsMd).toContain('<!-- hcm:begin sample-kit/10-conventions -->');
    expect(agentsMd).toContain('<!-- hcm:end sample-kit/10-conventions -->');
    expect(agentsMd).toContain('<!-- hcm:begin sample-kit/20-pull-requests -->');
    expect(agentsMd.indexOf('## Review conventions')).toBeLessThan(
      agentsMd.indexOf('## Pull requests'),
    );
    // Unlike Reasonix and Pi, the rule is a file of its own here, so AGENTS.md
    // holds context and nothing else.
    expect(agentsMd).not.toContain('**Applies to:**');
  });

  it('repoints the bundle’s references at the OpenCode layout', async () => {
    const agent = await readText(projectDir, '.opencode/agents/code-reviewer.md');
    // The rule *is* a file here, so the reference stays a reference to a file.
    expect(agent).toContain('`../rules/typescript.md`');
    expect(agent).toContain('`../skills/dependency-audit/checklist.md`');

    const skill = await readText(projectDir, '.opencode/skills/dependency-audit/SKILL.md');
    expect(skill).toContain('`checklist.md`'); // same directory, unchanged
    expect(skill).toContain('`../../agents/code-reviewer.md`');

    // AGENTS.md sits at the project root, so it has nothing to climb out of.
    expect(await readText(projectDir, 'AGENTS.md')).toContain(
      '`.opencode/skills/dependency-audit/checklist.md`',
    );
  });
});
