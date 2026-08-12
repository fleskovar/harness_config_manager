/**
 * End-to-end: install two bundles that both write into the same shared files,
 * then uninstall one and confirm the other survives intact.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBundle } from '../src/core/bundle.js';
import { applyPlan } from '../src/core/executor.js';
import { buildPlan } from '../src/core/planner.js';
import { rollback } from '../src/core/rollback.js';
import { upsertInstallation } from '../src/core/state.js';
import { installationId, type InstallationRecord, type TargetId } from '../src/core/types.js';

let workspace: string;
let projectDir: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-test-'));
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/** Write a minimal bundle with a subagent, a rule, a context doc, an MCP server and settings. */
async function makeBundle(name: string, serverName: string, permission: string): Promise<string> {
  const root = path.join(workspace, name);

  const files: Record<string, string> = {
    'hcm.yaml': `name: ${name}\nversion: 1.0.0\ndescription: test bundle\n`,
    [`subagents/${name}-reviewer.md`]: `---\ndescription: Reviews code\ntools: [Read, Grep]\n---\n\nReview the code.\n`,
    // Named per bundle: two bundles shipping the same rule file is a genuine
    // collision, and these tests are about the ones that are not.
    [`rules/${name}-typescript.md`]: `---\ndescription: TS conventions\nappliesTo: ["**/*.ts"]\n---\n\n- Prefer named exports.\n`,
    'context/project.md': `## ${name}\n\nInstructions from ${name}.\n`,
    'mcp/placeholder.json': JSON.stringify({ command: serverName, args: ['--serve'] }),
    'settings/settings.json': JSON.stringify({ permissions: { allow: [permission] } }),
  };

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }

  // Give each bundle a distinctly named MCP server file.
  await fs.rename(
    path.join(root, 'mcp', 'placeholder.json'),
    path.join(root, 'mcp', `${serverName}.json`),
  );

  return root;
}

/**
 * Install and record it, exactly as `hcm install` does -- the ledger is what
 * tells a later install "you wrote this", so leaving it out would make every
 * reinstall look like an adoption of somebody else's file.
 */
