/**
 * An update that cannot finish must not start.
 *
 * `hcm update` is rollback-then-install: the old version comes out, the new one
 * goes in. Both halves have a rule, and they used to contradict each other.
 *
 *   rollback  an item edited since install is not hcm's to throw away, so it is
 *             reported `modified` and left -- and the *other* items still go,
 *             which is right for `hcm uninstall`, where the whole point is to
 *             remove what can be removed.
 *   install   an update refuses to write the new version over a removal that
 *             did not finish, or the two versions would be interleaved.
 *
 * Put together, one hand-edited file used to empty the harness: everything
 * unmodified was deleted by the first rule, and the second rule then refused to
 * put anything back. The installation record survived, still claiming every one
 * of those items. In a folder with two harnesses the damage was quiet as well
 * as total -- the harness with no edit in it updated normally, so the run
 * looked like it had worked.
 *
 * What is asserted here is that the removal is all-or-nothing: a blocked
 * installation is left exactly as it was, the harnesses that are not blocked
 * are still updated, and `--force` is still the way through.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { uninstallCommand } from '../src/commands/uninstall.js';
import { updateCommand } from '../src/commands/update.js';
import { configureLogger } from '../src/core/logger.js';
import { addToRegistry } from '../src/core/registry.js';
import { readState } from '../src/core/state.js';
import type { InstallationRecord } from '../src/core/types.js';
import { exists, listTree, makeWorkspace, readText } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let bundleRoot: string;
let previousHome: string | undefined;

/**
 * One skill and one subagent, which between them cover both of the things the
 * report named. On Pi a subagent is filed as a skill, so `.pi/skills/` holds
 * both of them and losing that directory loses everything Pi had.
 */
async function writeBundle(prompt: string): Promise<void> {
  await fs.mkdir(path.join(bundleRoot, 'subagents'), { recursive: true });
  await fs.mkdir(path.join(bundleRoot, 'skills', 'audit'), { recursive: true });

  await fs.writeFile(path.join(bundleRoot, 'hcm.yaml'), 'name: kit\nversion: 1.0.0\n');
  await fs.writeFile(
    path.join(bundleRoot, 'subagents', 'scout.md'),
    `---\ndescription: Fast recon\n---\n\n${prompt}\n`,
  );
  await fs.writeFile(
    path.join(bundleRoot, 'skills', 'audit', 'SKILL.md'),
    `---\nname: audit\ndescription: Audit dependencies\n---\n\n${prompt}\n`,
  );
  await fs.writeFile(path.join(bundleRoot, 'skills', 'audit', 'checklist.md'), `${prompt}\n`);
}

beforeEach(async () => {
  workspace = await makeWorkspace('update-blocked');
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });

  previousHome = process.env.HCM_HOME;
  process.env.HCM_HOME = path.join(workspace, 'home');
  delete process.env.HCM_REQUIRE_TARGET;
  configureLogger({ quiet: true });

  bundleRoot = path.join(workspace, 'kit');
  await writeBundle('The original wording.');
  // --dev, so rewriting the bundle is what `hcm update` re-reads.
  await addToRegistry(bundleRoot, workspace, { dev: true });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HCM_HOME;
  else process.env.HCM_HOME = previousHome;
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

const installBoth = (): Promise<void> =>
  installCommand('kit', {
    targets: ['claude-code', 'pi'],
    scope: 'project',
    cwd: projectDir,
    onConflict: 'abort',
    prompt: false,
  });

const update = (options: { force?: boolean } = {}): Promise<void> =>
  updateCommand('kit', {
    // `-t all`, as reported: every harness, not just the one being looked at.
    targets: ['all'],
    scope: 'project',
    cwd: projectDir,
    onConflict: 'abort',
    prompt: false,
    ...(options.force ? { force: true } : {}),
  });

const installations = async (): Promise<InstallationRecord[]> =>
  (await readState('project', projectDir)).installations;

/** Every item the ledger claims that is not actually on disk. */
async function claimedButMissing(): Promise<string[]> {
  const missing: string[] = [];
  for (const record of await installations()) {
    for (const receipt of record.receipts) {
      if (!(await exists(projectDir, receipt.path))) missing.push(`${record.id}: ${receipt.path}`);
    }
  }
  return missing.sort();
}

