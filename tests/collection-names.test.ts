/**
 * Collection manifests (`hcm_manifest.yml`) and named collections in the
 * registry: discovery through the `bundles` list, the collection name recorded
 * at registration, clashes between names, and `hcm registry remove
 * --collection`.
 *
 * Every test points HCM_HOME at a fresh temp directory, so the registry and
 * the store are disposable.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registryRemoveCommand } from '../src/commands/registry.js';
import { discoverBundles } from '../src/core/bundle.js';
import {
  type CollectionClash,
  type CollectionClashResolution,
  sameCollectionSource,
  suggestCollectionName,
} from '../src/core/collection-clash.js';
import { loadCollectionManifest } from '../src/core/collection.js';
import { configureLogger } from '../src/core/logger.js';
import {
  addToRegistry,
  readRegistry,
  refreshEntry,
  removeCollectionFromRegistry,
} from '../src/core/registry.js';
import { storeEntryDir } from '../src/core/store.js';
import type { RegistryEntry } from '../src/core/types.js';

let workspace: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-collection-'));
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

async function makeBundle(parent: string, folder: string, name = path.basename(folder)) {
  const dir = path.join(parent, folder);
  await fs.mkdir(path.join(dir, 'subagents'), { recursive: true });
  await fs.writeFile(path.join(dir, 'hcm.yaml'), `name: ${name}\nversion: 1.0.0\n`);
  await fs.writeFile(
    path.join(dir, 'subagents', `${name}.md`),
    '---\ndescription: test\n---\n\nBody.\n',
  );
  return dir;
}

/** A collection folder with the given bundle folders and collection manifest text. */
async function makeCollection(
  name: string,
  folders: string[],
  manifest?: string,
  manifestName = 'hcm_manifest.yml',
): Promise<string> {
  const root = path.join(workspace, name);
  await fs.mkdir(root, { recursive: true });
  for (const folder of folders) await makeBundle(root, folder);
  if (manifest !== undefined) await fs.writeFile(path.join(root, manifestName), manifest);
  return root;
}

const nameOf = (entry: RegistryEntry | undefined) => entry?.collection?.name;

/** A resolver that records each clash and gives the same answer. */
function answering(resolution: CollectionClashResolution) {
  const asked: CollectionClash[] = [];
  const resolver = async (clash: CollectionClash) => {
    asked.push(clash);
    return resolution;
  };
  return { asked, resolver };
}

describe('loadCollectionManifest', () => {
  it('returns undefined when the folder has no collection manifest', async () => {
    const root = await makeCollection('plain', ['alpha']);
    expect(await loadCollectionManifest(root)).toBeUndefined();
  });

  it('reads the collection name and the bundles list', async () => {
    const root = await makeCollection('kits', [], 'collection: acme\nbundles:\n  - a\n  - deep/b/\n');
    const manifest = await loadCollectionManifest(root);
    expect(manifest?.collection).toBe('acme');
    expect(manifest?.bundles).toEqual(['a', 'deep/b']);
  });

  it('reads the .json spelling', async () => {
    const root = await makeCollection('kits', [], '{"collection":"acme"}', 'hcm_manifest.json');
    expect((await loadCollectionManifest(root))?.collection).toBe('acme');
  });

  it('accepts an empty file', async () => {
    const root = await makeCollection('kits', [], '');
    const manifest = await loadCollectionManifest(root);
    expect(manifest?.collection).toBeUndefined();
    expect(manifest?.bundles).toBeUndefined();
  });

  it.each([
    ['a path out of the collection', 'bundles:\n  - ../other\n', /not a folder inside/],
    ['the collection root itself', 'bundles:\n  - .\n', /not a folder inside/],
    ['a path listed twice', 'bundles:\n  - a\n  - ./a\n', /listed twice/],
    ['an empty bundles list', 'bundles: []\n', /at least one folder/],
    ['a name that is not usable', 'collection: "my kits"\n', /not a usable collection name/],
    ['a name that is not a string', 'collection: [a]\n', /must be a string/],
    ['a list at the top', '- a\n', /must be a mapping/],
  ])('refuses %s', async (_label, text, message) => {
    const root = await makeCollection('kits', [], text);
    await expect(loadCollectionManifest(root)).rejects.toThrow(message);
  });
});

