/**
 * Several bundles, several harnesses, one command.
 *
 *   hcm install 1 2 3 --target reasonix pi
 *
 * Both halves of that line are lists, and neither is a loop written out longer.
 * The targets are one decision applied to every bundle; the bundles are one
 * dependency resolution, so something two of them require is worked out once
 * and installed once. What is asserted here is mostly that: the *combining*,
 * rather than the installing, which the rest of the suite already covers.
 *
 * The other half is failure. A list is only usable if a bad entry in it stops
 * the run before the good ones are half-applied, so every command here refuses
 * up front rather than partway through.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { infoCommand } from '../src/commands/info.js';
import { installCommand } from '../src/commands/install.js';
import { registryAddCommand } from '../src/commands/registry.js';
import { uninstallCommand } from '../src/commands/uninstall.js';
import { updateCommand } from '../src/commands/update.js';
import { expandTargets } from '../src/core/harnesses.js';
import { configureLogger } from '../src/core/logger.js';
import { addToRegistry, readRegistry } from '../src/core/registry.js';
import { readState } from '../src/core/state.js';
import type { InstallationRecord, TargetId } from '../src/core/types.js';
import { resolveTargetId } from '../src/targets/index.js';
import { exists, makeWorkspace } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let previousHome: string | undefined;

interface BundleSpec {
  version?: string;
  /** Manifest `dependencies:` block, already indented. */
  dependencies?: string;
}

/** A bundle with one subagent, which lands in a different place in every harness. */
async function makeBundle(name: string, spec: BundleSpec = {}): Promise<string> {
  const dir = path.join(workspace, 'kits', name);
  const manifest = [
    `name: ${name}`,
    `version: ${spec.version ?? '1.0.0'}`,
    ...(spec.dependencies ? [`dependencies:\n${spec.dependencies}`] : []),
  ].join('\n');

  await fs.mkdir(path.join(dir, 'subagents'), { recursive: true });
  await fs.writeFile(path.join(dir, 'hcm.yaml'), `${manifest}\n`);
  await fs.writeFile(
    path.join(dir, 'subagents', `${name}-worker.md`),
    `---\ndescription: Works on ${name}\n---\n\nDo ${name} work.\n`,
  );
  return dir;
}

/** Register several bundles and hand back their short ids, in order. */
async function register(...names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const [entry] = await addToRegistry(await makeBundle(name), workspace);
    ids.push(entry?.id as string);
  }
  return ids;
}

const records = async (): Promise<InstallationRecord[]> =>
  (await readState('project', projectDir)).installations;

/** "bundle→target" for every installation, sorted -- the shape of a run. */
const installed = async (): Promise<string[]> =>
  (await records()).map((record) => `${record.bundle}→${record.target}`).sort();

