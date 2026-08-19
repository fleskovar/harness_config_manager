/**
 * Bundles that require other bundles.
 *
 * End to end through the real commands, because the interesting parts are the
 * seams: resolution decides *what* to install, ordering decides *when*, and the
 * claim ledger decides what a later uninstall is allowed to take away.
 *
 * HCM_HOME points at a fresh temp directory, so the registry, store and
 * user-scope state are all disposable.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { uninstallCommand } from '../src/commands/uninstall.js';
import { updateCommand } from '../src/commands/update.js';
import { loadBundle } from '../src/core/bundle.js';
import { resolveDependencyGraph } from '../src/core/deps.js';
import { HcmError } from '../src/core/errors.js';
import { configureLogger } from '../src/core/logger.js';
import { addToRegistry, entryDir } from '../src/core/registry.js';
import { readState } from '../src/core/state.js';
import type { InstallationRecord, RegistryEntry } from '../src/core/types.js';

let workspace: string;
let projectDir: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-deps-'));
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

interface BundleSpec {
  version?: string;
  dependencies?: string;
  /** Extra manifest lines, e.g. `targets: [claude-code]`. */
  manifest?: string;
  /** A skill both this bundle and its dependency may ship identically. */
  sharedSkill?: boolean;
  /** Where to put it; defaults to a directory of its own in the workspace. */
  at?: string;
}

const SHARED_SKILL = '---\ndescription: How to talk to the JIRA board\n---\n\nUse the board API.\n';

async function makeBundle(name: string, spec: BundleSpec = {}): Promise<string> {
  const dir = spec.at ?? path.join(workspace, name);

  const manifest = [
    `name: ${name}`,
    `version: ${spec.version ?? '1.0.0'}`,
    ...(spec.dependencies ? [`dependencies:\n${spec.dependencies}`] : []),
    ...(spec.manifest ? [spec.manifest] : []),
  ].join('\n');

  await fs.mkdir(path.join(dir, 'subagents'), { recursive: true });
  await fs.writeFile(path.join(dir, 'hcm.yaml'), `${manifest}\n`);
  await fs.writeFile(
    path.join(dir, 'subagents', `${name}-worker.md`),
    `---\ndescription: Works on ${name}\n---\n\nDo ${name} work.\n`,
  );

  if (spec.sharedSkill) {
    await fs.mkdir(path.join(dir, 'skills', 'jira-board'), { recursive: true });
    await fs.writeFile(path.join(dir, 'skills', 'jira-board', 'SKILL.md'), SHARED_SKILL);
  }

  return dir;
}

const install = (reference: string, options: Record<string, unknown> = {}): Promise<void> =>
  installCommand(reference, { scope: 'project', cwd: projectDir, targets: ['claude-code'], ...options });

const uninstall = (reference: string, options: Record<string, unknown> = {}): Promise<void> =>
  uninstallCommand(reference, { scope: 'project', cwd: projectDir, ...options });

const installed = async (): Promise<InstallationRecord[]> =>
  (await readState('project', projectDir)).installations;

const installedNames = async (): Promise<string[]> =>
  (await installed()).map((record) => record.bundle).sort();

