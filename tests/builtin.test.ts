/**
 * The bundle that ships inside hcm: always available, never written to the
 * registry, impossible to unregister, and healthy enough to install anywhere.
 *
 * Every test points HCM_HOME at a fresh temp directory, so the registry and
 * user-scope state are disposable -- and start empty, which is the point: the
 * built-in bundle has to be there without anybody registering it.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportCommand } from '../src/commands/export.js';
import { importCommand } from '../src/commands/import.js';
import { installCommand } from '../src/commands/install.js';
import { validateCommand } from '../src/commands/validate.js';
import { BUILTIN_BUNDLES, builtinDir } from '../src/core/builtin.js';
import { configureLogger } from '../src/core/logger.js';
import {
  addToRegistry,
  availableEntries,
  matchEntry,
  nextRegistryId,
  readRegistry,
  refreshEntry,
  removeFromRegistry,
  resolveBundles,
} from '../src/core/registry.js';
import { scanReferences } from '../src/core/refs.js';
import { readState } from '../src/core/state.js';

const HCM = BUILTIN_BUNDLES.find((bundle) => bundle.name === 'hcm')!;

let workspace: string;
let projectDir: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-builtin-'));
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

const exists = async (relative: string): Promise<boolean> => {
  try {
    await fs.access(path.join(projectDir, ...relative.split('/')));
    return true;
  } catch {
    return false;
  }
};

describe('the built-in hcm bundle, as an asset', () => {
  it('validates', async () => {
    expect(await validateCommand(builtinDir(HCM), { cwd: workspace })).toBe(true);
  });

  // The strict scope, as for the healthy fixtures: this bundle documents path
  // syntax, so prose that looks like a reference is exactly what to catch.
  it('has no broken references', async () => {
    const result = await scanReferences(builtinDir(HCM), { allPaths: true });
    expect(result.broken.map((ref) => `${ref.fileRelative}: ${ref.ref}`)).toEqual([]);
  });

  // `npm version` keeps these in step through scripts/sync-builtin-version.mjs;
  // this is what notices when that did not happen.
  it('carries the version of the package it ships in', async () => {
    const pkg = JSON.parse(
      await fs.readFile(path.resolve(builtinDir(HCM), '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    const [entry] = await availableEntries();
    expect(entry?.version).toBe(pkg.version);
  });
});

describe('availability', () => {
  it('is listed with an empty registry, under a fixed id, and never persisted', async () => {
    const entries = await availableEntries();

    expect(entries.map((entry) => [entry.id, entry.name, entry.builtin])).toEqual([
      ['0', 'hcm', true],
    ]);
    expect(entries[0]?.flavors?.map((flavor) => flavor.name)).toEqual(['authoring', 'integration']);
    expect((await readRegistry()).entries).toEqual([]);
  });

  it('comes before registered bundles, whose ids still start at 1', async () => {
    const kit = path.join(workspace, 'kit');
    await fs.mkdir(kit, { recursive: true });
    await fs.writeFile(path.join(kit, 'hcm.yaml'), 'name: kit\nversion: 1.0.0\n');
    await addToRegistry(kit, workspace);

    expect((await availableEntries()).map((entry) => [entry.id, entry.name])).toEqual([
      ['0', 'hcm'],
      ['1', 'kit'],
    ]);
    // Writing the registry back must not have picked the built-in one up.
    expect((await readRegistry()).entries.map((entry) => entry.name)).toEqual(['kit']);
  });

  it('resolves by name and by id, from the package', async () => {
    for (const reference of ['hcm', '0']) {
      const [bundle] = await resolveBundles(reference, projectDir);
      expect(bundle?.manifest.name).toBe('hcm');
      expect(bundle?.root).toBe(builtinDir(HCM));
    }
  });

  it('refreshes in place, writing nothing', async () => {
    const [entry] = await availableEntries();
    const refreshed = await refreshEntry(entry!);

    expect(refreshed.bundle.root).toBe(builtinDir(HCM));
    expect((await readRegistry()).entries).toEqual([]);
  });
});

describe('the name is reserved', () => {
  async function bundleNamedHcm(): Promise<string> {
    const dir = path.join(workspace, 'impostor');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'hcm.yaml'), 'name: hcm\nversion: 9.9.9\n');
    return dir;
  }

  it('refuses to register another bundle called hcm', async () => {
    await expect(addToRegistry(await bundleNamedHcm(), workspace)).rejects.toThrow(
      /built into hcm/,
    );
  });

  it('accepts it under another name', async () => {
    const [entry] = await addToRegistry(await bundleNamedHcm(), workspace, { name: 'my-hcm' });
    expect(entry?.name).toBe('my-hcm');
  });

  it('cannot be unregistered, by name or by id', async () => {
    await expect(removeFromRegistry('hcm')).rejects.toThrow(/cannot be removed/);
    await expect(removeFromRegistry('0')).rejects.toThrow(/cannot be removed/);
  });
});

describe('the id 0 is reserved', () => {
  const registryFile = (): string => path.join(process.env.HCM_HOME!, 'registry.json');

  async function writeRegistryFile(entries: object[]): Promise<void> {
    await fs.mkdir(process.env.HCM_HOME!, { recursive: true });
    await fs.writeFile(registryFile(), JSON.stringify({ version: 1, entries }));
  }

  it('is never handed out, however the ids are taken', () => {
    expect(nextRegistryId([])).toBe('1');
    expect(nextRegistryId(['1', '2'])).toBe('3');
    // Even a registry that claims "0" for itself does not move the counter onto it.
    expect(nextRegistryId(['0'])).toBe('1');
  });

  it('is taken back from a registry file that gave it to a registered bundle', async () => {
    const kit = path.join(workspace, 'kit');
    await writeRegistryFile([
      { id: '0', name: 'kit', source: { type: 'local', path: kit } },
      { id: '1', name: 'other', source: { type: 'local', path: kit } },
    ]);

    const renumbered = (await readRegistry()).entries.map((entry) => [entry.id, entry.name]);
    expect(renumbered).toEqual([
      ['2', 'kit'],
      ['1', 'other'],
    ]);

    // Persisted, so the new id does not shift on the next read.
    const onDisk = JSON.parse(await fs.readFile(registryFile(), 'utf8')) as {
      entries: { id: string }[];
    };
    expect(onDisk.entries.map((entry) => entry.id)).toEqual(['2', '1']);
  });

  it('means the built-in bundle, even next to a bundle named "0"', async () => {
    const kit = path.join(workspace, 'kit');
    await fs.mkdir(kit, { recursive: true });
    await fs.writeFile(path.join(kit, 'hcm.yaml'), 'name: kit\nversion: 1.0.0\n');
    await writeRegistryFile([{ id: '1', name: '0', dev: true, source: { type: 'local', path: kit } }]);

    expect(matchEntry(await availableEntries(), '0')?.name).toBe('hcm');
    const [bundle] = await resolveBundles('0', projectDir);
    expect(bundle?.manifest.name).toBe('hcm');
  });

  it('cannot be used as the name of a registered bundle', async () => {
    const kit = path.join(workspace, 'zero');
    await fs.mkdir(kit, { recursive: true });
    await fs.writeFile(path.join(kit, 'hcm.yaml'), 'name: "0"\nversion: 1.0.0\n');

    await expect(addToRegistry(kit, workspace)).rejects.toThrow(/reserved/);
    await expect(
      addToRegistry(kit, workspace, { name: '0' }),
    ).rejects.toThrow(/reserved/);
    expect((await readRegistry()).entries).toEqual([]);
  });
});

describe('installing it into a project', () => {
  it('installs the common part and every flavor by default', async () => {
    await installCommand('hcm', {
      targets: ['claude-code'],
      scope: 'project',
      prompt: false,
      cwd: projectDir,
    });

    expect(await exists('.claude/skills/hcm-usage/SKILL.md')).toBe(true);
    expect(await exists('.claude/skills/hcm-bundle-authoring/SKILL.md')).toBe(true);
    expect(await exists('.claude/skills/hcm-integration/SKILL.md')).toBe(true);
    expect(await fs.readFile(path.join(projectDir, 'CLAUDE.md'), 'utf8')).toContain(
      '<!-- hcm:begin hcm/10-hcm -->',
    );
  });

  it('narrows to a flavor', async () => {
    await installCommand('hcm', {
      targets: ['claude-code'],
      scope: 'project',
      flavors: ['authoring'],
      prompt: false,
      cwd: projectDir,
    });

    expect(await exists('.claude/skills/hcm-usage/SKILL.md')).toBe(true);
    expect(await exists('.claude/skills/hcm-bundle-authoring/SKILL.md')).toBe(true);
    expect(await exists('.claude/skills/hcm-integration/SKILL.md')).toBe(false);
  });

  // The reference documents placeholder syntax, escaped so that it survives
  // the install as text rather than being filled in or refused.
  it('installs the documented placeholder as a literal', async () => {
    await installCommand('hcm', {
      targets: ['claude-code'],
      scope: 'project',
      prompt: false,
      cwd: projectDir,
    });

    const reference = await fs.readFile(
      path.join(projectDir, '.claude', 'skills', 'hcm-bundle-authoring', 'reference.md'),
      'utf8',
    );
    expect(reference).toContain('You work for the <%TEAM%> team.');
  });
});

describe('bundles.txt', () => {
  it('exports it by name, and imports it without registering anything', async () => {
    await installCommand('hcm', {
      targets: ['claude-code'],
      scope: 'project',
      prompt: false,
      cwd: projectDir,
    });

    const file = path.join(workspace, 'bundles.txt');
    await exportCommand(file, { scope: 'project', cwd: projectDir });
    const lines = (await fs.readFile(file, 'utf8'))
      .split('\n')
      .filter((line) => line && !line.startsWith('#'));
    expect(lines).toEqual(['hcm']);

    const elsewhere = path.join(workspace, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });
    await importCommand(file, {
      install: true,
      targets: ['pi'],
      scope: 'project',
      prompt: false,
      cwd: elsewhere,
    });

    const state = await readState('project', elsewhere);
    expect(state.installations.map((record) => [record.bundle, record.target])).toEqual([
      ['hcm', 'pi'],
    ]);
    expect((await readRegistry()).entries).toEqual([]);
  });
});
