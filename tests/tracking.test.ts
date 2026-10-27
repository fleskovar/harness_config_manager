/**
 * Where `hcm update` reads the next version: the registry, or the source.
 *
 * Two kinds of software ship a bundle, and these tests hold one story for each:
 *
 *   - A CLI tool installed once per machine. Its bundle is registered, and a
 *     project follows the registry. `hcm update --no-registry` reads the
 *     source of the tool directly, and leaves the registry alone.
 *   - A Python library installed into the `.venv/` of each project. Two
 *     projects can pin two versions, so each installation follows its own
 *     source (`--track source`), and the registry is not read. The machine can
 *     have the same library registered in another version: that must not
 *     leak into the project.
 *
 * The bundle has one skill, and the skill says which version it is. So the
 * installed `SKILL.md` answers "which copy did the update read?" by itself.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand, type InstallOptions } from '../src/commands/install.js';
import { listCommand } from '../src/commands/list.js';
import { updateCommand } from '../src/commands/update.js';
import { configureLogger } from '../src/core/logger.js';
import { addToRegistry, readRegistry } from '../src/core/registry.js';
import { readState } from '../src/core/state.js';
import {
  effectiveTrack,
  recordedSource,
  sameOrigin,
  sourceInProject,
} from '../src/core/tracking.js';
import type { InstallationRecord } from '../src/core/types.js';
import { makeWorkspace, readText } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
/** The copy that ships with the global install of the tool. */
let globalCopy: string;
/** The copy inside the virtual environment of the project. */
let venvCopy: string;
let previousHome: string | undefined;
let previousExitCode: typeof process.exitCode;

const SKILL_PATH = '.claude/skills/my-lib/SKILL.md';
const VENV_BUNDLE = '.venv/lib/site-packages/my_lib/hcm_bundle';

/** Write (or overwrite) the bundle `my-lib` at `dir`, in `version`. */
async function writeBundle(dir: string, version: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'skills', 'my-lib'), { recursive: true });
  await fs.writeFile(path.join(dir, 'hcm.yaml'), `name: my-lib\nversion: ${version}\n`);
  await fs.writeFile(
    path.join(dir, 'skills', 'my-lib', 'SKILL.md'),
    `---\ndescription: Use my-lib\n---\n\nThis is my-lib ${version}.\n`,
  );
}

/** The version that the installed skill says it is. */
async function installedVersion(project = projectDir): Promise<string | undefined> {
  const text = await readText(project, SKILL_PATH);
  return /This is my-lib (\S+)\./.exec(text)?.[1];
}

async function record(project = projectDir): Promise<InstallationRecord> {
  const state = await readState('project', project);
  const found = state.installations.find((candidate) => candidate.bundle === 'my-lib');
  if (!found) throw new Error('my-lib is not installed');
  return found;
}

async function registeredVersion(): Promise<string | undefined> {
  return (await readRegistry()).entries.find((entry) => entry.name === 'my-lib')?.version;
}

const install = (references: string[], extra: Partial<InstallOptions> = {}) =>
  installCommand(references, {
    scope: 'project',
    cwd: projectDir,
    targets: ['claude-code'],
    prompt: false,
    ...extra,
  });

const update = (references?: string[], extra: Partial<Parameters<typeof updateCommand>[1]> = {}) =>
  updateCommand(references, { cwd: projectDir, prompt: false, ...extra });

/** Run something that logs, and hand back everything it printed. */
async function capture(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const keep = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  console.log = keep;
  console.error = keep;
  console.warn = keep;
  configureLogger({});

  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    configureLogger({ quiet: true });
  }

  // Colours off: the assertions read the words.
  // eslint-disable-next-line no-control-regex
  return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