const exists = async (relative: string): Promise<boolean> => {
  try {
    await fs.access(path.join(projectDir, ...relative.split('/')));
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------

describe('resolution', () => {
  it('finds a dependency in the registry and orders it first', async () => {
    await addToRegistry(await makeBundle('jira-board'), workspace);
    const consumer = await makeBundle('sprint-kit', { dependencies: '  - jira-board' });

    const graph = await resolveDependencyGraph([await loadBundle(consumer)], projectDir);

    expect(graph.order.map((entry) => entry.bundle.manifest.name)).toEqual([
      'jira-board',
      'sprint-kit',
    ]);
    expect(graph.byName.get('jira-board')).toMatchObject({
      explicit: false,
      via: 'registry',
      requiredBy: ['sprint-kit'],
    });
  });

  it('finds a sibling in the same collection, with nothing registered', async () => {
    const collection = path.join(workspace, 'kits');
    await makeBundle('jira-board', { at: path.join(collection, 'jira-board') });
    const consumer = await makeBundle('sprint-kit', {
      at: path.join(collection, 'sprint-kit'),
      dependencies: '  - jira-board',
    });

    const graph = await resolveDependencyGraph([await loadBundle(consumer)], projectDir);

    expect(graph.byName.get('jira-board')?.via).toBe('sibling');
  });

  it('falls back to the source the dependency itself names', async () => {
    const board = await makeBundle('jira-board', { at: path.join(workspace, 'elsewhere', 'board') });
    // Somewhere with no siblings, so `source` is the only way to find it.
    const consumer = await makeBundle('sprint-kit', {
      at: path.join(workspace, 'consumers', 'sprint-kit'),
      dependencies: `  - name: jira-board\n    source: ${board.replace(/\\/g, '/')}`,
    });

    const graph = await resolveDependencyGraph([await loadBundle(consumer)], projectDir);

    expect(graph.byName.get('jira-board')?.via).toBe('source');
  });

  it('reads a relative source against the manifest, not the working directory', async () => {
    // The shared bundle sits two folders up from its consumer and nowhere else:
    // not registered, not a sibling. A relative "source" is the only route to
    // it, and it has to mean the same thing from any directory hcm is run in --
    // here `projectDir`, which is not even in the same branch of the tree.
    await makeBundle('jira-board', { at: path.join(workspace, 'shared', 'jira-board') });
    const consumer = await makeBundle('sprint-kit', {
      at: path.join(workspace, 'apps', 'sprint-kit'),
      dependencies: '  - name: jira-board\n    source: ../../shared/jira-board',
    });

    const graph = await resolveDependencyGraph([await loadBundle(consumer)], projectDir);

    expect(graph.byName.get('jira-board')?.via).toBe('source');
    expect(graph.order.map((entry) => entry.bundle.manifest.name)).toEqual([
      'jira-board',
      'sprint-kit',
    ]);
  });

  it("reads a registered bundle's relative source against the folder it came from", async () => {
    // A snapshot in the store has no neighbours, so the path is read a second
    // time against the directory the snapshot was taken from -- the same reason
    // `fromSibling` looks in two places.
    await makeBundle('jira-board', { at: path.join(workspace, 'shared', 'jira-board') });
    const consumer = await makeBundle('sprint-kit', {
      at: path.join(workspace, 'apps', 'sprint-kit'),
      dependencies: '  - name: jira-board\n    source: ../../shared/jira-board',
    });
    const [entry] = await addToRegistry(consumer, workspace);

    // Loaded the way `fromRegistry` loads it: the files from the store, the
    // source from the registry entry.
    const stored = await loadBundle(await entryDir(entry as RegistryEntry), entry?.source);
    const graph = await resolveDependencyGraph([stored], projectDir);

    expect(graph.byName.get('jira-board')?.via).toBe('source');
  });

  it('resolves a diamond once', async () => {
    await addToRegistry(await makeBundle('jira-board'), workspace);
    await addToRegistry(
      await makeBundle('sprint-kit', { dependencies: '  - jira-board' }),
      workspace,
    );
    await addToRegistry(
      await makeBundle('report-kit', { dependencies: '  - jira-board' }),
      workspace,
    );
    const top = await makeBundle('team-kit', {
      dependencies: '  - sprint-kit\n  - report-kit',
    });

    const graph = await resolveDependencyGraph([await loadBundle(top)], projectDir);
    const order = graph.order.map((entry) => entry.bundle.manifest.name);

    expect(order.filter((name) => name === 'jira-board')).toHaveLength(1);
    // Dependencies before whoever needs them, however deep.
    expect(order.indexOf('jira-board')).toBeLessThan(order.indexOf('sprint-kit'));
    expect(order.indexOf('report-kit')).toBeLessThan(order.indexOf('team-kit'));
    expect(graph.byName.get('jira-board')?.requiredBy.sort()).toEqual(['report-kit', 'sprint-kit']);
  });

  it('honours a version range', async () => {
    await addToRegistry(await makeBundle('jira-board', { version: '1.4.2' }), workspace);

    const ok = await makeBundle('sprint-kit', { dependencies: '  - jira-board@^1.2.0' });
    await expect(resolveDependencyGraph([await loadBundle(ok)], projectDir)).resolves.toBeDefined();

    // Nothing in range: the error says what versions there actually are.
    const tooNew = await makeBundle('other-kit', { dependencies: '  - jira-board@^2.0.0' });
    await expect(resolveDependencyGraph([await loadBundle(tooNew)], projectDir)).rejects.toThrow(
      /requires jira-board@\^2\.0\.0.*v1\.4\.2/,
    );
  });

  it('refuses two dependents that cannot agree on a version', async () => {
    await addToRegistry(await makeBundle('jira-board', { version: '1.4.2' }), workspace);
    await addToRegistry(
      await makeBundle('sprint-kit', { dependencies: '  - jira-board@^1.0.0' }),
      workspace,
    );
    await addToRegistry(
      await makeBundle('report-kit', { dependencies: '  - jira-board@^2.0.0' }),
      workspace,
    );
    const top = await makeBundle('team-kit', { dependencies: '  - sprint-kit\n  - report-kit' });

    const failure = await resolveDependencyGraph([await loadBundle(top)], projectDir).catch(
      (error: unknown) => error as HcmError,
    );

    expect(failure).toBeInstanceOf(HcmError);
    expect(failure.message).toMatch(/"jira-board" v1\.4\.2 does not satisfy \^2\.0\.0/);
    // Both sides are named, since neither is more wrong than the other.
    expect(failure.hint).toMatch(/sprint-kit wants \^1\.0\.0, report-kit wants \^2\.0\.0/);
  });

  it('names the loop when bundles require each other', async () => {
    const collection = path.join(workspace, 'kits');
    await makeBundle('a-kit', {
      at: path.join(collection, 'a-kit'),
      dependencies: '  - b-kit',
    });
    await makeBundle('b-kit', {
      at: path.join(collection, 'b-kit'),
      dependencies: '  - a-kit',
    });

    await expect(
      resolveDependencyGraph([await loadBundle(path.join(collection, 'a-kit'))], projectDir),
    ).rejects.toThrow(/Dependency cycle: a-kit -> b-kit -> a-kit/);
  });

  it('says what to do when the dependency is nowhere to be found', async () => {
    const consumer = await makeBundle('sprint-kit', { dependencies: '  - jira-board' });

    await expect(
      resolveDependencyGraph([await loadBundle(consumer)], projectDir),
    ).rejects.toThrow(/requires the bundle "jira-board", which hcm cannot find/);
  });

  it('refuses a manifest that requires itself', async () => {
    const dir = path.join(workspace, 'self-kit');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'hcm.yaml'),
      'name: self-kit\nversion: 1.0.0\ndependencies:\n  - self-kit\n',
    );

    await expect(loadBundle(dir)).rejects.toThrow(/depends on itself/);
  });

  it('refuses a range it cannot honour, at load time', async () => {
    const dir = path.join(workspace, 'vague-kit');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'hcm.yaml'),
      'name: vague-kit\nversion: 1.0.0\ndependencies:\n  - jira-board@latest\n',
    );

    await expect(loadBundle(dir)).rejects.toThrow(/not a version range hcm understands/);
  });
});

