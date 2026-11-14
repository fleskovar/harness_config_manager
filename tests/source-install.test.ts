/**
 * Bundles installed into one project from a remote repository, without the
 * registry of the machine:
 *
 *   hcm install review-kit --source <repository> [--ref <ref>] -t copilot
 *   hcm update
 *
 * The repository is a fake Azure DevOps host in memory (`support/git-host.ts`),
 * so the tests need no network. It holds two bundles. Each installed skill
 * says which version and which edition of the files it came from, so the
 * installed `SKILL.md` answers "what did the update read?" by itself.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFromSourceCommand, type SourceInstallOptions } from '../src/commands/install-source.js';
import { updateCommand, type UpdateOptions } from '../src/commands/update.js';
import { configureLogger } from '../src/core/logger.js';
import { readRegistry } from '../src/core/registry.js';
import { readState, writeState } from '../src/core/state.js';
import type { InstallationRecord } from '../src/core/types.js';
import { exists, makeWorkspace, readText } from './support/fixtures.js';
import { FakeGitHost } from './support/git-host.js';

const AZURE = 'https://dev.azure.com/acme/platform/_git/agent-kits';
const SKILL = '.github/skills/review/SKILL.md';

let workspace: string;
let projectDir: string;
let previousHome: string | undefined;
let host: FakeGitHost;

/** The files of one bundle in the repository. `edition` changes the files, not the version. */
const kit = (name: string, version: string, edition = 1): Record<string, string> => ({
  [`bundles/${name}/hcm.yaml`]: `name: ${name}\nversion: ${version}\n`,
  [`bundles/${name}/skills/${name === 'review-kit' ? 'review' : name}/SKILL.md`]:
    `---\ndescription: Use ${name}\n---\n\nThis is ${name} ${version}, edition ${edition}.\n`,
});

const install = (names: string[], extra: Partial<SourceInstallOptions> = {}) =>
  installFromSourceCommand(names, {
    source: AZURE,
    scope: 'project',
    cwd: projectDir,
    targets: ['copilot'],
    prompt: false,
    ...extra,
  });

const update = (extra: Partial<UpdateOptions> = {}, bundles?: string[]) =>
  updateCommand(bundles, { cwd: projectDir, prompt: false, ...extra });

/** "1.0.0, edition 1": what the installed review skill says it is. */
async function installedSkill(): Promise<string | undefined> {
  const text = await readText(projectDir, SKILL);
  return /This is review-kit (\S+, edition \d+)\./.exec(text)?.[1];
}

async function record(bundle = 'review-kit'): Promise<InstallationRecord> {
  const found = (await readState('project', projectDir)).installations.find(
    (candidate) => candidate.bundle === bundle,
  );
  if (!found) throw new Error(`${bundle} is not installed`);
  return found;
}

/** Run something that logs, and hand back everything it printed, without colors. */
async function capture(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const keep = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(keep),
    vi.spyOn(console, 'error').mockImplementation(keep),
    vi.spyOn(console, 'warn').mockImplementation(keep),
  ];
  configureLogger({});
  try {
    await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
    configureLogger({ quiet: true });
  }
  // eslint-disable-next-line no-control-regex
  return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

beforeEach(async () => {
  workspace = await makeWorkspace('source-install');
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });

  previousHome = process.env.HCM_HOME;
  process.env.HCM_HOME = path.join(workspace, 'home');
  configureLogger({ quiet: true });

  host = new FakeGitHost();
  vi.stubGlobal('fetch', host.fetch);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (previousHome === undefined) delete process.env.HCM_HOME;
  else process.env.HCM_HOME = previousHome;
  process.exitCode = undefined;
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('hcm install <bundle> --source <repository>', () => {
  it('installs only the named bundle, follows its source, and registers nothing', async () => {
    host.commit(AZURE, { ...kit('review-kit', '1.0.0'), ...kit('db-kit', '1.0.0') });

    await install(['review-kit']);

    expect(await installedSkill()).toBe('1.0.0, edition 1');
    expect(await exists(projectDir, '.github/skills/db-kit/SKILL.md')).toBe(false);

    const installed = await record();
    expect(installed.track).toBe('source');
    expect(installed.source).toEqual({ type: 'git', url: AZURE, ref: 'HEAD', subdir: 'bundles/review-kit' });
    expect(installed.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await readRegistry()).entries).toEqual([]);
  });

  it('reads the ref that --ref names, and keeps it on update', async () => {
    const first = host.commit(AZURE, kit('review-kit', '1.0.0'));
    host.tag(AZURE, 'v1.0.0', first);
    host.commit(AZURE, kit('review-kit', '2.0.0'));

    await install(['review-kit'], { ref: 'v1.0.0' });
    expect(await installedSkill()).toBe('1.0.0, edition 1');
    expect((await record()).source).toMatchObject({ ref: 'v1.0.0' });

    await update();
    expect(await installedSkill()).toBe('1.0.0, edition 1');
  });

  it('with no bundle name, installs each bundle of the source', async () => {
    host.commit(AZURE, { ...kit('review-kit', '1.0.0'), ...kit('db-kit', '1.0.0') });

    await install([]);

    expect((await record('review-kit')).track).toBe('source');
    expect((await record('db-kit')).track).toBe('source');
  });

  it('reports each wrong name, and installs nothing', async () => {
    host.commit(AZURE, { ...kit('review-kit', '1.0.0'), ...kit('db-kit', '1.0.0') });

    const failure = install(['review-kit', 'nope', 'Not A Name']);

    await expect(failure).rejects.toThrow(/There is no bundle "nope"/);
    await expect(failure).rejects.toThrow(/"Not A Name" is not a bundle name/);
    expect((await readState('project', projectDir)).installations).toEqual([]);
  });

  it('refuses two different refs', async () => {
    await expect(install(['review-kit'], { source: `${AZURE}#v1:bundles`, ref: 'v2' })).rejects.toThrow(
      /names the ref "v1", and --ref names "v2"/,
    );
  });

  it('refuses --ref for a folder', async () => {
    await expect(install(['review-kit'], { source: './kits', ref: 'v2' })).rejects.toThrow(
      /--ref needs a repository/,
    );
  });
});