describe('discoverBundles', () => {
  it('scans the direct subfolders when the manifest has no bundles list', async () => {
    const root = await makeCollection('kits', ['alpha', 'beta'], 'collection: acme\n');
    const found = await discoverBundles(root);
    expect(found.dirs).toEqual([path.join(root, 'alpha'), path.join(root, 'beta')]);
    expect(found.collection).toBe('acme');
  });

  it('uses only the listed folders, in the listed order, deeper ones included', async () => {
    const root = await makeCollection(
      'kits',
      ['alpha', 'ignored', 'bundles/beta'],
      'bundles:\n  - bundles/beta\n  - alpha\n',
    );
    const found = await discoverBundles(root);
    expect(found.dirs).toEqual([path.join(root, 'bundles', 'beta'), path.join(root, 'alpha')]);
    expect(found.collection).toBeUndefined();
  });

  it('refuses a listed folder that holds no bundle', async () => {
    const root = await makeCollection('kits', ['alpha'], 'bundles:\n  - alpha\n  - missing\n');
    await expect(discoverBundles(root)).rejects.toThrow(/"missing" .* is not a bundle folder/);
  });

  it('refuses a folder that is a bundle and a collection at the same time', async () => {
    const root = await makeBundle(workspace, 'both');
    await fs.writeFile(path.join(root, 'hcm_manifest.yml'), 'collection: acme\n');
    await expect(discoverBundles(root)).rejects.toThrow(/both a bundle manifest and a collection/);
  });
});

describe('registering a named collection', () => {
  it('records the collection name and source on each bundle', async () => {
    const root = await makeCollection('kits', ['alpha', 'beta'], 'collection: acme\n');
    const entries = await addToRegistry(root, workspace);
    expect(entries.map((entry) => [entry.name, nameOf(entry)])).toEqual([
      ['alpha', 'acme'],
      ['beta', 'acme'],
    ]);
    expect(entries[0]?.collection?.source).toEqual({ type: 'local', path: root });
  });

  it('records no collection for a collection folder without a manifest', async () => {
    const root = await makeCollection('kits', ['alpha']);
    const [entry] = await addToRegistry(root, workspace);
    expect(entry?.collection).toBeUndefined();
  });

  it('lets --collection replace the name of the manifest', async () => {
    const root = await makeCollection('kits', ['alpha'], 'collection: acme\n');
    const [entry] = await addToRegistry(root, workspace, { collection: 'mine' });
    expect(nameOf(entry)).toBe('mine');
  });

  it('lets --collection group a single bundle', async () => {
    const dir = await makeBundle(workspace, 'solo');
    const [entry] = await addToRegistry(dir, workspace, { collection: 'mine' });
    expect(nameOf(entry)).toBe('mine');
  });

  it('refuses a --collection that is not a usable name', async () => {
    const dir = await makeBundle(workspace, 'solo');
    await expect(addToRegistry(dir, workspace, { collection: 'a b' })).rejects.toThrow(
      /not a usable collection name/,
    );
  });

  it('keeps the collection when one bundle is registered again alone', async () => {
    const root = await makeCollection('kits', ['alpha'], 'collection: acme\n');
    await addToRegistry(root, workspace);

    const [entry] = await addToRegistry(path.join(root, 'alpha'), workspace, { dev: true });
    expect(nameOf(entry)).toBe('acme');
    expect(entry?.dev).toBe(true);
  });

  it('keeps the collection when the bundle is read again from its source', async () => {
    const root = await makeCollection('kits', ['alpha'], 'collection: acme\n');
    const [entry] = await addToRegistry(root, workspace);

    const { entry: refreshed } = await refreshEntry(entry!);
    expect(nameOf(refreshed)).toBe('acme');
    expect(nameOf((await readRegistry()).entries[0])).toBe('acme');
  });
});