const PI_FILES = [
  '.pi/skills/audit/SKILL.md',
  '.pi/skills/audit/checklist.md',
  '.pi/skills/scout/SKILL.md',
];

const CLAUDE_FILES = [
  '.claude/agents/scout.md',
  '.claude/skills/audit/SKILL.md',
  '.claude/skills/audit/checklist.md',
];

const EVERYTHING = [...CLAUDE_FILES, ...PI_FILES].sort();

const EDITED = '.pi/skills/audit/SKILL.md';
const LOCAL_NOTE = 'A note added locally.';

describe('hcm update -t all, with one item edited since install', () => {
  beforeEach(async () => {
    await installBoth();
    expect(await listTree(projectDir)).toEqual(EVERYTHING);

    // Somebody -- or the harness's own agent -- edits one installed file.
    await fs.appendFile(path.join(projectDir, ...EDITED.split('/')), `\n${LOCAL_NOTE}\n`);
    await writeBundle('The new wording.');
  });

  it('leaves every other item of the blocked installation where it is', async () => {
    await update();

    // The defect: these were deleted by the rollback and never written back,
    // so Pi lost its skills and its subagent to one edited file.
    expect(await listTree(projectDir)).toEqual(EVERYTHING);
    for (const file of PI_FILES) {
      expect(await readText(projectDir, file), file).toContain('The original wording.');
    }
  });

  it('keeps the edit that blocked it', async () => {
    await update();

    expect(await readText(projectDir, EDITED)).toContain(LOCAL_NOTE);
  });

  it('still updates the harnesses that are not blocked', async () => {
    await update();

    for (const file of CLAUDE_FILES) {
      expect(await readText(projectDir, file), file).toContain('The new wording.');
    }
  });

  it('leaves the ledger describing what is actually on disk', async () => {
    await update();

    // The blocked installation keeps its record -- and the record is true
    // again, because nothing was taken away behind its back.
    expect((await installations()).map((record) => record.id).sort()).toEqual([
      'kit@claude-code@project',
      'kit@pi@project',
    ]);
    expect(await claimedButMissing()).toEqual([]);
  });

  it('goes through with --force, replacing the edit', async () => {
    await update({ force: true });

    expect(await listTree(projectDir)).toEqual(EVERYTHING);
    for (const file of EVERYTHING) {
      expect(await readText(projectDir, file), file).toContain('The new wording.');
    }
    expect(await readText(projectDir, EDITED)).not.toContain(LOCAL_NOTE);
  });
});

describe('hcm update -t all, with nothing edited', () => {
  it('swaps both harnesses over to the new version', async () => {
    await installBoth();
    await writeBundle('The new wording.');

    await update();

    expect(await listTree(projectDir)).toEqual(EVERYTHING);
    for (const file of EVERYTHING) {
      expect(await readText(projectDir, file), file).toContain('The new wording.');
    }
    expect(await claimedButMissing()).toEqual([]);
  });

  it('removes an item the new version dropped', async () => {
    await installBoth();
    await writeBundle('The new wording.');
    await fs.rm(path.join(bundleRoot, 'skills', 'audit', 'checklist.md'));

    await update();

    // This is why update rolls back rather than writing over the top, and so
    // why the guard above has to leave the rollback whole rather than partial.
    expect(await exists(projectDir, '.pi/skills/audit/checklist.md')).toBe(false);
    expect(await exists(projectDir, '.claude/skills/audit/checklist.md')).toBe(false);
    expect(await claimedButMissing()).toEqual([]);
  });
});

describe('hcm uninstall, which wants the opposite', () => {
  it('still removes everything it can and keeps the record for the rest', async () => {
    await installBoth();
    await fs.appendFile(path.join(projectDir, ...EDITED.split('/')), `\n${LOCAL_NOTE}\n`);

    await uninstallCommand('kit', { targets: ['pi'], scope: 'project', cwd: projectDir });

    // Nothing is being put back here, so a partial removal is the honest
    // answer: the edited file stays, everything else goes, and the record is
    // kept so "hcm uninstall --force" can finish the job.
    expect(await listTree(projectDir)).toEqual([...CLAUDE_FILES, EDITED].sort());
    expect((await installations()).map((record) => record.id).sort()).toEqual([
      'kit@claude-code@project',
      'kit@pi@project',
    ]);
  });
});