// ---------------------------------------------------------------------------

describe('hcm update of a bundle installed from a remote source', () => {
  beforeEach(async () => {
    host.commit(AZURE, kit('review-kit', '1.0.0'));
    await install(['review-kit']);
  });

  it('installs the new version when the repository has one', async () => {
    host.commit(AZURE, kit('review-kit', '1.1.0'));

    const printed = await capture(() => update());

    expect(printed).toMatch(/review-kit v1\.0\.0 → v1\.1\.0 \[source\]/);
    expect(await installedSkill()).toBe('1.1.0, edition 1');
    expect((await record()).version).toBe('1.1.0');
  });

  it('leaves an installation alone when the repository has the same version and files', async () => {
    // A deleted file proves that nothing was rolled back and installed again.
    await fs.rm(path.join(projectDir, SKILL));
    const before = await record();

    const printed = await capture(() => update());

    expect(printed).toContain('review-kit v1.0.0 (up to date) [source]');
    expect(printed).toContain('up to date in copilot (project); nothing to do');
    expect(await exists(projectDir, SKILL)).toBe(false);
    expect(await record()).toEqual(before);
  });

  it('installs it again with --reinstall', async () => {
    await fs.rm(path.join(projectDir, SKILL));

    await update({ reinstall: true });

    expect(await installedSkill()).toBe('1.0.0, edition 1');
  });

  it('installs new files that kept the old version', async () => {
    host.commit(AZURE, kit('review-kit', '1.0.0', 2));

    const printed = await capture(() => update());

    expect(printed).toContain('the files changed, but the version is still v1.0.0');
    expect(await installedSkill()).toBe('1.0.0, edition 2');
  });

  it('installs again one time when the record has no digest', async () => {
    // A record written by an hcm from before digests existed.
    const state = await readState('project', projectDir);
    for (const installation of state.installations) delete installation.digest;
    await writeState('project', projectDir, state);
    await fs.rm(path.join(projectDir, SKILL));

    await update();
    expect(await installedSkill()).toBe('1.0.0, edition 1');
    expect((await record()).digest).toMatch(/^sha256:/);

    // Now the record has a digest, so the next update is a no-op.
    await fs.rm(path.join(projectDir, SKILL));
    await update();
    expect(await exists(projectDir, SKILL)).toBe(false);
  });

  it('installs again when the run changes a setting, also with the same bundle', async () => {
    await fs.rm(path.join(projectDir, SKILL));

    await update({ flavors: ['all'] });

    expect(await installedSkill()).toBe('1.0.0, edition 1');
  });
});

// ---------------------------------------------------------------------------

describe('hcm update <bundle> --ref <ref>', () => {
  it('moves to a new tag with --ref, and takes away what the new version dropped', async () => {
    const files = (version: string, extra: Record<string, string> = {}) => ({
      ...kit('review-kit', version),
      ...extra,
    });
    const dropped = { 'bundles/review-kit/skills/old/SKILL.md': '---\ndescription: Old\n---\n\nOld.\n' };
    host.tag(AZURE, 'v1.0.0', host.commit(AZURE, files('1.0.0', dropped)));
    host.tag(AZURE, 'v2.0.0', host.commit(AZURE, files('2.0.0')));

    await install(['review-kit'], { ref: 'v1.0.0' });
    expect(await exists(projectDir, '.github/skills/old/SKILL.md')).toBe(true);

    await update({ ref: 'v2.0.0' }, ['review-kit']);

    expect(await installedSkill()).toBe('2.0.0, edition 1');
    expect(await exists(projectDir, '.github/skills/old/SKILL.md')).toBe(false);
    expect((await record()).source).toEqual({
      type: 'git',
      url: AZURE,
      ref: 'v2.0.0',
      subdir: 'bundles/review-kit',
    });
    expect((await record()).track).toBe('source');
  });

  it('refuses --ref with no bundle name', async () => {
    await expect(update({ ref: 'v2.0.0' })).rejects.toThrow(/--ref needs the name of a bundle/);
  });
});