describe('sameCollectionSource', () => {
  const github = (subdir?: string, ref = 'v1') =>
    ({ type: 'github', owner: 'Acme', repo: 'kits', ref, ...(subdir ? { subdir } : {}) }) as const;

  it('ignores the ref', () => {
    expect(sameCollectionSource(github(undefined, 'v1'), github(undefined, 'v2'))).toBe(true);
  });

  it('treats a folder inside the other source as the same source, both ways', () => {
    expect(sameCollectionSource(github('alpha'), github())).toBe(true);
    expect(sameCollectionSource(github(), github('alpha'))).toBe(true);
  });

  it('does not treat a sibling or a folder with a shared prefix as the same', () => {
    expect(sameCollectionSource(github('alpha'), github('beta'))).toBe(false);
    expect(sameCollectionSource(github('kits'), github('kits-2'))).toBe(false);
  });

  it('compares a git URL without the .git suffix', () => {
    const git = (url: string) => ({ type: 'git', url, ref: 'HEAD' }) as const;
    expect(sameCollectionSource(git('https://h/r.git'), git('https://h/r'))).toBe(true);
    expect(sameCollectionSource(git('https://h/r'), git('https://h/s'))).toBe(false);
  });
});

describe('suggestCollectionName', () => {
  it('gives the first free numbered name', () => {
    const entries = [
      { collection: { name: 'acme' } },
      { collection: { name: 'ACME-2' } },
    ] as RegistryEntry[];
    expect(suggestCollectionName('acme', entries)).toBe('acme-3');
  });
});

describe('collection name clashes', () => {
  /** Two collection folders that ask for the same name. */
  async function twoSources() {
    const first = await makeCollection('first', ['alpha'], 'collection: acme\n');
    const second = await makeCollection('second', ['beta'], 'collection: acme\n');
    await addToRegistry(first, workspace);
    return { first, second };
  }

  it('asks when another source uses the name, and registers nothing on abort', async () => {
    const { second } = await twoSources();
    const { asked, resolver } = answering({ choice: 'abort' });

    await expect(
      addToRegistry(second, workspace, { resolveCollectionClash: resolver }),
    ).rejects.toThrow(/Aborted: the collection name "acme" is in use/);

    expect(asked).toHaveLength(1);
    expect(asked[0]?.holders.map((entry) => entry.name)).toEqual(['alpha']);
    expect(asked[0]?.suggestedName).toBe('acme-2');
    expect((await readRegistry()).entries.map((entry) => entry.name)).toEqual(['alpha']);
  });

  it('joins the existing collection, and does not ask again for the same source', async () => {
    const { second } = await twoSources();
    const { resolver } = answering({ choice: 'join' });
    await addToRegistry(second, workspace, { resolveCollectionClash: resolver });

    const again = answering({ choice: 'abort' });
    await addToRegistry(second, workspace, { resolveCollectionClash: again.resolver });

    expect(again.asked).toHaveLength(0);
    const entries = (await readRegistry()).entries;
    expect(entries.map((entry) => [entry.name, nameOf(entry)])).toEqual([
      ['alpha', 'acme'],
      ['beta', 'acme'],
    ]);
  });

  it('renames to the typed name, and reuses it for a later registration of the source', async () => {
    const { second } = await twoSources();
    const { resolver } = answering({ choice: 'rename', name: 'acme-second' });
    const [beta] = await addToRegistry(second, workspace, { resolveCollectionClash: resolver });

    expect(beta?.collection).toMatchObject({ name: 'acme-second', requested: 'acme' });

    const again = answering({ choice: 'abort' });
    const [later] = await addToRegistry(second, workspace, {
      resolveCollectionClash: again.resolver,
    });
    expect(again.asked).toHaveLength(0);
    expect(nameOf(later)).toBe('acme-second');
  });

  it('refuses a typed name that clashes too', async () => {
    const { second } = await twoSources();
    const { resolver } = answering({ choice: 'rename', name: 'ACME' });
    await expect(
      addToRegistry(second, workspace, { resolveCollectionClash: resolver }),
    ).rejects.toThrow(/Cannot use the collection name "ACME": it is in use too/);
  });

  it('applies --on-collection-clash rename with the suggested name', async () => {
    const { second } = await twoSources();
    const [beta] = await addToRegistry(second, workspace, { onCollectionClash: 'rename' });
    expect(nameOf(beta)).toBe('acme-2');
  });

  it('applies --on-collection-clash join', async () => {
    const { second } = await twoSources();
    const [beta] = await addToRegistry(second, workspace, { onCollectionClash: 'join' });
    expect(nameOf(beta)).toBe('acme');
  });

  it('stops with a hint, and registers nothing, when nobody can be asked', async () => {
    // The tests run without a terminal, so the default policy cannot ask.
    const { second } = await twoSources();
    await expect(addToRegistry(second, workspace)).rejects.toMatchObject({
      message: expect.stringMatching(/"acme" is in use by bundle alpha from .*first/),
      hint: expect.stringMatching(/--on-collection-clash join\|rename\|abort/),
    });
    expect((await readRegistry()).entries).toHaveLength(1);
  });

  it('is not a clash for a new ref of the same repository', async () => {
    // Local sources stand in: the same folder registered twice is the same source.
    const root = await makeCollection('kits', ['alpha'], 'collection: acme\n');
    await addToRegistry(root, workspace);
    const { asked, resolver } = answering({ choice: 'abort' });
    await addToRegistry(root, workspace, { resolveCollectionClash: resolver });
    expect(asked).toHaveLength(0);
  });

  it('is not a clash when one bundle of the collection is grouped from its own folder', async () => {
    const root = await makeCollection('kits', ['alpha', 'beta'], 'collection: acme\n');
    await addToRegistry(root, workspace);
    const { asked, resolver } = answering({ choice: 'abort' });

    const [alpha] = await addToRegistry(path.join(root, 'alpha'), workspace, {
      dev: true,
      collection: 'acme',
      resolveCollectionClash: resolver,
    });
    expect(asked).toHaveLength(0);
    expect(nameOf(alpha)).toBe('acme');
  });

  it('is not a clash when the only holders are the bundles being replaced', async () => {
    // The same bundles, moved to another folder.
    const old = await makeCollection('old', ['alpha'], 'collection: acme\n');
    const moved = await makeCollection('moved', ['alpha'], 'collection: acme\n');
    await addToRegistry(old, workspace);
    const { asked, resolver } = answering({ choice: 'abort' });

    await addToRegistry(moved, workspace, { resolveCollectionClash: resolver });
    expect(asked).toHaveLength(0);
    expect((await readRegistry()).entries[0]?.collection?.source).toEqual({
      type: 'local',
      path: moved,
    });
  });
});

