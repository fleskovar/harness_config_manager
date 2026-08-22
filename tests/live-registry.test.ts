/**
 * What a listing says about a bundle you are still writing.
 *
 * `hcm registry add <path> --dev` does not copy the bundle. It records a
 * pointer at your working copy, and every install reads that directory again
 * -- which is the whole reason to register one that way while you are editing
 * it.
 *
 * The listings did not honour that. They printed the `version`, `flavors` and
 * `parameters` fields copied onto the registry entry on the day it was added,
 * so a bundle whose manifest had grown from one flavor to five went on being
 * advertised as having one, and `hcm list` disagreed with the file the user was
 * looking at. That is the bug these tests hold shut.
 *
 * The other half matters just as much: a *snapshotted* entry must keep saying
 * what the snapshot says. It points at a copy in the store, not at the source,
 * and `hcm update` is what moves it. Reading the origin on every listing would
 * make `hcm list` lie in the opposite direction -- describing a bundle that is
 * not the one an install would write.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listCommand } from '../src/commands/list.js';
import { registryListCommand } from '../src/commands/registry.js';
import { configureLogger } from '../src/core/logger.js';
import { addToRegistry, liveEntry, readRegistry } from '../src/core/registry.js';
import { makeWorkspace } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let kit: string;
let previousHome: string | undefined;

/** The manifest as it stands on the day the bundle is registered. */
const FIRST_MANIFEST = [
  'name: coding-kit',
  'version: 1.0.0',
  'description: The house standard',
  'flavors:',
  '  python:',
  '    description: Python tooling',
  '    includes: [subagents/pytest.md]',
  'parameters:',
  '  TEAM: The team that owns this project',
  '',
].join('\n');

/** The same manifest a week later: another flavor, a parameter, a version. */
const GROWN_MANIFEST = [
  'name: coding-kit',
  'version: 1.1.0',
  'description: The house standard, now in two languages',
  'flavors:',
  '  python:',
  '    description: Python tooling',
  '    includes: [subagents/pytest.md]',
  '  csharp:',
  '    description: C# tooling',
  '    includes: [subagents/xunit.md]',
  'parameters:',
  '  TEAM: The team that owns this project',
  '  TONE:',
  '    description: How the agent should write',
  '    default: direct',
  '',
].join('\n');

beforeEach(async () => {
  workspace = await makeWorkspace('live-registry');
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });

  kit = path.join(workspace, 'coding-kit');
  await fs.mkdir(path.join(kit, 'subagents'), { recursive: true });
  await fs.writeFile(path.join(kit, 'hcm.yaml'), FIRST_MANIFEST);
  await fs.writeFile(
    path.join(kit, 'subagents', 'pytest.md'),
    '---\ndescription: Reads pytest failures\n---\n\nRun pytest.\n',
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

/** Add the second flavor, the second parameter and the new version number. */
async function growTheBundle(): Promise<void> {
  await fs.writeFile(path.join(kit, 'hcm.yaml'), GROWN_MANIFEST);
  await fs.writeFile(
    path.join(kit, 'subagents', 'xunit.md'),
    '---\ndescription: Reads xUnit failures\n---\n\nRun dotnet test.\n',
  );
}

/** Run something that logs, and hand back everything it printed. */
async function capture(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  configureLogger({});

  try {
    await run();
  } finally {
    console.log = original;
    configureLogger({ quiet: true });
  }

  return lines.join('\n');
}

const list = (): Promise<string> => capture(() => listCommand({ cwd: projectDir }));

// ---------------------------------------------------------------------------

describe('a dev bundle that has grown since it was registered', () => {
  beforeEach(async () => {
    await addToRegistry(kit, workspace, { dev: true });
    await growTheBundle();
  });

  it('is listed with every flavor its manifest declares, not the one it had', async () => {
    expect(await list()).toMatch(/flavors: python, csharp/);
  });

  it('is listed at the version its manifest now says', async () => {
    expect(await list()).toMatch(/v1\.1\.0/);
  });

  it('names the parameter that was added, so a scripted install can supply it', async () => {
    expect(await list()).toMatch(/parameters: TEAM, TONE/);
  });

  it('says the same in "hcm registry list"', async () => {
    const printed = await capture(() => registryListCommand({}));

    expect(printed).toMatch(/v1\.1\.0/);
    expect(printed).toMatch(/flavors: python, csharp/);
  });

  it('says the same in "hcm list --json", which is what scripts read', async () => {
    const printed = await capture(() => listCommand({ json: true, cwd: projectDir }));
    const entries = JSON.parse(printed) as { version: string; flavors?: { name: string }[] }[];

    expect(entries[0]?.version).toBe('1.1.0');
    expect(entries[0]?.flavors?.map((flavor) => flavor.name)).toEqual(['python', 'csharp']);
  });

  it('stops advertising a flavor the manifest has dropped', async () => {
    await fs.writeFile(
      path.join(kit, 'hcm.yaml'),
      'name: coding-kit\nversion: 1.2.0\ndescription: Back to one language\n',
    );

    const printed = await list();
    expect(printed).toMatch(/v1\.2\.0/);
    expect(printed).not.toMatch(/flavors:/);
    expect(printed).not.toMatch(/parameters:/);
  });

  it('leaves the registry file alone -- a listing is a question, not an edit', async () => {
    await list();

    const stored = (await readRegistry()).entries[0];
    expect(stored?.version).toBe('1.0.0');
    expect(stored?.flavors).toEqual([{ name: 'python', description: 'Python tooling' }]);
  });

  it('falls back to what was recorded when the working copy has gone', async () => {
    await fs.rm(kit, { recursive: true, force: true });

    const printed = await list();
    expect(printed).toMatch(/coding-kit/);
    expect(printed).toMatch(/v1\.0\.0/);
  });
});

// ---------------------------------------------------------------------------

describe('a snapshotted bundle that has changed at its source', () => {
  beforeEach(async () => {
    await addToRegistry(kit, workspace);
    await growTheBundle();
  });

  it('is listed as the copy in the store, which is what an install would write', async () => {
    const printed = await list();

    expect(printed).toMatch(/v1\.0\.0/);
    expect(printed).toMatch(/flavors: python/);
    expect(printed).not.toMatch(/csharp/);
  });
});

// ---------------------------------------------------------------------------

describe('liveEntry', () => {
  it('re-reads a dev entry but keeps everything that is not a copy of the bundle', async () => {
    await addToRegistry(kit, workspace, { dev: true });
    await growTheBundle();

    const entry = (await readRegistry()).entries[0];
    const live = await liveEntry(entry!);

    expect(entry?.version).toBe('1.0.0');
    expect(live.version).toBe('1.1.0');
    expect(live.id).toBe(entry?.id);
    expect(live.addedAt).toBe(entry?.addedAt);
    expect(live.dev).toBe(true);
  });
});