describe('installing', () => {
  it('installs the whole tree, dependencies first', async () => {
    await addToRegistry(await makeBundle('jira-board'), workspace);
    await addToRegistry(
      await makeBundle('sprint-kit', { dependencies: '  - jira-board@^1.0.0' }),
      workspace,
    );

    await install('sprint-kit');

    expect(await installedNames()).toEqual(['jira-board', 'sprint-kit']);
    expect(await exists('.claude/agents/jira-board-worker.md')).toBe(true);
    expect(await exists('.claude/agents/sprint-kit-worker.md')).toBe(true);
  });

  it('records what was required, and which bundles were pulled in', async () => {
    await addToRegistry(await makeBundle('jira-board', { version: '1.4.2' }), workspace);
    await addToRegistry(
      await makeBundle('sprint-kit', { dependencies: '  - jira-board@^1.0.0' }),
      workspace,
    );

    await install('sprint-kit');
    const records = await installed();

    expect(records.find((record) => record.bundle === 'sprint-kit')).toMatchObject({
      dependencies: [{ name: 'jira-board', version: '1.4.2', range: '^1.0.0' }],
    });
    expect(records.find((record) => record.bundle === 'sprint-kit')?.auto).toBeUndefined();
    expect(records.find((record) => record.bundle === 'jira-board')?.auto).toBe(true);
  });

  it('shares what the dependency already installed instead of writing it twice', async () => {
    await addToRegistry(await makeBundle('jira-board', { sharedSkill: true }), workspace);
    await addToRegistry(
      await makeBundle('sprint-kit', { dependencies: '  - jira-board', sharedSkill: true }),
      workspace,
    );

    await install('sprint-kit');

    const skill = '.claude/skills/jira-board/SKILL.md';
    expect(await exists(skill)).toBe(true);

    // Both installations claim the one file.
    const records = await installed();
    for (const record of records) {
      expect(record.receipts.some((receipt) => receipt.path === skill)).toBe(true);
    }
  });

  it('installs a dependent named by its registry id, dependency and all', async () => {
    // Ids are what `hcm registry add` prints and what people type; a dependency
    // is still looked up by name, since an id is a handle on this machine only.
    await addToRegistry(await makeBundle('jira-board'), workspace);
    const [entry] = await addToRegistry(
      await makeBundle('sprint-kit', { dependencies: '  - jira-board@^1.0.0' }),
      workspace,
    );

    await install((entry as RegistryEntry).id);

    expect(await installedNames()).toEqual(['jira-board', 'sprint-kit']);
  });

  it('installs a registered dependency whose source folder has since gone', async () => {
    // Registering copies the bundle into the store, and that copy is what an
    // install reads. A dependency that was registered from a folder somebody
    // has since deleted still installs.
    const board = await makeBundle('jira-board', { at: path.join(workspace, 'gone', 'jira-board') });
    await addToRegistry(board, workspace);
    await fs.rm(path.join(workspace, 'gone'), { recursive: true, force: true });

    await addToRegistry(await makeBundle('sprint-kit', { dependencies: '  - jira-board' }), workspace);
    await install('sprint-kit');

    expect(await installedNames()).toEqual(['jira-board', 'sprint-kit']);
    expect(await exists('.claude/agents/jira-board-worker.md')).toBe(true);
  });

  it('takes a --dev dependency from the working copy, edits and all', async () => {
    // A dev entry is the bundle you are writing, read in place. An edit made
    // after registering it has to reach the dependent's install.
    const board = await makeBundle('jira-board');
    await addToRegistry(board, workspace, { dev: true });
    await fs.writeFile(
      path.join(board, 'subagents', 'jira-board-worker.md'),
      '---\ndescription: Works on jira-board\n---\n\nEdited after registering.\n',
    );

    await addToRegistry(await makeBundle('sprint-kit', { dependencies: '  - jira-board' }), workspace);
    await install('sprint-kit');

    const worker = await fs.readFile(
      path.join(projectDir, '.claude', 'agents', 'jira-board-worker.md'),
      'utf8',
    );
    expect(worker).toContain('Edited after registering');
  });

  it('leaves a dependency the user installed first as theirs', async () => {
    // The common order in practice: install the shared kit, then something that
    // needs it. The second install must not quietly demote the first to
    // "automatic", or uninstalling the dependent would take it away.
    await addToRegistry(await makeBundle('jira-board'), workspace);
    await addToRegistry(await makeBundle('sprint-kit', { dependencies: '  - jira-board' }), workspace);

    await install('jira-board');
    await install('sprint-kit');

    expect((await installed()).find((record) => record.bundle === 'jira-board')?.auto).toBeUndefined();

    await uninstall('sprint-kit');
    expect(await installedNames()).toEqual(['jira-board']);
    expect(await exists('.claude/agents/jira-board-worker.md')).toBe(true);
  });

  it('installs a dependency named by a relative source, from any directory', async () => {
    // The install runs in `projectDir`, which is nowhere near either bundle:
    // the path in the manifest is read against the manifest.
    await makeBundle('jira-board', { at: path.join(workspace, 'shared', 'jira-board') });
    const consumer = await makeBundle('sprint-kit', {
      at: path.join(workspace, 'apps', 'sprint-kit'),
      dependencies: '  - name: jira-board\n    source: ../../shared/jira-board',
    });

    await install(consumer);

    expect(await installedNames()).toEqual(['jira-board', 'sprint-kit']);
    expect(await exists('.claude/agents/jira-board-worker.md')).toBe(true);
  });

  it('--no-deps installs only what was named', async () => {
    await addToRegistry(await makeBundle('jira-board'), workspace);
    await addToRegistry(await makeBundle('sprint-kit', { dependencies: '  - jira-board' }), workspace);

    await install('sprint-kit', { noDeps: true });

    expect(await installedNames()).toEqual(['sprint-kit']);
  });

  it('installs a dependency only into the targets it supports', async () => {
    await addToRegistry(
      await makeBundle('jira-board', { manifest: 'targets: [claude-code]' }),
      workspace,
    );
    await addToRegistry(await makeBundle('sprint-kit', { dependencies: '  - jira-board' }), workspace);

    await install('sprint-kit', { targets: ['claude-code', 'copilot'] });

    const records = await installed();
    expect(records.filter((record) => record.bundle === 'jira-board').map((r) => r.target)).toEqual([
      'claude-code',
    ]);
    expect(
      records.filter((record) => record.bundle === 'sprint-kit').map((r) => r.target).sort(),
    ).toEqual(['claude-code', 'copilot']);
  });

  it('sends a dependency only where the bundle needing it went', async () => {
    // Neither declares `targets`, so without propagation the dependency would
    // land in all five harnesses while its dependent went into one.
    await addToRegistry(await makeBundle('jira-board'), workspace);
    await addToRegistry(
      await makeBundle('sprint-kit', {
        dependencies: '  - jira-board',
        manifest: 'targets: [claude-code, copilot]',
      }),
      workspace,
    );

    await installCommand('sprint-kit', { scope: 'project', cwd: projectDir });

    const targets = (records: InstallationRecord[], name: string): string[] =>
      records.filter((record) => record.bundle === name).map((record) => record.target).sort();

    const records = await installed();
    expect(targets(records, 'sprint-kit')).toEqual(['claude-code', 'copilot']);
    expect(targets(records, 'jira-board')).toEqual(['claude-code', 'copilot']);
  });

  it('promotes a dependency to a bundle of its own when installed by name', async () => {
    await addToRegistry(await makeBundle('jira-board'), workspace);
    await addToRegistry(await makeBundle('sprint-kit', { dependencies: '  - jira-board' }), workspace);

    await install('sprint-kit');
    await install('jira-board');

    const board = (await installed()).find((record) => record.bundle === 'jira-board');
    expect(board?.auto).toBeUndefined();

    // ...so removing what pulled it in leaves it behind.
    await uninstall('sprint-kit');
    expect(await installedNames()).toEqual(['jira-board']);
  });
});