async function install(bundleRoot: string, target: TargetId): Promise<InstallationRecord> {
  const bundle = await loadBundle(bundleRoot);
  const plan = await buildPlan(bundle, target, 'project', projectDir);
  expect(plan.conflicts).toEqual([]);
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

describe('claude-code install/uninstall', () => {
  it('writes the expected layout', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    await install(alpha, 'claude-code');

    expect(await exists('.claude/agents/alpha-reviewer.md')).toBe(true);
    expect(await exists('CLAUDE.md')).toBe(true);

    const agent = await readText('.claude/agents/alpha-reviewer.md');
    // Claude Code wants a comma-separated tools string, not a YAML list.
    expect(agent).toContain('tools: Read, Grep');

    expect(await readJson('.mcp.json')).toEqual({
      mcpServers: { 'alpha-server': { command: 'alpha-server', args: ['--serve'] } },
    });
  });

  it('removes exactly one bundle from shared files', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    const beta = await makeBundle('beta', 'beta-server', 'Bash(git:*)');

    const alphaRecord = await install(alpha, 'claude-code');
    await install(beta, 'claude-code');

    // Both bundles share .mcp.json, CLAUDE.md and settings.json.
    expect(Object.keys((await readJson('.mcp.json')).mcpServers as object)).toEqual([
      'alpha-server',
      'beta-server',
    ]);
    const claudeMd = await readText('CLAUDE.md');
    expect(claudeMd).toContain('Instructions from alpha.');
    expect(claudeMd).toContain('Instructions from beta.');

    const settings = await readJson('.claude/settings.json');
    expect((settings.permissions as { allow: string[] }).allow).toEqual(['Read(**)', 'Bash(git:*)']);

    // Uninstall alpha only.
    const results = await rollback(alphaRecord, projectDir);
    expect(results.every((result) => result.status === 'removed')).toBe(true);

    expect(await readJson('.mcp.json')).toEqual({
      mcpServers: { 'beta-server': { command: 'beta-server', args: ['--serve'] } },
    });

    const afterMd = await readText('CLAUDE.md');
    expect(afterMd).not.toContain('Instructions from alpha.');
    expect(afterMd).toContain('Instructions from beta.');

    const afterSettings = await readJson('.claude/settings.json');
    expect((afterSettings.permissions as { allow: string[] }).allow).toEqual(['Bash(git:*)']);

    // Alpha's own files are gone; beta's remain.
    expect(await exists('.claude/agents/alpha-reviewer.md')).toBe(false);
    expect(await exists('.claude/agents/beta-reviewer.md')).toBe(true);
  });

  it('survives the shared file being reformatted between install and uninstall', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    const beta = await makeBundle('beta', 'beta-server', 'Bash(git:*)');

    const alphaRecord = await install(alpha, 'claude-code');
    await install(beta, 'claude-code');

    // Rewrite .mcp.json the way another tool might: reordered keys, different
    // indentation, plus a hand-added server. Line-based tracking would break here.
    const mcpPath = path.join(projectDir, '.mcp.json');
    const current = JSON.parse(await fs.readFile(mcpPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    const rewritten = {
      $schema: 'https://example.com/mcp.json',
      mcpServers: {
        'hand-added': { command: 'manual' },
        'beta-server': current.mcpServers['beta-server'],
        'alpha-server': { args: ['--serve'], command: 'alpha-server' },
      },
    };
    await fs.writeFile(mcpPath, JSON.stringify(rewritten, null, 4));

    const results = await rollback(alphaRecord, projectDir);
    expect(results.filter((result) => result.status === 'modified')).toEqual([]);

    const after = await readJson('.mcp.json');
    expect(after).toEqual({
      $schema: 'https://example.com/mcp.json',
      mcpServers: {
        'hand-added': { command: 'manual' },
        'beta-server': { command: 'beta-server', args: ['--serve'] },
      },
    });
  });

  it('refuses to remove an item edited since install, unless forced', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    const record = await install(alpha, 'claude-code');

    const mcpPath = path.join(projectDir, '.mcp.json');
    await fs.writeFile(
      mcpPath,
      JSON.stringify({ mcpServers: { 'alpha-server': { command: 'edited-by-hand' } } }, null, 2),
    );

    const results = await rollback(record, projectDir);
    const mcpResult = results.find(
      (result) => result.receipt.op === 'json-value' && result.receipt.path === '.mcp.json',
    );
    expect(mcpResult?.status).toBe('modified');
    expect((await readJson('.mcp.json')).mcpServers).toEqual({
      'alpha-server': { command: 'edited-by-hand' },
    });

    const forced = await rollback(record, projectDir, { force: true });
    const forcedResult = forced.find(
      (result) => result.receipt.op === 'json-value' && result.receipt.path === '.mcp.json',
    );
    expect(forcedResult?.status).toBe('removed');
  });

  it('deletes files it created and leaves pre-existing ones alone', async () => {
    // A CLAUDE.md the user already had.
    await fs.writeFile(path.join(projectDir, 'CLAUDE.md'), '# Existing\n\nMy own notes.\n');

    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    const record = await install(alpha, 'claude-code');

    expect(await readText('CLAUDE.md')).toContain('My own notes.');

    await rollback(record, projectDir);

    // CLAUDE.md survives because we did not create it; .mcp.json goes away because we did.
    expect(await readText('CLAUDE.md')).toContain('My own notes.');
    expect(await exists('.mcp.json')).toBe(false);
    expect(await exists('.claude/agents/alpha-reviewer.md')).toBe(false);
  });

  it('is idempotent across a reinstall', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    await install(alpha, 'claude-code');
    const second = await install(alpha, 'claude-code');

    const settings = await readJson('.claude/settings.json');
    // The permission is appended once, not twice.
    expect((settings.permissions as { allow: string[] }).allow).toEqual(['Read(**)']);

    const claudeMd = await readText('CLAUDE.md');
    expect(claudeMd.match(/hcm:begin alpha\/project/g)).toHaveLength(1);

    await rollback(second, projectDir);
    expect(await exists('.mcp.json')).toBe(false);
  });
});

describe('copilot target', () => {
  it('maps resources onto the .github layout', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    await install(alpha, 'copilot');

    expect(await exists('.github/agents/alpha-reviewer.agent.md')).toBe(true);
    expect(await exists('.github/copilot-instructions.md')).toBe(true);

    const servers = (await readJson('.vscode/mcp.json')).servers as Record<string, unknown>;
    // Copilot needs an explicit transport type; we infer stdio from `command`.
    expect(servers['alpha-server']).toEqual({
      command: 'alpha-server',
      args: ['--serve'],
      type: 'stdio',
    });
  });
});