describe('removing a collection', () => {
  async function registerTwoCollections() {
    const acme = await makeCollection('acme', ['alpha', 'beta'], 'collection: acme\n');
    const other = await makeCollection('other', ['gamma'], 'collection: other\n');
    await addToRegistry(acme, workspace);
    await addToRegistry(other, workspace);
    return (await readRegistry()).entries;
  }

  it('removes every bundle of the collection and its stored copy, and nothing else', async () => {
    const before = await registerTwoCollections();
    const alpha = before.find((entry) => entry.name === 'alpha')!;

    const removed = await removeCollectionFromRegistry('ACME');

    expect(removed.map((item) => item.entry.name)).toEqual(['alpha', 'beta']);
    expect(removed.every((item) => item.storeRemoved)).toBe(true);
    expect((await readRegistry()).entries.map((entry) => entry.name)).toEqual(['gamma']);
    await expect(fs.stat(await storeEntryDir(alpha.store!))).rejects.toThrow();
  });

  it('fails, and names the known collections, when the name is unknown', async () => {
    await registerTwoCollections();
    await expect(removeCollectionFromRegistry('nope')).rejects.toMatchObject({
      message: expect.stringMatching(/No registered bundle is in the collection "nope"/),
      hint: expect.stringMatching(/acme, other/),
    });
    expect((await readRegistry()).entries).toHaveLength(3);
  });

  it('accepts a collection and references together, and a reference into the collection', async () => {
    await registerTwoCollections();
    await registryRemoveCommand(['alpha', 'gamma'], { collection: 'acme', cwd: workspace });
    expect((await readRegistry()).entries).toEqual([]);
  });

  it('refuses a call with no reference and no collection', async () => {
    await expect(registryRemoveCommand([], { cwd: workspace })).rejects.toThrow(
      /Name the bundles to remove, or a collection/,
    );
  });
});