describe('uninstalling', () => {
  const setup = async (): Promise<void> => {
    await addToRegistry(await makeBundle('jira-board', { sharedSkill: true }), workspace);
    await addToRegistry(
      await makeBundle('sprint-kit', { dependencies: '  - jira-board', sharedSkill: true }),
      workspace,
    );
    await install('sprint-kit');
  };

  it('takes the automatic dependency away with the bundle that wanted it', async () => {
    await setup();

    await uninstall('sprint-kit');

    expect(await installedNames()).toEqual([]);
    expect(await exists('.claude/skills/jira-board/SKILL.md')).toBe(false);
    expect(await exists('.claude/agents/jira-board-worker.md')).toBe(false);
  });

  it('keeps it with --keep-orphans', async () => {
    await setup();

    await uninstall('sprint-kit', { keepOrphans: true });

    expect(await installedNames()).toEqual(['jira-board']);
    // The shared skill is held for the bundle that is staying.
    expect(await exists('.claude/skills/jira-board/SKILL.md')).toBe(true);
  });

  it('refuses to remove something another bundle still requires', async () => {
    await setup();

    await expect(uninstall('jira-board')).rejects.toBeInstanceOf(HcmError);
    expect(await installedNames()).toEqual(['jira-board', 'sprint-kit']);
  });

  it('--cascade removes the dependents too', async () => {
    await setup();

    await uninstall('jira-board', { cascade: true });

    expect(await installedNames()).toEqual([]);
    expect(await exists('.claude/agents/sprint-kit-worker.md')).toBe(false);
  });

  it('--ignore-dependents removes it and leaves them installed', async () => {
    await setup();

    await uninstall('jira-board', { ignoreDependents: true });

    expect(await installedNames()).toEqual(['sprint-kit']);
    // The skill sprint-kit also shipped is claimed by sprint-kit, so it stays.
    expect(await exists('.claude/skills/jira-board/SKILL.md')).toBe(true);
    // What only jira-board had is gone.
    expect(await exists('.claude/agents/jira-board-worker.md')).toBe(false);
  });

  it('unwinds a chain three deep', async () => {
    await addToRegistry(await makeBundle('jira-board'), workspace);
    await addToRegistry(await makeBundle('sprint-kit', { dependencies: '  - jira-board' }), workspace);
    await addToRegistry(await makeBundle('team-kit', { dependencies: '  - sprint-kit' }), workspace);

    await install('team-kit');
    expect(await installedNames()).toEqual(['jira-board', 'sprint-kit', 'team-kit']);

    await uninstall('team-kit');
    expect(await installedNames()).toEqual([]);
  });

  it('keeps a dependency two bundles need until both are gone', async () => {
    await addToRegistry(await makeBundle('jira-board'), workspace);
    await addToRegistry(await makeBundle('sprint-kit', { dependencies: '  - jira-board' }), workspace);
    await addToRegistry(await makeBundle('report-kit', { dependencies: '  - jira-board' }), workspace);

    await install('sprint-kit');
    await install('report-kit');

    await uninstall('sprint-kit');
    expect(await installedNames()).toEqual(['jira-board', 'report-kit']);

    await uninstall('report-kit');
    expect(await installedNames()).toEqual([]);
  });
});