describe('reasonix target', () => {
  it('appends MCP servers as a marked [[plugins]] block', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    const record = await install(alpha, 'reasonix');

    const toml = await readText('reasonix.toml');
    expect(toml).toContain('# hcm:begin alpha/plugins/alpha-server');
    expect(toml).toContain('[[plugins]]');
    expect(toml).toContain('name = "alpha-server"');
    expect(await exists('REASONIX.md')).toBe(true);

    await rollback(record, projectDir);
    expect(await exists('reasonix.toml')).toBe(false);
  });

  it('installs a subagent as a manual skill, not an agents file', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    const record = await install(alpha, 'reasonix');

    // Reasonix has no agents directory: a profile is a Skill with runAs: subagent.
    expect(await exists('.reasonix/agents/alpha-reviewer.md')).toBe(false);

    const profile = await readText('.reasonix/skills/alpha-reviewer/SKILL.md');
    expect(profile).toContain('runAs: subagent');
    expect(profile).toContain('invocation: manual');
    // A profile-level allowlist, kept as a YAML list.
    expect(profile).toMatch(/allowed-tools:\s*\n\s*- Read\n\s*- Grep/);

    await rollback(record, projectDir);
    expect(await exists('.reasonix/skills/alpha-reviewer/SKILL.md')).toBe(false);
  });

  it('folds rules into REASONIX.md, which has no per-rule file format', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    await install(alpha, 'reasonix');

    expect(await exists('.reasonix/rules/alpha-typescript.md')).toBe(false);

    const md = await readText('REASONIX.md');
    expect(md).toContain('<!-- hcm:begin alpha/rules/alpha-typescript -->');
    expect(md).toContain('**Applies to:** `**/*.ts`');
    expect(md).toContain('- Prefer named exports.');
    // The context doc keeps its own block alongside it.
    expect(md).toContain('<!-- hcm:begin alpha/project -->');
  });

  it('preserves hand-written TOML around its block', async () => {
    await fs.writeFile(
      path.join(projectDir, 'reasonix.toml'),
      '# my config\nmodel = "deepseek"\n\n[sandbox]\nworkspace_root = "."\n',
    );

    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    const record = await install(alpha, 'reasonix');
    await rollback(record, projectDir);

    const toml = await readText('reasonix.toml');
    expect(toml).toContain('# my config');
    expect(toml).toContain('model = "deepseek"');
    expect(toml).toContain('workspace_root = "."');
    expect(toml).not.toContain('[[plugins]]');
  });
});

describe('opencode target', () => {
  it('maps resources onto the .opencode layout', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    await install(alpha, 'opencode');

    const agent = await readText('.opencode/agents/alpha-reviewer.md');
    // Without mode: subagent this would define a primary agent instead.
    expect(agent).toContain('mode: subagent');
    // OpenCode gates tools through a permission object, not a name list.
    expect(agent).not.toContain('tools:');

    // Context goes to AGENTS.md, the file OpenCode actually reads.
    expect(await readText('AGENTS.md')).toContain('Instructions from alpha.');
  });

  it('writes MCP servers in OpenCode’s own shape', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    await install(alpha, 'opencode');

    const mcp = (await readJson('opencode.json')).mcp as Record<string, unknown>;
    // command + args collapse into one argv array, and the transport is named.
    expect(mcp['alpha-server']).toEqual({
      type: 'local',
      command: ['alpha-server', '--serve'],
    });
  });

  it('keeps rules as files and registers them in instructions[]', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    const beta = await makeBundle('beta', 'beta-server', 'Bash(git:*)');

    const alphaRecord = await install(alpha, 'opencode');
    await install(beta, 'opencode');

    const rule = await readText('.opencode/rules/alpha-typescript.md');
    // OpenCode has no glob-scoped rule format, so the globs are stated in prose.
    expect(rule).toContain('**Applies to:** `**/*.ts`');
    expect(rule).toContain('- Prefer named exports.');

    // Both bundles list their own rule; neither replaced the other's entry.
    expect((await readJson('opencode.json')).instructions).toEqual([
      '.opencode/rules/alpha-typescript.md',
      '.opencode/rules/beta-typescript.md',
    ]);

    await rollback(alphaRecord, projectDir);

    expect(await exists('.opencode/rules/alpha-typescript.md')).toBe(false);
    expect((await readJson('opencode.json')).instructions).toEqual([
      '.opencode/rules/beta-typescript.md',
    ]);
  });
});

