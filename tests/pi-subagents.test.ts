/**
 * `--pi-subagents` is a fact about the machine, not a preference, so it is
 * recorded with the installation. What matters is that `hcm update` puts the
 * new version back where the old one was without being told again -- getting
 * that wrong would silently relocate every subagent on the box.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { updateCommand } from '../src/commands/update.js';
import { configureLogger } from '../src/core/logger.js';
import { addToRegistry } from '../src/core/registry.js';
import { readState } from '../src/core/state.js';

let workspace: string;
let projectDir: string;
let bundleRoot: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-pi-'));
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });

  previousHome = process.env.HCM_HOME;
  process.env.HCM_HOME = path.join(workspace, 'home');
  configureLogger({ quiet: true });

  bundleRoot = path.join(workspace, 'kit');
  await fs.mkdir(path.join(bundleRoot, 'subagents'), { recursive: true });
  await fs.writeFile(path.join(bundleRoot, 'hcm.yaml'), 'name: kit\nversion: 1.0.0\n');
  await fs.writeFile(
    path.join(bundleRoot, 'subagents', 'scout.md'),
    '---\ndescription: Fast recon\ntools: [Read, Grep]\n---\n\nScout the codebase.\n',
  );
  // --dev, so an edit to the bundle is what `hcm update` re-reads.
  await addToRegistry(bundleRoot, workspace, { dev: true });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HCM_HOME;
  else process.env.HCM_HOME = previousHome;
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

const exists = async (relative: string): Promise<boolean> => {
  try {
    await fs.access(path.join(projectDir, ...relative.split('/')));
    return true;
  } catch {
    return false;
  }
};

const install = (piSubagents: boolean): Promise<void> =>
  installCommand('kit', {
    targets: ['pi'],
    scope: 'project',
    cwd: projectDir,
    onConflict: 'abort',
    ...(piSubagents ? { targetOptions: { piSubagents: true } } : {}),
  });

const recordedOptions = async (): Promise<unknown> =>
  (await readState('project', projectDir)).installations[0]?.targetOptions;

describe('--pi-subagents', () => {
  it('records the flag with the installation', async () => {
    await install(true);

    expect(await exists('.pi/agents/scout.md')).toBe(true);
    expect(await recordedOptions()).toEqual({ piSubagents: true });
  });

  it('records nothing when the flag is absent', async () => {
    await install(false);

    expect(await exists('.pi/skills/scout/SKILL.md')).toBe(true);
    expect(await recordedOptions()).toBeUndefined();
  });

  it('is remembered by hcm update, which need not be told again', async () => {
    await install(true);

    await fs.writeFile(
      path.join(bundleRoot, 'subagents', 'scout.md'),
      '---\ndescription: Fast recon\ntools: [Read, Grep]\n---\n\nScout it, but better.\n',
    );
    await updateCommand('kit', { scope: 'project', cwd: projectDir, onConflict: 'abort' });

    // Still an agent file, now with the new prompt -- not moved back to skills.
    expect(await exists('.pi/skills/scout/SKILL.md')).toBe(false);
    const agent = await fs.readFile(path.join(projectDir, '.pi', 'agents', 'scout.md'), 'utf8');
    expect(agent).toContain('Scout it, but better.');
    expect(await recordedOptions()).toEqual({ piSubagents: true });
  });

  it('moves the subagent when update is told the extension is now there', async () => {
    await install(false);
    expect(await exists('.pi/skills/scout/SKILL.md')).toBe(true);

    await updateCommand('kit', {
      scope: 'project',
      cwd: projectDir,
      onConflict: 'abort',
      targetOptions: { piSubagents: true },
    });

    // Update is rollback-then-install, so the old location is cleaned up.
    expect(await exists('.pi/skills/scout/SKILL.md')).toBe(false);
    expect(await exists('.pi/agents/scout.md')).toBe(true);
    expect(await recordedOptions()).toEqual({ piSubagents: true });
  });

  it('does not touch the other harnesses', async () => {
    await installCommand('kit', {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      onConflict: 'abort',
      targetOptions: { piSubagents: true },
    });

    // The flag says something about Pi; Claude Code files subagents as it always did.
    expect(await exists('.claude/agents/scout.md')).toBe(true);
  });
});
