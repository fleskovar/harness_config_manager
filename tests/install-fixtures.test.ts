/**
 * Installing a real bundle into a real (empty) project, and taking it out again.
 *
 * The bundle is `tests/fixtures/bundles/review-kit`: one resource of every kind,
 * with references between them. Everything asserted here can be worked out by
 * hand from two things -- the fixture on disk, and the "Where things land" table
 * in the README. The expected file lists below are what `find .` would print
 * after running the same `hcm install` yourself.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { uninstallCommand } from '../src/commands/uninstall.js';
import { configureLogger } from '../src/core/logger.js';
import { readState } from '../src/core/state.js';
import { copyFixture, exists, listTree, makeWorkspace, readJson, readText } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let kit: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await makeWorkspace('install-fixture');
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });
  kit = await copyFixture('bundles/review-kit', path.join(workspace, 'review-kit'));

  // Keep the registry, store and user-scope state inside the workspace, so no
  // test reads or writes the machine's real ~/.hcm.
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

const install = (target: string): Promise<void> =>
  installCommand(kit, { targets: [target], scope: 'project', cwd: projectDir });

// ---------------------------------------------------------------------------

describe('review-kit into Claude Code', () => {
  /** One line per file in the fixture, in the place the README says it goes. */
  const EXPECTED_FILES = [
    '.claude/agents/code-reviewer.md', // subagents/code-reviewer.md
    '.claude/commands/review-pr.md', // commands/review-pr.md
    '.claude/rules/typescript.md', // rules/typescript.md
    '.claude/settings.json', // settings/settings.json
    '.claude/skills/dependency-audit/SKILL.md', // skills/dependency-audit/
    '.claude/skills/dependency-audit/checklist.md',
    '.mcp.json', // mcp/filesystem.json
    'CLAUDE.md', // context/10-conventions.md, context/20-pull-requests.md
  ];

  it('writes exactly these files, and nothing else', async () => {
    await install('claude-code');

    expect(await listTree(projectDir)).toEqual(EXPECTED_FILES);
  });

  it('rewrites the subagent frontmatter into Claude Code’s dialect', async () => {
    await install('claude-code');

    // `tools` was a YAML list in the bundle and is a comma-separated string here;
    // `name` is added from the filename. The body is untouched apart from the
    // reference rewriting checked further down.
    expect(await readText(projectDir, '.claude/agents/code-reviewer.md')).toBe(
      [
        '---',
        'name: code-reviewer',
        'description: Reviews changed code for correctness and clarity.',
        'tools: Read, Grep, Bash, mcp__filesystem__read_text_file',
        'model: sonnet',
        '---',
        '',
        'You are a meticulous code reviewer. Review the working tree and report concrete',
        'findings, most serious first.',
        '',
        'Read files through the `filesystem` MCP server rather than shelling out.',
        '',
        'Apply the conventions in `../rules/typescript.md`, and when the change touches',
        'dependencies work through `../skills/dependency-audit/checklist.md` as well.',
        '',
      ].join('\n'),
    );
  });

  it('turns the rule’s appliesTo globs into paths', async () => {
    await install('claude-code');

    const rule = await readText(projectDir, '.claude/rules/typescript.md');
    expect(rule).toContain('paths:\n  - "**/*.ts"\n  - "**/*.tsx"');
    expect(rule).not.toContain('appliesTo');
  });

  it('writes the MCP server under mcpServers, verbatim', async () => {
    await install('claude-code');

    expect(await readJson(projectDir, '.mcp.json')).toEqual({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        },
      },
    });
  });

  it('merges the settings fragment into .claude/settings.json', async () => {
    await install('claude-code');

    expect(await readJson(projectDir, '.claude/settings.json')).toEqual({
      permissions: { allow: ['Bash(git diff:*)', 'Bash(npm test:*)'] },
    });
  });

  it('writes both context sections into CLAUDE.md, in filename order', async () => {
    await install('claude-code');

    const claudeMd = await readText(projectDir, 'CLAUDE.md');

    // Two marked blocks, named for the bundle and the section file.
    expect(claudeMd).toContain('<!-- hcm:begin review-kit/10-conventions -->');
    expect(claudeMd).toContain('<!-- hcm:end review-kit/10-conventions -->');
    expect(claudeMd).toContain('<!-- hcm:begin review-kit/20-pull-requests -->');
    expect(claudeMd).toContain('## Review conventions');
    expect(claudeMd).toContain('## Pull requests');
    // 10- before 20-: the numeric prefixes are what orders the sections.
    expect(claudeMd.indexOf('## Review conventions')).toBeLessThan(
      claudeMd.indexOf('## Pull requests'),
    );
  });
});

/**
 * References are written against the bundle's own layout and repointed on the
 * way in. Each expectation here is "from where this file landed, how do you get
 * to where that file landed" -- countable on your fingers from EXPECTED_FILES.
 */
