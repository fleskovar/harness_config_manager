/**
 * Shared items: what happens when two bundles want the very same thing.
 *
 * Not a conflict and not an adoption -- a *share*. The item is written once and
 * claimed by both, and it survives until the last bundle that wanted it is
 * uninstalled. This is what stops a dependency's assets being copied once per
 * dependent, and what stops removing one dependent from breaking the rest.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBundle } from '../src/core/bundle.js';
import { applyPlan } from '../src/core/executor.js';
import { buildPlan } from '../src/core/planner.js';
import { rollback } from '../src/core/rollback.js';
import { collectClaims, removeInstallation, upsertInstallation } from '../src/core/state.js';
import {
  installationId,
  type InstallationRecord,
  type TargetId,
} from '../src/core/types.js';

let workspace: string;
let projectDir: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-share-'));
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/**
 * The shared parts every fixture below ships byte-for-byte identically. The
 * SKILL.md is re-rendered per target, so what lands on disk is not this text --
 * what matters is that both bundles produce the same rendering.
 */
const SHARED_SKILL = '---\ndescription: How to talk to the JIRA board\n---\n\nUse the board API.\n';
const SHARED_SERVER = { command: 'jira-mcp', args: ['--board', 'ENG'] };
const SHARED_ASSET = 'id,summary\n1,example\n';

/**
 * A bundle carrying the shared skill, server, asset and permission, plus one
 * resource of its own so the two bundles are not simply identical.
 */
async function makeBundle(name: string, extraPermission: string): Promise<string> {
  const root = path.join(workspace, name);

  const files: Record<string, string> = {
    'hcm.yaml': `name: ${name}\nversion: 1.0.0\n`,
    'skills/jira-board/SKILL.md': SHARED_SKILL,
    'skills/jira-board/reference.md': '# Fields\n\nsummary, status.\n',
    'assets/jira/fields.csv': SHARED_ASSET,
    'mcp/jira.json': JSON.stringify(SHARED_SERVER),
    'settings/settings.json': JSON.stringify({
      permissions: { allow: ['Bash(jira:*)', extraPermission] },
    }),
    [`subagents/${name}-worker.md`]: `---\ndescription: Works on ${name}\n---\n\nDo ${name} work.\n`,
  };

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }

  return root;
}

async function install(
  bundleRoot: string,
  target: TargetId = 'claude-code',
): Promise<InstallationRecord> {
  const bundle = await loadBundle(bundleRoot);
  const plan = await buildPlan(bundle, target, 'project', projectDir);
  const receipts = await applyPlan(plan);

  const record: InstallationRecord = {
    id: installationId(bundle.manifest.name, target, 'project'),
    bundle: bundle.manifest.name,
    version: bundle.manifest.version,
    target,
    scope: 'project',
    source: { type: 'local', path: bundleRoot },
    installedAt: new Date().toISOString(),
    receipts,
  };

  await upsertInstallation('project', projectDir, record);
  return record;
}

/** Uninstall the way `hcm uninstall` does: with everyone else's claims in hand. */
async function uninstall(record: InstallationRecord): Promise<ReturnType<typeof rollback>> {
  const claims = await collectClaims(projectDir, { excludeIds: [record.id] });
  const results = await rollback(record, projectDir, { claims });
  await removeInstallation('project', projectDir, record.id);
  return results;
}

const readJson = async (relative: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(path.join(projectDir, ...relative.split('/')), 'utf8'));

const readText = (relative: string): Promise<string> =>
  fs.readFile(path.join(projectDir, ...relative.split('/')), 'utf8');

const exists = async (relative: string): Promise<boolean> => {
  try {
    await fs.access(path.join(projectDir, ...relative.split('/')));
    return true;
  } catch {
    return false;
  }
};

