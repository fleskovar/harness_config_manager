/**
 * The registry: short ids, the bundle store, `--dev` entries, and the
 * update/remove round trip that depends on both.
 *
 * Every test points HCM_HOME at a fresh temp directory, so the registry, store
 * and user-scope state are all disposable.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { updateCommand } from '../src/commands/update.js';
import { configureLogger } from '../src/core/logger.js';
import {
  addToRegistry,
  matchEntry,
  nextRegistryId,
  readRegistry,
  refreshEntry,
  removeFromRegistry,
  resolveBundles,
  resolveInstalledName,
} from '../src/core/registry.js';
import { storeEntryDir } from '../src/core/store.js';
import { readState } from '../src/core/state.js';
import type { RegistryEntry } from '../src/core/types.js';

let workspace: string;
let projectDir: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-registry-'));
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

/** A local bundle with one subagent, so we can watch its content travel. */
async function makeBundle(
  name: string,
  options: { version?: string; body?: string; extraSubagent?: string } = {},
): Promise<string> {
  const dir = path.join(workspace, name);
  await fs.mkdir(path.join(dir, 'subagents'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'hcm.yaml'),
    `name: ${name}\nversion: ${options.version ?? '1.0.0'}\ndescription: test bundle\n`,
  );
  await fs.writeFile(
    path.join(dir, 'subagents', 'reviewer.md'),
    `---\ndescription: Reviews code\n---\n\n${options.body ?? 'Version one.'}\n`,
  );
  if (options.extraSubagent) {
    await fs.writeFile(
      path.join(dir, 'subagents', `${options.extraSubagent}.md`),
      '---\ndescription: Extra\n---\n\nExtra.\n',
    );
  }
  return dir;
}

const readIfExists = async (target: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return undefined;
  }
};

const exists = async (target: string): Promise<boolean> =>
  (await readIfExists(target)) !== undefined;