describe('pi target', () => {
  it('maps the kinds it has a home for', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    const record = await install(alpha, 'pi');

    // Rules and context both fold into AGENTS.md; Pi has no per-rule format.
    const agentsMd = await readText('AGENTS.md');
    expect(agentsMd).toContain('<!-- hcm:begin alpha/rules/alpha-typescript -->');
    expect(agentsMd).toContain('**Applies to:** `**/*.ts`');
    expect(agentsMd).toContain('Instructions from alpha.');

    const settings = await readJson('.pi/settings.json');
    expect((settings.permissions as { allow: string[] }).allow).toEqual(['Read(**)']);

    await rollback(record, projectDir);
    expect(await exists('.pi/settings.json')).toBe(false);
  });

  it('writes MCP servers to the shared .mcp.json convention', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    const record = await install(alpha, 'pi');

    // Pi has no MCP client of its own, but its MCP extensions read the same
    // .mcp.json every other harness uses, so the server passes through as-is.
    expect(await readJson('.mcp.json')).toEqual({
      mcpServers: { 'alpha-server': { command: 'alpha-server', args: ['--serve'] } },
    });

    await rollback(record, projectDir);
    expect(await exists('.mcp.json')).toBe(false);
  });

  it('shares .mcp.json with Claude Code without either owning it', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    await install(alpha, 'claude-code');
    const piRecord = await install(alpha, 'pi');

    // The second install finds an identical entry and adopts it -- recorded as
    // a dependency, but not ours to delete.
    const adopted = piRecord.receipts.find(
      (receipt) => receipt.op === 'json-value' && receipt.path === '.mcp.json',
    );
    expect(adopted).toMatchObject({ preexisting: true });

    // So removing Pi leaves Claude Code's server exactly where it was.
    await rollback(piRecord, projectDir);
    expect(await readJson('.mcp.json')).toEqual({
      mcpServers: { 'alpha-server': { command: 'alpha-server', args: ['--serve'] } },
    });
  });

  it('installs a subagent as a skill, not an agents file', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    const record = await install(alpha, 'pi');

    // Pi has no agents directory: subagents share skills/ with skills.
    expect(await exists('.pi/agents/alpha-reviewer.md')).toBe(false);

    const skill = await readText('.pi/skills/alpha-reviewer/SKILL.md');
    expect(skill).toContain('name: alpha-reviewer');
    expect(skill).toContain('description: Reviews code');
    expect(skill).toContain('Review the code.');
    // Agent Skills frontmatter is name + description; Pi has no per-skill
    // tool allowlist for a subagent's `tools` to land in.
    expect(skill).not.toContain('tools:');

    await rollback(record, projectDir);
    expect(await exists('.pi/skills/alpha-reviewer/SKILL.md')).toBe(false);
  });

  it('has a home for every resource kind', async () => {
    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    const plan = await buildPlan(await loadBundle(alpha), 'pi', 'project', projectDir);

    expect(plan.skipped).toEqual([]);
  });
});

describe('conflict detection', () => {
  it('flags a TOML table that already exists', async () => {
    await fs.writeFile(
      path.join(projectDir, 'reasonix.toml'),
      '[permissions]\nallow = ["Bash(ls)"]\n',
    );

    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    const bundle = await loadBundle(alpha);
    const plan = await buildPlan(bundle, 'reasonix', 'project', projectDir);

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.detail).toContain('[permissions]');
  });

  it('flags an item another installed bundle already owns', async () => {
    // Two bundles that both ship an MCP server called "shared".
    const alpha = await makeBundle('alpha', 'shared', 'Read(**)');
    const beta = await makeBundle('beta', 'shared', 'Bash(git:*)');

    const record = await install(alpha, 'claude-code');
    // Record the install so ownership is visible to the planner.
    await upsertInstallation('project', projectDir, record);

    const plan = await buildPlan(await loadBundle(beta), 'claude-code', 'project', projectDir);
    const owned = plan.conflicts.find((conflict) => conflict.owner === 'alpha');

    expect(owned).toBeDefined();
    expect(owned?.detail).toContain('mcpServers.shared');
  });

  it('flags a JSON key already set to a different value', async () => {
    await fs.writeFile(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'alpha-server': { command: 'something-else' } } }),
    );

    const alpha = await makeBundle('alpha', 'alpha-server', 'Read(**)');
    const bundle = await loadBundle(alpha);
    const plan = await buildPlan(bundle, 'claude-code', 'project', projectDir);

    expect(plan.conflicts.some((conflict) => conflict.path === '.mcp.json')).toBe(true);
  });
});