describe('review-kit’s internal references, after installing', () => {
  it('repoints them for Claude Code', async () => {
    await install('claude-code');

    // .claude/skills/dependency-audit/SKILL.md -> its own directory, unchanged...
    const skill = await readText(projectDir, '.claude/skills/dependency-audit/SKILL.md');
    expect(skill).toContain('Work through `checklist.md`');
    // ...and up two directories to reach the subagent.
    expect(skill).toContain('`../../agents/code-reviewer.md`');

    // .claude/commands/review-pr.md -> up one, then down into skills/ and agents/.
    const command = await readText(projectDir, '.claude/commands/review-pr.md');
    expect(command).toContain('`../skills/dependency-audit/checklist.md`');
    expect(command).toContain('`../agents/code-reviewer.md`');

    // CLAUDE.md sits at the project root, so it has nothing to climb out of.
    expect(await readText(projectDir, 'CLAUDE.md')).toContain(
      '`.claude/skills/dependency-audit/checklist.md`',
    );
  });

  it('repoints them differently for Copilot, whose filenames differ', async () => {
    await install('copilot');

    // Copilot's agents carry a .agent.md suffix, so the same reference in the
    // same bundle file comes out with a different name on the end.
    expect(await readText(projectDir, '.github/skills/dependency-audit/SKILL.md')).toContain(
      '`../../agents/code-reviewer.agent.md`',
    );
    expect(await readText(projectDir, '.github/prompts/review-pr.prompt.md')).toContain(
      '`../skills/dependency-audit/checklist.md`',
    );
    // copilot-instructions.md lives inside .github/, one directory nearer the
    // skill than CLAUDE.md is, so its path is shorter by that much.
    expect(await readText(projectDir, '.github/copilot-instructions.md')).toContain(
      '`skills/dependency-audit/checklist.md`',
    );
  });
});

describe('review-kit into GitHub Copilot', () => {
  it('writes exactly these files, and nothing else', async () => {
    await install('copilot');

    expect(await listTree(projectDir)).toEqual([
      '.github/agents/code-reviewer.agent.md',
      '.github/copilot-instructions.md',
      '.github/copilot/settings.json',
      '.github/instructions/typescript.instructions.md',
      '.github/prompts/review-pr.prompt.md',
      '.github/skills/dependency-audit/SKILL.md',
      '.github/skills/dependency-audit/checklist.md',
      '.vscode/mcp.json',
    ]);
  });

  it('gives the subagent a YAML tools list, not a string', async () => {
    await install('copilot');

    const agent = await readText(projectDir, '.github/agents/code-reviewer.agent.md');
    expect(agent).toContain('tools:\n  - Read\n  - Grep\n  - Bash');
  });

  it('turns appliesTo into a single comma-separated applyTo glob', async () => {
    await install('copilot');

    expect(await readText(projectDir, '.github/instructions/typescript.instructions.md')).toContain(
      'applyTo: "**/*.ts, **/*.tsx"',
    );
  });

  it('adds the stdio type Copilot wants on an MCP server', async () => {
    await install('copilot');

    expect(await readJson(projectDir, '.vscode/mcp.json')).toEqual({
      servers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          type: 'stdio',
        },
      },
    });
  });
});

describe('two harnesses at once', () => {
  it('keeps each harness’s files to itself', async () => {
    await install('claude-code');
    await install('copilot');

    const files = await listTree(projectDir);
    expect(files).toContain('.claude/agents/code-reviewer.md');
    expect(files).toContain('.github/agents/code-reviewer.agent.md');
    expect(files).toHaveLength(16);

    // Two installations recorded, one per harness.
    const state = await readState('project', projectDir);
    expect(state.installations.map((record) => record.id).sort()).toEqual([
      'review-kit@claude-code@project',
      'review-kit@copilot@project',
    ]);
  });

  it('uninstalling one leaves the other alone', async () => {
    await install('claude-code');
    await install('copilot');

    await uninstallCommand('review-kit', {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
    });

    expect(await exists(projectDir, '.claude')).toBe(false);
    expect(await exists(projectDir, 'CLAUDE.md')).toBe(false);
    expect(await exists(projectDir, '.github/agents/code-reviewer.agent.md')).toBe(true);
    expect(await exists(projectDir, '.vscode/mcp.json')).toBe(true);
  });
});

describe('uninstalling from a project hcm found empty', () => {
  it('leaves it empty again', async () => {
    await install('claude-code');
    expect(await listTree(projectDir)).toHaveLength(8);

    await uninstallCommand('review-kit', { scope: 'project', cwd: projectDir });

    expect(await listTree(projectDir)).toEqual([]);
    expect((await readState('project', projectDir)).installations).toEqual([]);
  });
});
