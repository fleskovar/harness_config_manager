/**
 * The rest of a bundle's life: a new version arriving, a file somebody edited
 * by hand, and a bundle that should never have shipped.
 *
 * `tests/fixtures/bundles/review-kit-v2` is review-kit one version on. Diff the
 * two directories and the whole of the update test follows from it:
 *
 *   subagents/code-reviewer.md  ->  subagents/change-reviewer.md   (renamed)
 *   context/20-pull-requests.md ->  deleted
 *   skills/dependency-audit/checklist.md                           (one line added)
 *
 * A new version is defined as much by what it removed as by what it changed, so
 * the renamed subagent and the deleted section have to *disappear* from the
 * harness -- not sit there beside the new ones.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { uninstallCommand } from '../src/commands/uninstall.js';
import { updateCommand } from '../src/commands/update.js';
import { validateCommand } from '../src/commands/validate.js';
import { loadBundle, validateBundle } from '../src/core/bundle.js';
import { configureLogger } from '../src/core/logger.js';
import { addToRegistry } from '../src/core/registry.js';
import { scanReferences } from '../src/core/refs.js';
import { auditInstallation } from '../src/core/rollback.js';
import { readState } from '../src/core/state.js';
import {
  copyFixture,
  exists,
  fixturePath,
  listTree,
  makeWorkspace,
  readText,
} from './support/fixtures.js';

let workspace: string;
let projectDir: string;
/** Where the "published" bundle lives; v2 replaces it in place. */
let kit: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await makeWorkspace('lifecycle-fixture');
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });
  kit = await copyFixture('bundles/review-kit', path.join(workspace, 'review-kit'));

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

const install = (): Promise<void> =>
  installCommand(kit, { targets: ['claude-code'], scope: 'project', cwd: projectDir });

/** Publish v2 at the same place v1 was, as an upstream release would. */
async function releaseVersionTwo(): Promise<void> {
  await fs.rm(kit, { recursive: true, force: true });
  await copyFixture('bundles/review-kit-v2', kit);
}

const installedVersion = async (): Promise<string | undefined> =>
  (await readState('project', projectDir)).installations[0]?.version;

// ---------------------------------------------------------------------------

describe('hcm update, from review-kit v1 to v2', () => {
  beforeEach(async () => {
    // Registered `--dev`, so the bundle is read from that directory every time
    // and "publishing v2" is a matter of changing the files there.
    await addToRegistry(kit, projectDir, { dev: true });
    await install();
  });

  it('starts from v1, as installed', async () => {
    expect(await installedVersion()).toBe('1.0.0');
    expect(await exists(projectDir, '.claude/agents/code-reviewer.md')).toBe(true);
    expect(await readText(projectDir, 'CLAUDE.md')).toContain('## Pull requests');
  });

  it('installs what v2 added and removes what v2 dropped', async () => {
    await releaseVersionTwo();

    await updateCommand('review-kit', { scope: 'project', cwd: projectDir });

    expect(await installedVersion()).toBe('2.0.0');
    expect(await listTree(projectDir)).toEqual([
      '.claude/agents/change-reviewer.md', // the new name...
      '.claude/commands/review-pr.md',
      '.claude/rules/typescript.md',
      '.claude/settings.json',
      '.claude/skills/dependency-audit/SKILL.md',
      '.claude/skills/dependency-audit/checklist.md',
      '.mcp.json',
      'CLAUDE.md',
    ]);
    // ...and no trace of the old one.
    expect(await exists(projectDir, '.claude/agents/code-reviewer.md')).toBe(false);
  });

  it('takes the deleted context section out of CLAUDE.md', async () => {
    await releaseVersionTwo();

    await updateCommand('review-kit', { scope: 'project', cwd: projectDir });

    const claudeMd = await readText(projectDir, 'CLAUDE.md');
    expect(claudeMd).toContain('## Review conventions');
    expect(claudeMd).not.toContain('## Pull requests');
    expect(claudeMd).not.toContain('review-kit/20-pull-requests');
  });

  it('carries the edited file and the repointed references across', async () => {
    await releaseVersionTwo();

    await updateCommand('review-kit', { scope: 'project', cwd: projectDir });

    expect(await readText(projectDir, '.claude/skills/dependency-audit/checklist.md')).toContain(
      'New in v2: no dependency is added in the same PR as a behaviour change.',
    );
    // The command now names the renamed subagent, at the path it landed on.
    expect(await readText(projectDir, '.claude/commands/review-pr.md')).toContain(
      '`../agents/change-reviewer.md`',
    );
  });

  it('--dry-run leaves v1 exactly where it was', async () => {
    await releaseVersionTwo();

    await updateCommand('review-kit', { scope: 'project', cwd: projectDir, dryRun: true });

    expect(await installedVersion()).toBe('1.0.0');
    expect(await exists(projectDir, '.claude/agents/code-reviewer.md')).toBe(true);
    expect(await exists(projectDir, '.claude/agents/change-reviewer.md')).toBe(false);
  });
});