beforeEach(async () => {
  workspace = await makeWorkspace('tracking');
  projectDir = path.join(workspace, 'project');
  globalCopy = path.join(workspace, 'global', 'my-lib', 'hcm_bundle');
  venvCopy = path.join(projectDir, ...VENV_BUNDLE.split('/'));
  await fs.mkdir(projectDir, { recursive: true });

  previousHome = process.env.HCM_HOME;
  process.env.HCM_HOME = path.join(workspace, 'home');
  previousExitCode = process.exitCode;
  configureLogger({ quiet: true });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HCM_HOME;
  else process.env.HCM_HOME = previousHome;
  process.exitCode = previousExitCode;
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('a library pinned to the virtual environment of the project', () => {
  beforeEach(async () => {
    // The machine has my-lib 1.0.0 registered, from a global install.
    await writeBundle(globalCopy, '1.0.0');
    await addToRegistry(globalCopy, workspace);
    // The project has my-lib 2.0.0 in its .venv.
    await writeBundle(venvCopy, '2.0.0');
  });

  it('installs from the venv and records the source mode, relative to the project', async () => {
    await install([venvCopy], { track: 'source' });

    expect(await installedVersion()).toBe('2.0.0');
    const installed = await record();
    expect(installed.track).toBe('source');
    expect(installed.sourceInProject).toBe(VENV_BUNDLE);
  });

  it('updates from the venv after an upgrade, and leaves the registry alone', async () => {
    await install([venvCopy], { track: 'source' });
    await writeBundle(venvCopy, '2.1.0'); // pip install -U my-lib

    await update();

    expect(await installedVersion()).toBe('2.1.0');
    expect(await registeredVersion()).toBe('1.0.0');
  });

  it('is not replaced by the registered version when the update names it', async () => {
    await install([venvCopy], { track: 'source' });
    await writeBundle(globalCopy, '1.5.0');

    await update(['my-lib']);

    expect(await installedVersion()).toBe('2.0.0');
    // The registry was not read again either: it still has the old copy.
    expect(await registeredVersion()).toBe('1.0.0');
  });

  it('warns that the registry has a different version', async () => {
    await install([venvCopy], { track: 'source' });

    const printed = await capture(() => update());

    expect(printed).toContain('the registry has my-lib v1.0.0');
    expect(printed).toContain('but the source has v2.0.0');
  });

  it('keeps the source mode through a plain reinstall', async () => {
    await install([venvCopy], { track: 'source' });
    await install([venvCopy]);

    expect((await record()).track).toBe('source');
  });

  it('reads the venv of another checkout, found by its relative path', async () => {
    await install([venvCopy], { track: 'source' });

    // A teammate's checkout: the same project at another place, with its own
    // .venv. The absolute path in the record points at nothing there.
    const checkout = path.join(workspace, 'teammate', 'project');
    await fs.mkdir(path.dirname(checkout), { recursive: true });
    await fs.rename(projectDir, checkout);
    projectDir = checkout;
    await writeBundle(path.join(checkout, ...VENV_BUNDLE.split('/')), '2.2.0');

    await update();

    expect(await installedVersion()).toBe('2.2.0');
  });

  it('without --track, follows the registry and says so at install', async () => {
    const printed = await capture(() => install([venvCopy]));

    expect(printed).toContain('my-lib is also registered');
    expect(printed).toContain('--track source');

    await update();
    expect(await installedVersion()).toBe('1.0.0');
  });

  it('moves to a new environment with --from, and follows it from then on', async () => {
    await install([globalCopy]); // follows the registry
    const other = path.join(workspace, 'other-env', 'hcm_bundle');
    await writeBundle(other, '3.0.0');

    await update(['my-lib'], { from: other });

    expect(await installedVersion()).toBe('3.0.0');
    expect((await record()).track).toBe('source');

    await writeBundle(other, '3.0.1');
    await update();
    expect(await installedVersion()).toBe('3.0.1');
  });

  it('goes back to the registry with --track registry', async () => {
    await install([venvCopy], { track: 'source' });

    await update(['my-lib'], { track: 'registry' });

    expect(await installedVersion()).toBe('1.0.0');
    expect((await record()).track).toBe('registry');
  });

  it('reports a venv that is gone, and does not stop the run', async () => {
    await install([venvCopy], { track: 'source' });
    await fs.rm(path.join(projectDir, '.venv'), { recursive: true, force: true });

    const printed = await capture(() => update());

    expect(printed).toContain('no longer exists');
    expect(printed).toContain('--from');
    expect(process.exitCode).toBe(1);
    // Nothing was rolled back: the old version is still installed.
    expect(await installedVersion()).toBe('2.0.0');
  });
});

describe('a CLI tool that follows the registry', () => {
  beforeEach(async () => {
    await writeBundle(globalCopy, '1.0.0');
    await addToRegistry(globalCopy, workspace);
    await install(['my-lib']);
  });

  it('records no mode: it follows the registry because it is registered', async () => {
    const installed = await record();
    expect(installed.track).toBeUndefined();
    expect(effectiveTrack(installed, true)).toBe('registry');
  });

  it('updates through the registry by default', async () => {
    await writeBundle(globalCopy, '1.1.0'); // npm update -g my-cli

    await update();

    expect(await installedVersion()).toBe('1.1.0');
    expect(await registeredVersion()).toBe('1.1.0');
  });

  it('with --no-registry, reads the source and leaves the registry alone', async () => {
    await writeBundle(globalCopy, '1.1.0');

    const printed = await capture(() => update(undefined, { registry: false }));

    expect(await installedVersion()).toBe('1.1.0');
    expect(await registeredVersion()).toBe('1.0.0');
    expect(printed).toContain('the registry has my-lib v1.0.0');
    // A one-off: the installation still follows the registry.
    expect((await record()).track).toBeUndefined();
  });

  it('with --track source, starts to follow the source', async () => {
    await update(['my-lib'], { track: 'source' });
    expect((await record()).track).toBe('source');

    await writeBundle(globalCopy, '1.2.0');
    await update();

    expect(await installedVersion()).toBe('1.2.0');
    expect(await registeredVersion()).toBe('1.0.0');
  });

  it('installs by name with --track source from the origin, not the store', async () => {
    // The tool was upgraded, but "hcm registry update" did not run yet.
    await writeBundle(globalCopy, '1.3.0');

    await install(['my-lib'], { track: 'source' });

    expect(await installedVersion()).toBe('1.3.0');
    expect(await registeredVersion()).toBe('1.0.0');
  });
});

describe('a bundle installed from a path that nobody registered', () => {
  it('updates from that path', async () => {
    const kit = path.join(workspace, 'kits', 'my-lib');
    await writeBundle(kit, '1.0.0');
    await install([kit]);

    await writeBundle(kit, '1.0.1');
    await update();

    expect(await installedVersion()).toBe('1.0.1');
    expect((await record()).track).toBeUndefined();
  });
});

describe('refused combinations', () => {
  it('--track registry needs a registered bundle', async () => {
    await writeBundle(venvCopy, '2.0.0');
    await expect(install([venvCopy], { track: 'registry' })).rejects.toThrow(/not a registered bundle/);
  });

  it('--from and --track registry contradict each other', async () => {
    await expect(update(['my-lib'], { from: venvCopy, track: 'registry' })).rejects.toThrow(
      /contradict/,
    );
  });

  it('--no-registry and --track registry contradict each other', async () => {
    await expect(update(undefined, { registry: false, track: 'registry' })).rejects.toThrow(
      /contradict/,
    );
  });

  it('--from names a bundle that is installed here', async () => {
    await writeBundle(venvCopy, '2.0.0');
    await expect(update(undefined, { from: venvCopy })).rejects.toThrow(/not installed here/);
  });

  it('--from refuses a source that holds another bundle', async () => {
    await writeBundle(venvCopy, '2.0.0');
    await install([venvCopy], { track: 'source' });
    const other = path.join(workspace, 'other');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, 'hcm.yaml'), 'name: other\nversion: 1.0.0\n');

    await expect(update(['my-lib'], { from: other })).rejects.toThrow(/holds the bundle "other"/);
  });
});

