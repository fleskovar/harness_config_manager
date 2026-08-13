/**
 * A bundle that requires another one, as two real directories side by side.
 *
 * The collection is `tests/fixtures/collections/sprint-collection`:
 *
 *   sprint-kit/         requires team-conventions@^1.0.0
 *   team-conventions/   the bundle it requires
 *
 * Two things about them are worth checking by hand before reading the
 * assertions. First, `skills/jira-board/SKILL.md` is byte-for-byte identical in
 * both -- diff them -- so it is a *shared* item: written once, claimed twice.
 * Second, their settings fragments ask for one permission each plus one in
 * common, so the allow-list they add up to has three entries, not four.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { uninstallCommand } from '../src/commands/uninstall.js';
import { configureLogger } from '../src/core/logger.js';
import { readState } from '../src/core/state.js';
import type { InstallationRecord } from '../src/core/types.js';
import { copyFixture, exists, listTree, makeWorkspace, readJson } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let collection: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await makeWorkspace('deps-fixture');
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });
  collection = await copyFixture(
    'collections/sprint-collection',
    path.join(workspace, 'sprint-collection'),
  );

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

const bundleDir = (name: string): string => path.join(collection, name);

const installSprintKit = (options: { noDeps?: boolean } = {}): Promise<void> =>
  installCommand(bundleDir('sprint-kit'), {
    targets: ['claude-code'],
    scope: 'project',
    cwd: projectDir,
    ...(options.noDeps ? { noDeps: true } : {}),
  });

const recordFor = async (bundle: string): Promise<InstallationRecord | undefined> =>
  (await readState('project', projectDir)).installations.find((record) => record.bundle === bundle);

/** Which installations recorded a receipt for this path. */
const claimants = async (relativePath: string): Promise<string[]> => {
  const state = await readState('project', projectDir);
  return state.installations
    .filter((record) => record.receipts.some((receipt) => receipt.path === relativePath))
    .map((record) => record.bundle)
    .sort();
};

const allowList = async (): Promise<string[]> => {
  const settings = await readJson<{ permissions: { allow: string[] } }>(
    projectDir,
    '.claude/settings.json',
  );
  return settings.permissions.allow;
};

// ---------------------------------------------------------------------------

describe('installing sprint-kit', () => {
  it('installs team-conventions first, without being asked to', async () => {
    await installSprintKit();

    expect(await listTree(projectDir)).toEqual([
      '.claude/agents/sprint-planner.md', // sprint-kit
      '.claude/agents/ticket-triager.md', // team-conventions
      '.claude/settings.json', // both
      '.claude/skills/jira-board/SKILL.md', // both -- one file
    ]);
  });

  it('marks the dependency as automatic and records the range it satisfied', async () => {
    await installSprintKit();

    expect((await recordFor('team-conventions'))?.auto).toBe(true);
    expect((await recordFor('sprint-kit'))?.auto).toBeUndefined();
    expect((await recordFor('sprint-kit'))?.dependencies).toEqual([
      { name: 'team-conventions', version: '1.0.0', range: '^1.0.0' },
    ]);
  });

  it('writes the skill both bundles ship once, and lets both claim it', async () => {
    await installSprintKit();

    expect(await claimants('.claude/skills/jira-board/SKILL.md')).toEqual([
      'sprint-kit',
      'team-conventions',
    ]);
  });

  it('adds up the two allow-lists without repeating the permission they share', async () => {
    await installSprintKit();

    expect(await allowList()).toEqual([
      'Bash(git log:*)', // asked for by both
      'WebFetch(domain:jira.example.com)', // team-conventions only
      'Bash(npm test:*)', // sprint-kit only
    ]);
  });

  it('--no-deps installs only what was named', async () => {
    await installSprintKit({ noDeps: true });

    expect(await listTree(projectDir)).toEqual([
      '.claude/agents/sprint-planner.md',
      '.claude/settings.json',
      '.claude/skills/jira-board/SKILL.md',
    ]);
    expect(await recordFor('team-conventions')).toBeUndefined();
  });
});

describe('uninstalling', () => {
  const uninstall = (bundle: string, options: Record<string, unknown> = {}): Promise<void> =>
    uninstallCommand(bundle, { scope: 'project', cwd: projectDir, ...options });

  it('takes the dependency with it once nothing needs it', async () => {
    await installSprintKit();

    await uninstall('sprint-kit');

    expect(await listTree(projectDir)).toEqual([]);
    expect((await readState('project', projectDir)).installations).toEqual([]);
  });

  it('--keep-orphans leaves the dependency, its skill and its permissions in place', async () => {
    await installSprintKit();

    await uninstall('sprint-kit', { keepOrphans: true });

    // The shared skill is held by team-conventions, so it stays.
    expect(await exists(projectDir, '.claude/skills/jira-board/SKILL.md')).toBe(true);
    expect(await exists(projectDir, '.claude/agents/ticket-triager.md')).toBe(true);
    expect(await exists(projectDir, '.claude/agents/sprint-planner.md')).toBe(false);

    // Down to exactly the two permissions team-conventions asked for.
    expect(await allowList()).toEqual(['Bash(git log:*)', 'WebFetch(domain:jira.example.com)']);
    expect(await claimants('.claude/skills/jira-board/SKILL.md')).toEqual(['team-conventions']);
  });

  it('refuses to remove the dependency while sprint-kit still needs it', async () => {
    await installSprintKit();

    await expect(uninstall('team-conventions')).rejects.toThrow(/still depend on this one/i);
    expect(await exists(projectDir, '.claude/skills/jira-board/SKILL.md')).toBe(true);
  });

  it('--cascade removes the dependent as well', async () => {
    await installSprintKit();

    await uninstall('team-conventions', { cascade: true });

    expect(await listTree(projectDir)).toEqual([]);
  });
});

describe('the settings file the two bundles share', () => {
  it('is left holding only the other bundle’s keys, whichever goes first', async () => {
    await installSprintKit();

    // Remove the dependency (ignoring the dependent) and sprint-kit's own two
    // permissions survive -- including the one both asked for.
    await uninstallCommand('team-conventions', {
      scope: 'project',
      cwd: projectDir,
      ignoreDependents: true,
    });

    expect(await allowList()).toEqual(['Bash(git log:*)', 'Bash(npm test:*)']);
  });
});