describe('updating', () => {
  it('installs a dependency a new version has gained', async () => {
    await addToRegistry(await makeBundle('jira-board'), workspace);
    const consumer = await makeBundle('sprint-kit');
    await addToRegistry(consumer, workspace);

    await install('sprint-kit');
    expect(await installedNames()).toEqual(['sprint-kit']);

    // The next version of sprint-kit requires the board bundle.
    await fs.writeFile(
      path.join(consumer, 'hcm.yaml'),
      'name: sprint-kit\nversion: 2.0.0\ndependencies:\n  - jira-board\n',
    );

    await updateCommand('sprint-kit', { cwd: projectDir, targets: ['claude-code'] });

    expect(await installedNames()).toEqual(['jira-board', 'sprint-kit']);
    expect(
      (await installed()).find((record) => record.bundle === 'sprint-kit')?.dependencies,
    ).toEqual([{ name: 'jira-board', version: '1.0.0' }]);
  });

  it('installs a gained dependency that was never registered', async () => {
    // A sibling in the same collection: resolvable, but not by name -- and not
    // beside the store snapshot either, which holds the one bundle. It is found
    // beside the source the snapshot was taken from.
    const collection = path.join(workspace, 'kits');
    await makeBundle('jira-board', { at: path.join(collection, 'jira-board') });
    const consumer = path.join(collection, 'sprint-kit');
    await makeBundle('sprint-kit', { at: consumer });

    await addToRegistry(consumer, workspace);
    await install('sprint-kit');

    await fs.writeFile(
      path.join(consumer, 'hcm.yaml'),
      'name: sprint-kit\nversion: 2.0.0\ndependencies:\n  - jira-board\n',
    );

    await updateCommand('sprint-kit', { cwd: projectDir, targets: ['claude-code'] });

    expect(await installedNames()).toEqual(['jira-board', 'sprint-kit']);
    expect((await installed()).find((record) => record.bundle === 'jira-board')?.auto).toBe(true);
  });

  it('carries on when a dependency has gone missing', async () => {
    const consumer = await makeBundle('sprint-kit');
    await addToRegistry(consumer, workspace);
    await install('sprint-kit');

    await fs.writeFile(
      path.join(consumer, 'hcm.yaml'),
      'name: sprint-kit\nversion: 2.0.0\ndependencies:\n  - nowhere-kit\n',
    );

    await updateCommand('sprint-kit', { cwd: projectDir, targets: ['claude-code'] });

    // Refreshed rather than abandoned, and still installed.
    const record = (await installed()).find((entry) => entry.bundle === 'sprint-kit');
    expect(record?.version).toBe('2.0.0');
  });
});
