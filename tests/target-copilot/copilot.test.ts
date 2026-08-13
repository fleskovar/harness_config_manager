/**
 * Everything `sample-kit` ships, installed into GitHub Copilot.
 *
 * This folder is the whole test: `input/sample-kit` goes in, `expected/` is
 * what has to come out, and the test below is the sentence "install one into an
 * empty project and you get the other". Both sides are files you can open.
 *
 *   npx tsx src/cli.ts install tests/target-copilot/input/sample-kit -t copilot
 *   diff -r . <repo>/tests/target-copilot/expected
 *
 * The bundle is byte-for-byte the one in every other `tests/target-*` folder,
 * so the interesting reading is sideways: diff this `expected/` against
 * `../target-claude-code/expected` and every difference is something Copilot
 * does differently -- the `.agent.md` and `.prompt.md` suffixes, tools as a
 * YAML list, `applyTo` instead of `paths`, `servers` instead of `mcpServers`.
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
  workspace = await makeWorkspace('target-copilot');
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
  await installCommand(kit, { targets: ['copilot'], scope: 'project', cwd: projectDir });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HCM_HOME;
  else process.env.HCM_HOME = previousHome;
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('sample-kit into GitHub Copilot', () => {
  it('produces exactly the tree in expected/', async () => {
    expect(await readTree(projectDir)).toEqual(await readTree(EXPECTED));
  });

  it('files one resource of each kind where Copilot looks for it', async () => {
    expect(await listTree(projectDir)).toEqual([
      '.github/agents/code-reviewer.agent.md', // subagent
      '.github/copilot-instructions.md', // context
      '.github/copilot/settings.json', // settings
      '.github/instructions/typescript.instructions.md', // rule
      '.github/prompts/review-pr.prompt.md', // command
      '.github/skills/dependency-audit/SKILL.md', // skill
      '.github/skills/dependency-audit/checklist.md',
      '.vscode/mcp.json', // mcp
    ]);
  });

  it('gives the subagent a YAML tools list, not a string', async () => {
    const agent = await readText(projectDir, '.github/agents/code-reviewer.agent.md');

    expect(agent).toContain('name: code-reviewer');
    expect(agent).toContain(
      'tools:\n  - Read\n  - Grep\n  - Bash\n  - mcp__filesystem__read_text_file',
    );
    expect(agent).toContain('model: sonnet');
    // Copilot's agent frontmatter has no `color`, so the bundle's is dropped.
    expect(agent).not.toContain('color');
  });

  it('names the skill and keeps its supporting files verbatim', async () => {
    expect(await readText(projectDir, '.github/skills/dependency-audit/SKILL.md')).toContain(
      'name: dependency-audit',
    );
    expect(await readText(projectDir, '.github/skills/dependency-audit/checklist.md')).toBe(
      await readText(INPUT, 'skills/dependency-audit/checklist.md'),
    );
  });

  it('writes the command as an agent-mode prompt', async () => {
    const prompt = await readText(projectDir, '.github/prompts/review-pr.prompt.md');

    expect(prompt).toContain('mode: agent'); // added: Copilot prompts declare one
    expect(prompt).toContain('tools:\n  - Read\n  - Grep\n  - Bash'); // from allowedTools
    // Copilot prompts have no argument hint, so that field has nowhere to go.
    expect(prompt).not.toContain('argument-hint');
  });

  it('turns appliesTo into a single comma-separated applyTo glob', async () => {
    const rule = await readText(projectDir, '.github/instructions/typescript.instructions.md');

    expect(rule).toContain('applyTo: "**/*.ts, **/*.tsx"');
    expect(rule).not.toContain('appliesTo');
  });

  it('writes the MCP server under servers, with the stdio type Copilot wants', async () => {
    expect(await readJson(projectDir, '.vscode/mcp.json')).toEqual({
      servers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          env: { FS_LOG: 'warn' },
          // Inferred: the bundle says neither `type` nor `url`, and Copilot
          // does not infer it from `command` the way Claude Code does.
          type: 'stdio',
        },
      },
    });
  });

  it('merges the settings fragment into .github/copilot/settings.json', async () => {
    expect(await readJson(projectDir, '.github/copilot/settings.json')).toEqual({
      permissions: {
        defaultMode: 'acceptEdits',
        allow: ['Bash(git diff:*)', 'Bash(npm test:*)'],
      },
    });
  });

  it('writes both context sections into copilot-instructions.md, in filename order', async () => {
    const instructions = await readText(projectDir, '.github/copilot-instructions.md');

    expect(instructions).toContain('<!-- hcm:begin sample-kit/10-conventions -->');
    expect(instructions).toContain('<!-- hcm:end sample-kit/10-conventions -->');
    expect(instructions).toContain('<!-- hcm:begin sample-kit/20-pull-requests -->');
    expect(instructions.indexOf('## Review conventions')).toBeLessThan(
      instructions.indexOf('## Pull requests'),
    );
  });

  it('repoints the bundle’s references at the Copilot layout', async () => {
    // Copilot's agents carry a `.agent.md` suffix, so the same reference in the
    // same bundle file comes out with a different name on the end.
    const skill = await readText(projectDir, '.github/skills/dependency-audit/SKILL.md');
    expect(skill).toContain('`checklist.md`'); // same directory, unchanged
    expect(skill).toContain('`../../agents/code-reviewer.agent.md`');

    const agent = await readText(projectDir, '.github/agents/code-reviewer.agent.md');
    expect(agent).toContain('`../instructions/typescript.instructions.md`');

    // copilot-instructions.md lives inside .github/, one directory nearer the
    // skill than CLAUDE.md is, so its path is shorter by that much.
    expect(await readText(projectDir, '.github/copilot-instructions.md')).toContain(
      '`skills/dependency-audit/checklist.md`',
    );
  });
});