describe('a file edited by hand after installing', () => {
  const HAND_EDIT = '\n<!-- A note somebody added locally. -->\n';

  const editTheAgentFile = async (): Promise<void> => {
    const file = path.join(projectDir, '.claude', 'agents', 'code-reviewer.md');
    await fs.appendFile(file, HAND_EDIT, 'utf8');
  };

  it('is reported as modified rather than quietly overwritten', async () => {
    await install();
    await editTheAgentFile();

    const [record] = (await readState('project', projectDir)).installations;
    if (!record) throw new Error('review-kit should be installed');
    const audit = await auditInstallation(record, projectDir);
    const agent = audit.find(
      (result) => result.receipt.path === '.claude/agents/code-reviewer.md',
    );

    expect(agent?.status).toBe('modified');
    // Everything else is still exactly as installed.
    expect(audit.filter((result) => result.status === 'modified')).toHaveLength(1);
  });

  it('survives an uninstall, which keeps the record so you can retry', async () => {
    await install();
    await editTheAgentFile();

    await uninstallCommand('review-kit', { scope: 'project', cwd: projectDir });

    expect(await readText(projectDir, '.claude/agents/code-reviewer.md')).toContain(HAND_EDIT.trim());
    expect((await readState('project', projectDir)).installations).toHaveLength(1);
    // The untouched items did go.
    expect(await exists(projectDir, '.claude/commands/review-pr.md')).toBe(false);
  });

  it('goes when the retry says --force', async () => {
    await install();
    await editTheAgentFile();
    await uninstallCommand('review-kit', { scope: 'project', cwd: projectDir });

    await uninstallCommand('review-kit', { scope: 'project', cwd: projectDir, force: true });

    expect(await listTree(projectDir)).toEqual([]);
    expect((await readState('project', projectDir)).installations).toEqual([]);
  });
});

describe('hcm validate', () => {
  it('names all three mistakes in the bundle written to have them', async () => {
    const bundle = await loadBundle(fixturePath('bundles/invalid-kit'));

    expect(validateBundle(bundle)).toEqual([
      'mcp/broken.json: MCP server needs a "command" or "url"',
      'subagents/helper.md: missing "description" in frontmatter',
      'Subagent "helper" collides with the skill of the same name (skills/helper, ' +
        'subagents/helper.md): Reasonix and Pi store both as skills/helper/',
    ]);
    expect(await validateCommand(fixturePath('bundles/invalid-kit'), { cwd: workspace })).toBe(false);
  });
});

/**
 * The assets themselves, kept honest. Every bundle here except broken-refs-kit
 * and invalid-kit is meant to be a bundle somebody would be happy to ship, and
 * a test that starts from a broken fixture proves nothing.
 */
describe('the healthy fixtures', () => {
  const HEALTHY = [
    'bundles/review-kit',
    'bundles/review-kit-v2',
    'collections/sprint-collection/team-conventions',
    'collections/sprint-collection/sprint-kit',
  ];

  it.each(HEALTHY)('%s validates', async (relative) => {
    expect(await validateCommand(fixturePath(relative), { cwd: workspace })).toBe(true);
  });

  it.each(HEALTHY)('%s has no broken references', async (relative) => {
    const result = await scanReferences(fixturePath(relative));
    expect(result.broken.map((ref) => `${ref.fileRelative}: ${ref.ref}`)).toEqual([]);
  });
});