describe('short ids', () => {
  it('hands out the smallest free id, in base 36', () => {
    expect(nextRegistryId([])).toBe('1');
    expect(nextRegistryId(['1', '2'])).toBe('3');
    // 9 -> a keeps ids one character for the first 35 bundles.
    expect(nextRegistryId(['1', '2', '3', '4', '5', '6', '7', '8', '9'])).toBe('a');
    // A gap left by "registry remove" is reused rather than skipped.
    expect(nextRegistryId(['1', '3'])).toBe('2');
  });

  it('assigns one per registered bundle', async () => {
    await addToRegistry(await makeBundle('alpha'), workspace);
    await addToRegistry(await makeBundle('beta'), workspace);

    const registry = await readRegistry();
    expect(registry.entries.map((entry) => [entry.id, entry.name])).toEqual([
      ['1', 'alpha'],
      ['2', 'beta'],
    ]);
  });

  it('keeps the id when a bundle is re-registered', async () => {
    const dir = await makeBundle('alpha');
    await addToRegistry(dir, workspace);
    await addToRegistry(await makeBundle('beta'), workspace);
    const [again] = await addToRegistry(dir, workspace);

    expect(again?.id).toBe('1');
    expect((await readRegistry()).entries).toHaveLength(2);
  });

  it('backfills ids for a registry written before they existed', async () => {
    const legacy = {
      version: 1,
      entries: [
        { name: 'alpha', source: { type: 'local', path: '/tmp/alpha' } },
        { name: 'beta', source: { type: 'local', path: '/tmp/beta' } },
      ],
    };
    const file = path.join(process.env.HCM_HOME as string, 'registry.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(legacy));

    expect((await readRegistry()).entries.map((entry) => entry.id)).toEqual(['1', '2']);
    // Persisted, so the ids do not shift as entries come and go.
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as { entries: RegistryEntry[] };
    expect(onDisk.entries.map((entry) => entry.id)).toEqual(['1', '2']);
  });

  it('matches a reference by name, then id, then case-insensitively', async () => {
    await addToRegistry(await makeBundle('My-Kit'), workspace);
    const entries = (await readRegistry()).entries;

    expect(matchEntry(entries, 'My-Kit')?.name).toBe('My-Kit');
    expect(matchEntry(entries, '1')?.name).toBe('My-Kit');
    expect(matchEntry(entries, 'my-kit')?.name).toBe('My-Kit');
    expect(matchEntry(entries, 'nope')).toBeUndefined();
  });

  it('resolves a bundle by its id', async () => {
    await addToRegistry(await makeBundle('alpha'), workspace);
    const [bundle] = await resolveBundles('1', projectDir);
    expect(bundle?.manifest.name).toBe('alpha');
  });

  it('maps an id to the installed bundle name, and passes strangers through', async () => {
    await addToRegistry(await makeBundle('alpha'), workspace);
    expect(await resolveInstalledName('1')).toBe('alpha');
    expect(await resolveInstalledName('never-registered')).toBe('never-registered');
  });
});

describe('the bundle store', () => {
  it('snapshots a local bundle, so later edits do not leak into installs', async () => {
    const origin = await makeBundle('alpha', { body: 'Version one.' });
    const [entry] = await addToRegistry(origin, workspace);

    const stored = path.join(await storeEntryDir(entry?.store as string), 'hcm.yaml');
    expect(await exists(stored)).toBe(true);

    await fs.writeFile(
      path.join(origin, 'subagents', 'reviewer.md'),
      '---\ndescription: Reviews code\n---\n\nEdited after registering.\n',
    );

    const [bundle] = await resolveBundles('alpha', projectDir);
    expect(bundle?.resources[0]?.body).toContain('Version one.');
  });

  it('re-populates a store directory that has gone missing', async () => {
    const [entry] = await addToRegistry(await makeBundle('alpha'), workspace);
    await fs.rm(await storeEntryDir(entry?.store as string), { recursive: true, force: true });

    const [bundle] = await resolveBundles('alpha', projectDir);
    expect(bundle?.manifest.name).toBe('alpha');
    expect(await exists(path.join(await storeEntryDir(entry?.store as string), 'hcm.yaml'))).toBe(
      true,
    );
  });

  it('leaves node_modules and .git behind', async () => {
    const origin = await makeBundle('alpha');
    await fs.mkdir(path.join(origin, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(origin, 'node_modules', 'pkg', 'index.js'), '');
    await fs.mkdir(path.join(origin, '.git'), { recursive: true });
    await fs.writeFile(path.join(origin, '.git', 'HEAD'), 'ref: refs/heads/main');

    const [entry] = await addToRegistry(origin, workspace);
    const stored = await storeEntryDir(entry?.store as string);

    expect(await exists(path.join(stored, 'hcm.yaml'))).toBe(true);
    expect(await exists(path.join(stored, 'node_modules', 'pkg', 'index.js'))).toBe(false);
    expect(await exists(path.join(stored, '.git', 'HEAD'))).toBe(false);
  });
});

describe('registry add --dev', () => {
  it('reads the working copy every time', async () => {
    const origin = await makeBundle('alpha', { body: 'Version one.' });
    const [entry] = await addToRegistry(origin, workspace, { dev: true });

    expect(entry?.dev).toBe(true);
    expect(entry?.store).toBeUndefined();

    await fs.writeFile(
      path.join(origin, 'subagents', 'reviewer.md'),
      '---\ndescription: Reviews code\n---\n\nEdited in place.\n',
    );

    const [bundle] = await resolveBundles('alpha', projectDir);
    expect(bundle?.resources[0]?.body).toContain('Edited in place.');
  });

  it('refuses a source that has to be downloaded', async () => {
    await expect(addToRegistry('acme/kits', workspace, { dev: true })).rejects.toThrow(
      /only applies to bundles on this filesystem/,
    );
  });

  it('drops the stored copy when a snapshot entry becomes a dev entry', async () => {
    const origin = await makeBundle('alpha');
    const [snapshot] = await addToRegistry(origin, workspace);
    const stored = await storeEntryDir(snapshot?.store as string);
    expect(await exists(path.join(stored, 'hcm.yaml'))).toBe(true);

    const [dev] = await addToRegistry(origin, workspace, { dev: true });
    expect(dev?.dev).toBe(true);
    expect(await exists(path.join(stored, 'hcm.yaml'))).toBe(false);
  });
});

describe('registry remove', () => {
  it('unregisters the bundle and deletes its stored copy', async () => {
    const [entry] = await addToRegistry(await makeBundle('alpha'), workspace);
    const stored = await storeEntryDir(entry?.store as string);

    const removed = await removeFromRegistry('1');

    expect(removed?.entry.name).toBe('alpha');
    expect(removed?.storeRemoved).toBe(true);
    expect(await exists(path.join(stored, 'hcm.yaml'))).toBe(false);
    expect((await readRegistry()).entries).toEqual([]);
  });

  it('never deletes a dev bundle’s working copy', async () => {
    const origin = await makeBundle('alpha');
    await addToRegistry(origin, workspace, { dev: true });

    const removed = await removeFromRegistry('alpha');

    expect(removed?.storeRemoved).toBe(false);
    expect(await exists(path.join(origin, 'hcm.yaml'))).toBe(true);
  });

  it('reports an unknown reference rather than removing something else', async () => {
    await addToRegistry(await makeBundle('alpha'), workspace);
    expect(await removeFromRegistry('nope')).toBeUndefined();
    expect((await readRegistry()).entries).toHaveLength(1);
  });
});

describe('refreshEntry', () => {
  it('re-reads the origin and records the new version', async () => {
    const origin = await makeBundle('alpha', { version: '1.0.0' });
    const [entry] = await addToRegistry(origin, workspace);

    await fs.writeFile(
      path.join(origin, 'hcm.yaml'),
      'name: alpha\nversion: 2.0.0\ndescription: test bundle\n',
    );

    const refreshed = await refreshEntry(entry as RegistryEntry);

    expect(refreshed.previousVersion).toBe('1.0.0');
    expect(refreshed.bundle.manifest.version).toBe('2.0.0');
    expect((await readRegistry()).entries[0]?.version).toBe('2.0.0');
  });
});

describe('hcm update', () => {
  const install = (reference: string): Promise<void> =>
    installCommand(reference, { scope: 'project', targets: ['claude-code'], cwd: projectDir });

  const agentFile = (name: string): string =>
    path.join(projectDir, '.claude', 'agents', `${name}.md`);

  it('reinstalls the new version and removes what the new version dropped', async () => {
    const origin = await makeBundle('alpha', { body: 'Version one.', extraSubagent: 'retired' });
    await addToRegistry(origin, workspace);
    await install('1');

    expect(await readIfExists(agentFile('reviewer'))).toContain('Version one.');
    expect(await exists(agentFile('retired'))).toBe(true);

    // A new upstream version: one subagent rewritten, one deleted.
    await fs.writeFile(
      path.join(origin, 'hcm.yaml'),
      'name: alpha\nversion: 2.0.0\ndescription: test bundle\n',
    );
    await fs.writeFile(
      path.join(origin, 'subagents', 'reviewer.md'),
      '---\ndescription: Reviews code\n---\n\nVersion two.\n',
    );
    await fs.rm(path.join(origin, 'subagents', 'retired.md'));

    await updateCommand('1', { cwd: projectDir });

    expect(await readIfExists(agentFile('reviewer'))).toContain('Version two.');
    expect(await exists(agentFile('retired'))).toBe(false);

    const state = await readState('project', projectDir);
    expect(state.installations).toHaveLength(1);
    expect(state.installations[0]?.version).toBe('2.0.0');
  });

  it('updates every registered bundle with "all"', async () => {
    const alpha = await makeBundle('alpha', { body: 'Alpha one.' });
    const beta = await makeBundle('beta', { body: 'Beta one.' });
    // Two bundles cannot both own `reviewer`, so give each its own subagent.
    await fs.rename(
      path.join(beta, 'subagents', 'reviewer.md'),
      path.join(beta, 'subagents', 'auditor.md'),
    );

    await addToRegistry(alpha, workspace);
    await addToRegistry(beta, workspace);
    await install('alpha');
    await install('beta');

    await fs.writeFile(
      path.join(alpha, 'subagents', 'reviewer.md'),
      '---\ndescription: Reviews code\n---\n\nAlpha two.\n',
    );
    await fs.writeFile(
      path.join(beta, 'subagents', 'auditor.md'),
      '---\ndescription: Audits code\n---\n\nBeta two.\n',
    );

    await updateCommand('all', { cwd: projectDir });

    expect(await readIfExists(agentFile('reviewer'))).toContain('Alpha two.');
    expect(await readIfExists(agentFile('auditor'))).toContain('Beta two.');
  });

  it('refreshes the stored copy even when nothing is installed', async () => {
    const origin = await makeBundle('alpha', { version: '1.0.0' });
    await addToRegistry(origin, workspace);

    await fs.writeFile(
      path.join(origin, 'hcm.yaml'),
      'name: alpha\nversion: 3.0.0\ndescription: test bundle\n',
    );
    await updateCommand('alpha', { cwd: projectDir });

    expect((await readRegistry()).entries[0]?.version).toBe('3.0.0');
  });

  it('leaves the harness, the store and the registry alone on a dry run', async () => {
    const origin = await makeBundle('alpha', { version: '1.0.0', body: 'Version one.' });
    const [entry] = await addToRegistry(origin, workspace);
    await install('1');

    await fs.writeFile(
      path.join(origin, 'hcm.yaml'),
      'name: alpha\nversion: 2.0.0\ndescription: test bundle\n',
    );
    await fs.writeFile(
      path.join(origin, 'subagents', 'reviewer.md'),
      '---\ndescription: Reviews code\n---\n\nVersion two.\n',
    );

    await updateCommand('1', { cwd: projectDir, dryRun: true });

    expect(await readIfExists(agentFile('reviewer'))).toContain('Version one.');
    expect((await readRegistry()).entries[0]?.version).toBe('1.0.0');

    const stored = path.join(await storeEntryDir(entry?.store as string), 'hcm.yaml');
    expect(await readIfExists(stored)).toContain('version: 1.0.0');
  });

  it('finds the installation when the registry name is an alias', async () => {
    // `registry add --name` renames the entry, not the bundle: installs are
    // still recorded under the manifest name.
    const origin = await makeBundle('alpha', { body: 'Version one.' });
    await addToRegistry(origin, workspace, { name: 'my-alias' });
    await install('my-alias');

    await fs.writeFile(
      path.join(origin, 'subagents', 'reviewer.md'),
      '---\ndescription: Reviews code\n---\n\nVersion two.\n',
    );

    await updateCommand('my-alias', { cwd: projectDir });
    expect(await readIfExists(agentFile('reviewer'))).toContain('Version two.');
  });

  it('refuses an unknown bundle', async () => {
    await expect(updateCommand('nope', { cwd: projectDir })).rejects.toThrow(
      /not a registered bundle/,
    );
  });

  it('picks up edits to a dev bundle without touching a store', async () => {
    const origin = await makeBundle('alpha', { body: 'Version one.' });
    await addToRegistry(origin, workspace, { dev: true });
    await install('alpha');

    await fs.writeFile(
      path.join(origin, 'subagents', 'reviewer.md'),
      '---\ndescription: Reviews code\n---\n\nEdited in place.\n',
    );

    await updateCommand('alpha', { cwd: projectDir });
    expect(await readIfExists(agentFile('reviewer'))).toContain('Edited in place.');
  });
});

describe('reinstalling over your own items', () => {
  it('is not a conflict when nobody has touched them', async () => {
    const origin = await makeBundle('alpha', { body: 'Version one.' });
    await addToRegistry(origin, workspace, { dev: true });
    await installCommand('alpha', {
      scope: 'project',
      targets: ['claude-code'],
      cwd: projectDir,
    });

    await fs.writeFile(
      path.join(origin, 'subagents', 'reviewer.md'),
      '---\ndescription: Reviews code\n---\n\nVersion two.\n',
    );

    // Without --force: the old planner refused this as "file exists and differs".
    await installCommand('alpha', {
      scope: 'project',
      targets: ['claude-code'],
      cwd: projectDir,
    });

    const installed = await readIfExists(
      path.join(projectDir, '.claude', 'agents', 'reviewer.md'),
    );
    expect(installed).toContain('Version two.');
  });

  it('still refuses when the installed item was hand-edited', async () => {
    const origin = await makeBundle('alpha', { body: 'Version one.' });
    await addToRegistry(origin, workspace, { dev: true });
    await installCommand('alpha', {
      scope: 'project',
      targets: ['claude-code'],
      cwd: projectDir,
    });

    const installedFile = path.join(projectDir, '.claude', 'agents', 'reviewer.md');
    await fs.writeFile(installedFile, '---\ndescription: mine now\n---\n\nHand edited.\n');

    await fs.writeFile(
      path.join(origin, 'subagents', 'reviewer.md'),
      '---\ndescription: Reviews code\n---\n\nVersion two.\n',
    );

    await expect(
      installCommand('alpha', { scope: 'project', targets: ['claude-code'], cwd: projectDir }),
    ).rejects.toThrow(/conflict/i);
  });
});