describe('two bundles shipping the same items', () => {
  it('plans the second one as a share, not a conflict', async () => {
    await install(await makeBundle('alpha', 'Read(**)'));

    const beta = await loadBundle(await makeBundle('beta', 'Bash(git:*)'));
    const plan = await buildPlan(beta, 'claude-code', 'project', projectDir);

    expect(plan.conflicts).toEqual([]);

    const shared = plan.actions.filter((action) => action.share).map((action) => action.path);
    expect(shared).toContain('.claude/skills/jira-board/SKILL.md');
    expect(shared).toContain('.claude/skills/jira-board/reference.md');
    expect(shared).toContain('.claude/jira/fields.csv');
    expect(shared).toContain('.mcp.json');

    // Its own subagent is nobody else's, so it is an ordinary write.
    const own = plan.actions.find((action) => action.path === '.claude/agents/beta-worker.md');
    expect(own?.share).toBeUndefined();
    expect(own?.adopt).toBeUndefined();
  });

  it('does not write a second copy of a shared file', async () => {
    await install(await makeBundle('alpha', 'Read(**)'));

    const skill = '.claude/skills/jira-board/SKILL.md';
    const before = await fs.stat(path.join(projectDir, ...skill.split('/')));
    const contents = await readText(skill);

    await install(await makeBundle('beta', 'Bash(git:*)'));

    const after = await fs.stat(path.join(projectDir, ...skill.split('/')));
    // Not rewritten at all: same bytes, and the file was never reopened.
    expect(await readText(skill)).toBe(contents);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('records the share as a real claim, not as pre-existing', async () => {
    await install(await makeBundle('alpha', 'Read(**)'));
    const beta = await install(await makeBundle('beta', 'Bash(git:*)'));

    const skill = beta.receipts.find(
      (receipt) => receipt.path === '.claude/skills/jira-board/SKILL.md',
    );
    // `preexisting` would mean "not ours to remove" -- but the last claimant
    // does have to remove it, so a share is recorded as ownership.
    expect(skill?.op === 'file' && skill.preexisting).toBeUndefined();
  });

  it('holds a shared item until the last bundle goes', async () => {
    const alpha = await install(await makeBundle('alpha', 'Read(**)'));
    const beta = await install(await makeBundle('beta', 'Bash(git:*)'));

    const results = await uninstall(alpha);

    const skill = results.find(
      (result) => result.receipt.path === '.claude/skills/jira-board/SKILL.md',
    );
    expect(skill?.status).toBe('held');
    expect(skill?.detail).toContain('beta');

    // Everything shared is still there and still works for beta.
    expect(await exists('.claude/skills/jira-board/SKILL.md')).toBe(true);
    expect(await exists('.claude/jira/fields.csv')).toBe(true);
    expect(await readJson('.mcp.json')).toEqual({ mcpServers: { jira: SHARED_SERVER } });
    // Alpha's own subagent went, beta's stayed.
    expect(await exists('.claude/agents/alpha-worker.md')).toBe(false);
    expect(await exists('.claude/agents/beta-worker.md')).toBe(true);

    await uninstall(beta);

    expect(await exists('.claude/skills/jira-board/SKILL.md')).toBe(false);
    expect(await exists('.claude/jira/fields.csv')).toBe(false);
    expect(await exists('.mcp.json')).toBe(false);
  });

  it('counts array items one at a time', async () => {
    const alpha = await install(await makeBundle('alpha', 'Read(**)'));
    const beta = await install(await makeBundle('beta', 'Bash(git:*)'));

    const allowed = async (): Promise<string[]> =>
      ((await readJson('.claude/settings.json')).permissions as { allow: string[] }).allow;

    expect(await allowed()).toEqual(['Bash(jira:*)', 'Read(**)', 'Bash(git:*)']);

    // Both asked for Bash(jira:*), so beta's receipt claims it too...
    const betaItems = beta.receipts.find((receipt) => receipt.op === 'json-array-item');
    expect(betaItems?.op === 'json-array-item' && betaItems.hashes).toHaveLength(2);

    // ...and removing alpha takes only the permission nobody else wanted.
    await uninstall(alpha);
    expect(await allowed()).toEqual(['Bash(jira:*)', 'Bash(git:*)']);

    await uninstall(beta);
    expect(await exists('.claude/settings.json')).toBe(false);
  });

  it('leaves an item the user wrote alone, however many bundles want it', async () => {
    // The permission was in the file before any bundle asked for it, so nobody
    // claims it and it outlives them all.
    await fs.mkdir(path.join(projectDir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(jira:*)'] } }, null, 2),
    );

    const alpha = await install(await makeBundle('alpha', 'Read(**)'));
    const beta = await install(await makeBundle('beta', 'Bash(git:*)'));

    await uninstall(alpha);
    await uninstall(beta);

    expect(
      ((await readJson('.claude/settings.json')).permissions as { allow: string[] }).allow,
    ).toEqual(['Bash(jira:*)']);
  });

  it('still refuses when the same item is defined differently', async () => {
    await install(await makeBundle('alpha', 'Read(**)'));

    const betaRoot = await makeBundle('beta', 'Bash(git:*)');
    await fs.writeFile(
      path.join(betaRoot, 'mcp', 'jira.json'),
      JSON.stringify({ command: 'jira-mcp', args: ['--board', 'OPS'] }),
    );
    await fs.writeFile(
      path.join(betaRoot, 'skills', 'jira-board', 'SKILL.md'),
      '---\ndescription: A different take on the board\n---\n\nSomething else.\n',
    );

    const plan = await buildPlan(await loadBundle(betaRoot), 'claude-code', 'project', projectDir);

    const paths = plan.conflicts.map((conflict) => conflict.path);
    expect(paths).toContain('.mcp.json');
    expect(paths).toContain('.claude/skills/jira-board/SKILL.md');
    for (const conflict of plan.conflicts) expect(conflict.owner).toBe('alpha');
  });

  it('re-writes a shared file that has gone missing rather than complaining', async () => {
    const alpha = await install(await makeBundle('alpha', 'Read(**)'));
    await fs.rm(path.join(projectDir, '.claude/jira/fields.csv'));

    const beta = await install(await makeBundle('beta', 'Bash(git:*)'));

    expect(await readText('.claude/jira/fields.csv')).toBe(SHARED_ASSET);
    // And it is claimed by both, so alpha's uninstall still leaves it.
    await uninstall(alpha);
    expect(await exists('.claude/jira/fields.csv')).toBe(true);
    await uninstall(beta);
    expect(await exists('.claude/jira/fields.csv')).toBe(false);
  });

  it('shares across harnesses that write the same file', async () => {
    // Claude Code and Pi both keep MCP servers in .mcp.json.
    const alpha = await install(await makeBundle('alpha', 'Read(**)'), 'claude-code');
    const beta = await install(await makeBundle('beta', 'Bash(git:*)'), 'pi');

    expect(await readJson('.mcp.json')).toEqual({ mcpServers: { jira: SHARED_SERVER } });

    await uninstall(alpha);
    expect(await readJson('.mcp.json')).toEqual({ mcpServers: { jira: SHARED_SERVER } });

    await uninstall(beta);
    expect(await exists('.mcp.json')).toBe(false);
  });
});

describe('a shared marker block', () => {
  it('is held while another installation still points at it', async () => {
    // OpenCode and Pi both write AGENTS.md, and the block in it answers to both.
    const root = path.join(workspace, 'gamma');
    await fs.mkdir(path.join(root, 'context'), { recursive: true });
    await fs.writeFile(path.join(root, 'hcm.yaml'), 'name: gamma\nversion: 1.0.0\n');
    await fs.writeFile(path.join(root, 'context', 'notes.md'), '## Notes\n\nRead the board.\n');

    const opencode = await install(root, 'opencode');
    const pi = await install(root, 'pi');

    const results = await uninstall(opencode);
    expect(results.find((result) => result.receipt.op === 'block')?.status).toBe('held');
    expect(await readText('AGENTS.md')).toContain('Read the board.');

    await uninstall(pi);
    expect(await exists('AGENTS.md')).toBe(false);
  });
});
