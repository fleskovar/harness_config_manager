/**
 * `hcm list --analysis`: which bundle brought which file.
 *
 * Installed files keep the names that each harness expects, so the folder
 * `.claude/skills/jira-board/` does not say which bundle wrote it. The receipts
 * do. These tests install two small bundles that share one skill, then read the
 * breakdown back, on the console, as JSON, and in a file (`--output`).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { listCommand } from '../src/commands/list.js';
import { analyzeInstallations, type AnalyzedInstallation } from '../src/core/analysis.js';
import { configureLogger } from '../src/core/logger.js';
import { readState } from '../src/core/state.js';
import type { InstallationRecord } from '../src/core/types.js';
import { makeWorkspace } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let previousHome: string | undefined;

/** The skill that both bundles ship, byte for byte. hcm writes it once, and both claim it. */
const SHARED_SKILL = '---\ndescription: How to talk to the JIRA board\n---\n\nUse the board API.\n';

/** A bundle with the shared skill, an MCP server, a context section and a command of its own. */
async function makeBundle(name: string): Promise<string> {
  const root = path.join(workspace, name);
  const files: Record<string, string> = {
    'hcm.yaml': `name: ${name}\nversion: 1.0.0\n`,
    'skills/jira-board/SKILL.md': SHARED_SKILL,
    'skills/jira-board/fields.md': '# Fields\n\nsummary, status.\n',
    [`commands/${name}-plan.md`]: `---\ndescription: Plan with ${name}\n---\n\nPlan.\n`,
    [`mcp/${name}.json`]: JSON.stringify({ command: `${name}-mcp` }),
    'context/10-team.md': `# ${name}\n\nTeam rules.\n`,
  };
  for (const [relative, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), text);
  }
  return root;
}

const install = (bundle: string) =>
  installCommand([bundle], {
    scope: 'project',
    cwd: projectDir,
    targets: ['claude-code'],
    prompt: false,
  });

/** Run something that logs, and hand back everything it printed, without colors. */
async function capture(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  configureLogger({});
  try {
    await run();
  } finally {
    console.log = original;
    configureLogger({ quiet: true });
  }
  // eslint-disable-next-line no-control-regex
  return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

/** The lines of one bundle in a printed analysis: from its name to the next bundle or scope. */
function bundleBlock(printed: string, bundle: string): string {
  const lines = printed.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`  ${bundle} `));
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^\s{0,2}\S/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

beforeEach(async () => {
  workspace = await makeWorkspace('list-analysis');
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });
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

describe('the receipts of an install', () => {
  it('name the bundle item that each file or entry came from', async () => {
    await install(await makeBundle('alpha'));

    const [record] = (await readState('project', projectDir)).installations;
    const items = record?.receipts.map((receipt) => `${receipt.item?.kind} ${receipt.item?.name}`);

    expect(new Set(items)).toEqual(
      new Set(['skill jira-board', 'command alpha-plan', 'mcp alpha', 'context 10-team']),
    );
  });
});

describe('hcm list --analysis', () => {
  beforeEach(async () => {
    await install(await makeBundle('alpha'));
    await install(await makeBundle('beta'));
  });

  it('lists each item of a bundle with the files and entries it brought', async () => {
    const block = bundleBlock(await capture(() => listCommand({ analysis: true, cwd: projectDir })), 'alpha');

    expect(block).toContain('Claude Code · 4 items, 5 entries');
    expect(block).toMatch(
      /skill jira-board\n\s+\.claude\/skills\/jira-board\/fields\.md.*\n\s+\.claude\/skills\/jira-board\/SKILL\.md/,
    );
    expect(block).toMatch(/command alpha-plan\n\s+\.claude\/commands\/alpha-plan\.md/);
    expect(block).toMatch(/context 10-team\n\s+CLAUDE\.md → block alpha\/10-team/);
    expect(block).toMatch(/mcp alpha\n\s+\.mcp\.json → mcpServers\.alpha/);
    expect(block).not.toContain('beta-plan');
  });

  it('marks the files that another bundle claims too', async () => {
    const block = bundleBlock(await capture(() => listCommand({ analysis: true, cwd: projectDir })), 'alpha');

    expect(block).toContain('.claude/skills/jira-board/SKILL.md (also claimed by beta)');
    expect(block).not.toMatch(/alpha-plan\.md \(also claimed/);
  });

  it('gives the same breakdown as JSON', async () => {
    const printed = await capture(() => listCommand({ analysis: true, json: true, cwd: projectDir }));
    const analysis = JSON.parse(printed) as AnalyzedInstallation[];
    const alpha = analysis.find((installation) => installation.bundle === 'alpha');
    const skill = alpha?.items.find((item) => item.kind === 'skill');

    expect(skill?.name).toBe('jira-board');
    expect(skill?.entries.map((entry) => [entry.path, entry.sharedWith])).toEqual([
      ['.claude/skills/jira-board/fields.md', ['beta']],
      ['.claude/skills/jira-board/SKILL.md', ['beta']],
    ]);
  });

  it('shows nothing of the user scope with --scope project', async () => {
    const printed = await capture(() =>
      listCommand({ analysis: true, scope: 'project', cwd: projectDir }),
    );

    expect(printed).toContain('project scope');
    expect(printed).not.toContain('user scope');
  });
});

describe('hcm list --output', () => {
  beforeEach(async () => {
    await install(await makeBundle('alpha'));
  });

  it('writes the analysis to the file without colors, and only a note to the console', async () => {
    const printed = await capture(() =>
      listCommand({ analysis: true, output: 'reports/bundles.txt', cwd: projectDir }),
    );
    const written = await fs.readFile(path.join(projectDir, 'reports', 'bundles.txt'), 'utf8');

    expect(written).toContain('skill jira-board');
    expect(written).not.toContain('\x1b[');
    expect(printed).not.toContain('skill jira-board');
    expect(printed).toContain('Wrote the listing to');
  });

  it('writes the other listings too', async () => {
    const file = path.join(workspace, 'installed.json');
    await capture(() => listCommand({ installed: true, json: true, output: file, cwd: projectDir }));

    const records = JSON.parse(await fs.readFile(file, 'utf8')) as InstallationRecord[];
    expect(records.map((record) => record.bundle)).toEqual(['alpha']);
  });
});

describe('analyzeInstallations', () => {
  const cwd = path.resolve('/work/project');
  const record = (receipts: InstallationRecord['receipts']): InstallationRecord =>
    ({
      id: 'old-kit@claude-code@project',
      bundle: 'old-kit',
      version: '1.0.0',
      target: 'claude-code',
      scope: 'project',
      receipts,
    }) as InstallationRecord;

  it('puts receipts without an item in one unsorted group, and names context blocks anyway', () => {
    const [analysis] = analyzeInstallations(
      [
        record([
          { op: 'file', path: '.claude/agents/a.md', hash: 'h1' },
          { op: 'block', path: 'CLAUDE.md', blockId: 'old-kit/10-rules', syntax: 'markdown' },
          { op: 'file', path: '.claude/rules/r.md', hash: 'h2', preexisting: true },
        ]),
      ],
      new Map(),
      cwd,
    );

    expect(analysis?.items.map((item) => [item.kind, item.name, item.entries.length])).toEqual([
      ['context', '10-rules', 1],
      ['unknown', '', 2],
    ]);
    expect(analysis?.items[1]?.entries.find((entry) => entry.adopted)?.path).toBe(
      '.claude/rules/r.md',
    );
  });
});
