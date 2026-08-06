import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBundleDirs, loadBundle } from '../src/core/bundle.js';
import { parseBundlesFile } from '../src/commands/import.js';
import { sourceToReference } from '../src/commands/export.js';

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-coll-'));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function makeBundle(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'agents'), { recursive: true });
  await fs.writeFile(path.join(dir, 'hcm.yaml'), `name: ${name}\nversion: 1.0.0\n`);
  await fs.writeFile(
    path.join(dir, 'agents', `${name}-agent.md`),
    '---\ndescription: test\n---\n\nBody.\n',
  );
  return dir;
}

describe('discoverBundleDirs', () => {
  it('returns the directory itself when it holds a manifest', async () => {
    const dir = await makeBundle(workspace, 'solo');
    expect(await discoverBundleDirs(dir)).toEqual([dir]);
  });

  it('finds every bundle in a collection', async () => {
    const collection = path.join(workspace, 'kits');
    await fs.mkdir(collection, { recursive: true });
    const alpha = await makeBundle(collection, 'alpha');
    const beta = await makeBundle(collection, 'beta');

    expect(await discoverBundleDirs(collection)).toEqual([alpha, beta]);
  });

  it('ignores subdirectories without a manifest', async () => {
    const collection = path.join(workspace, 'kits');
    await fs.mkdir(path.join(collection, 'docs'), { recursive: true });
    await fs.mkdir(path.join(collection, 'node_modules', 'pkg'), { recursive: true });
    await fs.mkdir(path.join(collection, '.github'), { recursive: true });
    const alpha = await makeBundle(collection, 'alpha');

    expect(await discoverBundleDirs(collection)).toEqual([alpha]);
  });

  it('prefers the root manifest over nested ones', async () => {
    // A bundle that happens to contain a subdirectory with its own manifest is
    // still a single bundle, not a collection.
    const root = await makeBundle(workspace, 'outer');
    await makeBundle(root, 'inner');

    expect(await discoverBundleDirs(root)).toEqual([root]);
  });

  it('returns nothing for a directory with no bundles', async () => {
    const empty = path.join(workspace, 'empty');
    await fs.mkdir(empty, { recursive: true });
    expect(await discoverBundleDirs(empty)).toEqual([]);
  });

  it('loads each discovered bundle independently', async () => {
    const collection = path.join(workspace, 'kits');
    await fs.mkdir(collection, { recursive: true });
    await makeBundle(collection, 'alpha');
    await makeBundle(collection, 'beta');

    const dirs = await discoverBundleDirs(collection);
    const bundles = await Promise.all(dirs.map((dir) => loadBundle(dir)));

    expect(bundles.map((bundle) => bundle.manifest.name)).toEqual(['alpha', 'beta']);
    expect(bundles[0]?.resources.map((r) => r.name)).toEqual(['alpha-agent']);
    expect(bundles[1]?.resources.map((r) => r.name)).toEqual(['beta-agent']);
  });
});

describe('sourceToReference', () => {
  it('writes a shorthand for a plain repo', () => {
    expect(
      sourceToReference({ type: 'github', owner: 'acme', repo: 'kits', ref: 'HEAD' }),
    ).toBe('acme/kits');
  });

  it('includes the subdirectory and ref', () => {
    expect(
      sourceToReference({
        type: 'github',
        owner: 'acme',
        repo: 'kits',
        ref: 'v1.2.0',
        subdir: 'bundles/my-kit',
      }),
    ).toBe('acme/kits/bundles/my-kit#v1.2.0');
  });

  it('refuses local sources, which mean nothing elsewhere', () => {
    expect(sourceToReference({ type: 'local', path: '/home/me/kit' })).toBeUndefined();
  });
});

describe('parseBundlesFile', () => {
  it('ignores comments and blank lines', () => {
    const contents = [
      '# hcm bundles file',
      '# generated 2026-01-01',
      '',
      'acme/kits/bundles/alpha#v1.0.0',
      '   ',
      '# beta - a comment about the next line',
      'acme/kits/bundles/beta',
      'https://github.com/acme/solo',
    ].join('\n');

    expect(parseBundlesFile(contents)).toEqual([
      'acme/kits/bundles/alpha#v1.0.0',
      'acme/kits/bundles/beta',
      'https://github.com/acme/solo',
    ]);
  });

  it('returns nothing for an empty or comment-only file', () => {
    expect(parseBundlesFile('')).toEqual([]);
    expect(parseBundlesFile('# nothing here\n')).toEqual([]);
  });
});