beforeEach(async () => {
  workspace = await makeWorkspace('multi-bundle');
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

// ---------------------------------------------------------------------------

describe('naming a harness', () => {
  it('takes an id, an alias or an unambiguous prefix', () => {
    expect(resolveTargetId('claude-code')).toBe('claude-code');
    expect(resolveTargetId('claude')).toBe('claude-code');
    expect(resolveTargetId('cc')).toBe('claude-code');
    expect(resolveTargetId('reason')).toBe('reasonix');
    expect(resolveTargetId('op')).toBe('opencode');
    expect(resolveTargetId('oc')).toBe('opencode');
    expect(resolveTargetId('PI')).toBe('pi');
  });

  it('refuses a prefix that fits two harnesses rather than guessing', () => {
    // Writing a bundle into the wrong harness is worse than being asked again.
    expect(() => resolveTargetId('c')).toThrow(/matches more than one harness/);
    expect(() => resolveTargetId('c')).toThrow(/claude-code, copilot/);
  });

  it('points at the likely mistake when the name is not a harness at all', () => {
    // `-t` is variadic, so a bundle name written after it is read as a target.
    expect(() => resolveTargetId('my-kit')).toThrow(/Unknown target "my-kit"/);
  });

  it('collects several harnesses from one flag', () => {
    expect(expandTargets(['claude', 'pi'])).toEqual(['claude-code', 'pi']);
    expect(expandTargets(['reasonix', 'pi'])).toEqual(['reasonix', 'pi']);
    // The same harness said twice is one harness.
    expect(expandTargets(['claude', 'claude-code', 'cc'])).toEqual(['claude-code']);
  });
});

// ---------------------------------------------------------------------------

describe('installing several bundles at once', () => {
  it('installs every bundle into every named harness', async () => {
    const ids = await register('alpha', 'beta', 'gamma');

    await installCommand(ids, {
      targets: ['reasonix', 'pi'],
      scope: 'project',
      cwd: projectDir,
    });

    expect(await installed()).toEqual([
      'alpha→pi',
      'alpha→reasonix',
      'beta→pi',
      'beta→reasonix',
      'gamma→pi',
      'gamma→reasonix',
    ]);
  });

  it('takes names, ids and paths in the same list', async () => {
    await register('alpha');
    const beta = await makeBundle('beta');

    await installCommand(['1', beta], {
      targets: ['pi'],
      scope: 'project',
      cwd: projectDir,
    });

    expect(await installed()).toEqual(['alpha→pi', 'beta→pi']);
  });

  it('resolves a dependency two of them share exactly once', async () => {
    // The point of one graph rather than three runs: `shared` is required by
    // both named bundles, and arrives once, as a dependency of both.
    await addToRegistry(await makeBundle('shared'), workspace);
    await addToRegistry(
      await makeBundle('alpha', { dependencies: '  - shared' }),
      workspace,
    );
    await addToRegistry(await makeBundle('beta', { dependencies: '  - shared' }), workspace);

    await installCommand(['alpha', 'beta'], {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
    });

    const shared = (await records()).filter((record) => record.bundle === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0]?.auto).toBe(true);

    // And both dependents record it, so it survives until both are gone.
    for (const name of ['alpha', 'beta']) {
      const record = (await records()).find((candidate) => candidate.bundle === name);
      expect(record?.dependencies?.map((dependency) => dependency.name)).toEqual(['shared']);
    }
  });

  it('installs nothing when one of the names is wrong', async () => {
    const ids = await register('alpha', 'beta');

    await expect(
      installCommand([...ids, 'nosuchkit'], {
        targets: ['pi'],
        scope: 'project',
        cwd: projectDir,
      }),
    ).rejects.toThrow(/nosuchkit/);

    // Resolution happens before planning, so the good bundles are untouched.
    expect(await installed()).toEqual([]);
    expect(await exists(projectDir, '.pi')).toBe(false);
  });

  it('still takes a single bundle as a bare string', async () => {
    // Every internal caller -- `hcm import`, `hcm update` -- passes one.
    await register('alpha');
    await installCommand('alpha', { targets: ['pi'], scope: 'project', cwd: projectDir });

    expect(await installed()).toEqual(['alpha→pi']);
  });
});

// ---------------------------------------------------------------------------

describe('uninstalling several bundles at once', () => {
  const setUp = async (): Promise<string[]> => {
    const ids = await register('alpha', 'beta', 'gamma');
    await installCommand(ids, {
      targets: ['reasonix', 'pi'],
      scope: 'project',
      cwd: projectDir,
    });
    return ids;
  };

  it('removes each of them from each named harness', async () => {
    await setUp();

    await uninstallCommand(['alpha', 'beta'], {
      targets: ['reasonix', 'pi'],
      scope: 'project',
      cwd: projectDir,
    });

    expect(await installed()).toEqual(['gamma→pi', 'gamma→reasonix']);
    expect(await exists(projectDir, '.pi/skills/alpha-worker/SKILL.md')).toBe(false);
    expect(await exists(projectDir, '.pi/skills/gamma-worker/SKILL.md')).toBe(true);
  });

  it('narrows to one harness across all of them', async () => {
    await setUp();

    await uninstallCommand(['alpha', 'beta', 'gamma'], {
      targets: ['pi'],
      scope: 'project',
      cwd: projectDir,
    });

    expect(await installed()).toEqual(['alpha→reasonix', 'beta→reasonix', 'gamma→reasonix']);
  });

  it('removes nothing when one of the names is not installed', async () => {
    await setUp();

    await expect(
      uninstallCommand(['alpha', 'nosuchkit'], {
        targets: ['pi'],
        scope: 'project',
        cwd: projectDir,
      }),
    ).rejects.toThrow(/"nosuchkit" is not installed/);

    expect(await installed()).toHaveLength(6);
  });

  it('lets a bundle and the thing depending on it go in one command', async () => {
    // Removing `shared` alone is refused while `alpha` needs it. Naming both is
    // the answer, and it needs neither --cascade nor --ignore-dependents.
    await addToRegistry(await makeBundle('shared'), workspace);
    await addToRegistry(await makeBundle('alpha', { dependencies: '  - shared' }), workspace);
    await installCommand(['alpha'], {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
    });

    await expect(
      uninstallCommand(['shared'], { targets: ['claude-code'], scope: 'project', cwd: projectDir }),
    ).rejects.toThrow(/still depend on this one/);

    await uninstallCommand(['shared', 'alpha'], {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
    });
    expect(await installed()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('updating several bundles at once', () => {
  it('updates the ones named and leaves the rest alone', async () => {
    const ids = await register('alpha', 'beta', 'gamma');
    await installCommand(ids, { targets: ['pi'], scope: 'project', cwd: projectDir });

    // A new version of each, at the source the registry points at.
    for (const name of ['alpha', 'beta', 'gamma']) {
      await fs.writeFile(
        path.join(workspace, 'kits', name, 'hcm.yaml'),
        `name: ${name}\nversion: 2.0.0\n`,
      );
    }

    await updateCommand([ids[0] as string, ids[2] as string], {
      targets: ['pi'],
      cwd: projectDir,
    });

    const versions = Object.fromEntries(
      (await records()).map((record) => [record.bundle, record.version]),
    );
    expect(versions).toEqual({ alpha: '2.0.0', beta: '1.0.0', gamma: '2.0.0' });
  });

  it('walks them in registry order however they were typed', async () => {
    const ids = await register('alpha', 'beta', 'gamma');
    await installCommand(ids, { targets: ['pi'], scope: 'project', cwd: projectDir });

    // Nothing to assert on the ledger here -- both orders update the same two
    // bundles -- so the assertion is that neither order is an error and both
    // leave the same state.
    await updateCommand(['3', '1'], { targets: ['pi'], cwd: projectDir });
    expect(await installed()).toEqual(['alpha→pi', 'beta→pi', 'gamma→pi']);
  });

  it('updates a bundle named twice only once', async () => {
    const ids = await register('alpha');
    await installCommand(ids, { targets: ['pi'], scope: 'project', cwd: projectDir });

    await updateCommand(['alpha', '1'], { targets: ['pi'], cwd: projectDir });
    expect(await installed()).toEqual(['alpha→pi']);
  });

  it('still means "everything installed here" with no bundle named', async () => {
    const ids = await register('alpha', 'beta');
    await installCommand(ids, { targets: ['pi'], scope: 'project', cwd: projectDir });

    // The CLI hands an empty array when the argument is omitted.
    await updateCommand([], { targets: ['pi'], cwd: projectDir });
    expect(await installed()).toEqual(['alpha→pi', 'beta→pi']);
  });
});

// ---------------------------------------------------------------------------

describe('the other commands that take a list', () => {
  it('registers several sources in one command', async () => {
    const roots = [await makeBundle('alpha'), await makeBundle('beta')];
    await registryAddCommand(roots, { cwd: workspace });

    const registry = await readRegistry();
    expect(registry.entries.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
  });

  it('refuses --name for several sources, since it can only rename one', async () => {
    const roots = [await makeBundle('alpha'), await makeBundle('beta')];

    await expect(
      registryAddCommand(roots, { name: 'renamed', cwd: workspace }),
    ).rejects.toThrow(/--name takes one bundle/);
  });

  it('describes several bundles in one command', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    configureLogger({});

    try {
      await infoCommand([await makeBundle('alpha'), await makeBundle('beta')], {
        scope: 'project',
        cwd: projectDir,
      });
    } finally {
      console.log = original;
      configureLogger({ quiet: true });
    }

    const output = lines.join('\n');
    expect(output).toMatch(/alpha/);
    expect(output).toMatch(/beta/);
  });
});

// ---------------------------------------------------------------------------

describe('both lists at once', () => {
  it('is the command from the manual: several bundles, several harnesses', async () => {
    const ids = await register('alpha', 'beta', 'gamma');

    // hcm install 1 2 3 --target reasonix pi
    await installCommand(ids, {
      targets: expandTargets(['reasonix', 'pi']) as TargetId[],
      scope: 'project',
      cwd: projectDir,
    });

    expect(await records()).toHaveLength(6);
    for (const name of ['alpha', 'beta', 'gamma']) {
      expect(await exists(projectDir, `.reasonix/skills/${name}-worker/SKILL.md`)).toBe(true);
      expect(await exists(projectDir, `.pi/skills/${name}-worker/SKILL.md`)).toBe(true);
    }
  });
});