describe('hcm list --installed', () => {
  it('marks a pinned installation and the version gap with the registry', async () => {
    await writeBundle(globalCopy, '1.0.0');
    await addToRegistry(globalCopy, workspace);
    await writeBundle(venvCopy, '2.0.0');
    await install([venvCopy], { track: 'source' });

    const printed = await capture(() => listCommand({ installed: true, cwd: projectDir }));

    expect(printed).toContain('[source]');
    expect(printed).toContain(`follows ${VENV_BUNDLE}`);
    expect(printed).toContain('the registry has v1.0.0');
  });
});

// ---------------------------------------------------------------------------

describe('core/tracking', () => {
  const cwd = path.resolve('/work/project');

  it('keeps a local source inside the project as a relative path', () => {
    expect(sourceInProject({ type: 'local', path: path.join(cwd, '.venv', 'b') }, 'project', cwd)).toBe(
      '.venv/b',
    );
  });

  it('keeps nothing for a source outside the project, at user scope, or remote', () => {
    expect(sourceInProject({ type: 'local', path: path.resolve('/work/other') }, 'project', cwd)).toBeUndefined();
    expect(sourceInProject({ type: 'local', path: path.join(cwd, 'b') }, 'user', cwd)).toBeUndefined();
    expect(sourceInProject({ type: 'local', path: cwd }, 'project', cwd)).toBeUndefined();
    expect(
      sourceInProject({ type: 'github', owner: 'o', repo: 'r', ref: 'main' }, 'project', cwd),
    ).toBeUndefined();
  });

  it('reads the relative path first', () => {
    const recorded = {
      scope: 'project',
      source: { type: 'local', path: path.resolve('/elsewhere/b') },
      sourceInProject: '.venv/b',
    } as InstallationRecord;
    expect(recordedSource(recorded, cwd)).toEqual({ type: 'local', path: path.join(cwd, '.venv', 'b') });
  });

  it('infers the mode from the registration when none was recorded', () => {
    expect(effectiveTrack({}, true)).toBe('registry');
    expect(effectiveTrack({}, false)).toBe('source');
    expect(effectiveTrack({ track: 'source' }, true)).toBe('source');
  });

  it('compares origins without the ref', () => {
    const at = (ref: string) => ({ type: 'github' as const, owner: 'O', repo: 'r', ref, subdir: 'b' });
    expect(sameOrigin(at('v1'), { ...at('v2'), owner: 'o' })).toBe(true);
    expect(sameOrigin(at('v1'), { ...at('v1'), subdir: 'c' })).toBe(false);
  });
});
