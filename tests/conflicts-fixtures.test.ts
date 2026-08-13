/**
 * Installing into a project that already has configuration of its own.
 *
 * Two project fixtures stand in for that, and both are worth opening before
 * reading the assertions:
 *
 *   tests/fixtures/projects/adopted-setup/    .mcp.json already holds exactly
 *       the server review-kit would write -- same values, different key order
 *       and indentation. Nothing to do, and nothing to own: it is *adopted*.
 *
 *   tests/fixtures/projects/existing-setup/   .mcp.json holds a `filesystem`
 *       server pointed at /srv/docs instead of `.`, an unrelated `postgres`
 *       server, and a hand-written CLAUDE.md. The first is a genuine collision;
 *       the other two must come through untouched whatever is decided about it.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { uninstallCommand } from '../src/commands/uninstall.js';
import type { ConflictResolver } from '../src/core/conflicts.js';
import { configureLogger } from '../src/core/logger.js';
import { readState } from '../src/core/state.js';
import { copyFixture, exists, fixturePath, makeWorkspace, readJson, readText } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let kit: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await makeWorkspace('conflict-fixture');
  projectDir = path.join(workspace, 'project');
  kit = await copyFixture('bundles/review-kit', path.join(workspace, 'review-kit'));

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

/** Start from one of the project fixtures rather than an empty directory. */
async function project(fixture: string): Promise<void> {
  await copyFixture(`projects/${fixture}`, projectDir);
}

/** The fixture as it is checked in, for byte-for-byte comparison afterwards. */
const original = (fixture: string, file: string): Promise<string> =>
  fs.readFile(path.join(fixturePath(`projects/${fixture}`), file), 'utf8');

interface InstallOptions {
  onConflict?: 'skip' | 'overwrite' | 'abort' | 'prompt';
  resolver?: ConflictResolver;
}

const install = (options: InstallOptions = {}): Promise<void> =>
  installCommand(kit, {
    targets: ['claude-code'],
    scope: 'project',
    cwd: projectDir,
    ...options,
  });

const servers = async (): Promise<Record<string, unknown>> =>
  (await readJson<{ mcpServers: Record<string, unknown> }>(projectDir, '.mcp.json')).mcpServers;

const FILESYSTEM_AS_SHIPPED = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
};
const FILESYSTEM_AS_FOUND = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv/docs'],
};

// ---------------------------------------------------------------------------

describe('when the item is already there, identical', () => {
  it('adopts it: no conflict, and the file is not even reformatted', async () => {
    await project('adopted-setup');
    const before = await readText(projectDir, '.mcp.json');

    await install();

    // Same bytes, four-space indentation and reversed key order and all.
    expect(await readText(projectDir, '.mcp.json')).toBe(before);
    expect(before).toBe(await original('adopted-setup', '.mcp.json'));
    // ...and the rest of the bundle installed as normal.
    expect(await exists(projectDir, '.claude/agents/code-reviewer.md')).toBe(true);
  });

  it('records the adoption, so uninstall leaves what it found', async () => {
    await project('adopted-setup');

    await install();

    const record = (await readState('project', projectDir)).installations[0];
    const receipt = record?.receipts.find(
      (candidate) => candidate.op === 'json-value' && candidate.path === '.mcp.json',
    );
    expect(receipt && 'preexisting' in receipt && receipt.preexisting).toBe(true);

    await uninstallCommand('review-kit', { scope: 'project', cwd: projectDir });

    expect(await readText(projectDir, '.mcp.json')).toBe(
      await original('adopted-setup', '.mcp.json'),
    );
  });
});

describe('when the item is already there and differs', () => {
  it('refuses to guess, and writes nothing at all', async () => {
    await project('existing-setup');

    await expect(install({ onConflict: 'abort' })).rejects.toThrow(/conflict/i);

    // Not a partial install: the agents directory was never created.
    expect(await exists(projectDir, '.claude')).toBe(false);
    expect(await readText(projectDir, '.mcp.json')).toBe(
      await original('existing-setup', '.mcp.json'),
    );
  });

  it('--on-conflict skip keeps the project’s server and installs the rest', async () => {
    await project('existing-setup');

    await install({ onConflict: 'skip' });

    // .mcp.json was not touched at all -- the whole resource was dropped.
    expect(await readText(projectDir, '.mcp.json')).toBe(
      await original('existing-setup', '.mcp.json'),
    );
    expect(await exists(projectDir, '.claude/skills/dependency-audit/SKILL.md')).toBe(true);
    expect(await readText(projectDir, 'CLAUDE.md')).toContain('## Review conventions');
  });

  it('--on-conflict overwrite wins, and uninstall puts the old value back', async () => {
    await project('existing-setup');

    await install({ onConflict: 'overwrite' });

    expect(await servers()).toEqual({
      postgres: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres'],
      },
      filesystem: FILESYSTEM_AS_SHIPPED,
    });

    await uninstallCommand('review-kit', { scope: 'project', cwd: projectDir });

    // The value we displaced was kept in the receipt and restored.
    expect(await servers()).toEqual({
      postgres: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres'],
      },
      filesystem: FILESYSTEM_AS_FOUND,
    });
  });

  it('renaming installs under the new name and repoints the instructions at it', async () => {
    await project('existing-setup');

    // Stands in for the user answering the "how should hcm handle this?" prompt.
    const resolver: ConflictResolver = async (group) => {
      expect(group.label).toBe('mcp "filesystem"');
      expect(group.canRename).toBe(true);
      return { choice: 'rename', newName: 'review-files' };
    };

    await install({ onConflict: 'prompt', resolver });

    expect(Object.keys(await servers()).sort()).toEqual([
      'filesystem', // the project's, untouched
      'postgres',
      'review-files', // ours, under the name that was chosen
    ]);
    expect((await servers())['filesystem']).toEqual(FILESYSTEM_AS_FOUND);
    expect((await servers())['review-files']).toEqual(FILESYSTEM_AS_SHIPPED);

    // Both mentions in the subagent follow the server to its new name: the tool
    // namespace prefix, and the bare name in the prose.
    const agent = await readText(projectDir, '.claude/agents/code-reviewer.md');
    expect(agent).toContain('tools: Read, Grep, Bash, mcp__review-files__read_text_file');
    expect(agent).toContain('Read files through the `review-files` MCP server');
  });
});

describe('what the project had before', () => {
  it('survives an install and an uninstall, to the byte', async () => {
    await project('existing-setup');
    const handWritten = await original('existing-setup', 'CLAUDE.md');

    await install({ onConflict: 'skip' });

    // The hand-written notes are still there, with hcm's blocks appended below.
    const during = await readText(projectDir, 'CLAUDE.md');
    expect(during.startsWith(handWritten.trimEnd())).toBe(true);
    expect(during).toContain('<!-- hcm:begin review-kit/10-conventions -->');

    await uninstallCommand('review-kit', { scope: 'project', cwd: projectDir });

    expect(await readText(projectDir, 'CLAUDE.md')).toBe(handWritten);
  });
});
