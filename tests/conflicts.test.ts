/**
 * What happens when the thing we are about to install is already there.
 *
 * Two separate questions, and they get separate answers:
 *   identical  -> adopt it: install proceeds, uninstall leaves it behind
 *   different  -> ask: skip, overwrite, rename (MCP only), or abort
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBundle } from '../src/core/bundle.js';
import {
  type ConflictGroup,
  type ConflictResolver,
  type Resolution,
  resolvePlanConflicts,
} from '../src/core/conflicts.js';
import { AbortedError, ConflictError } from '../src/core/errors.js';
import { applyPlan } from '../src/core/executor.js';
import { buildPlan } from '../src/core/planner.js';
import { rewriteReferences } from '../src/core/rename.js';
import { rollback } from '../src/core/rollback.js';
import { upsertInstallation } from '../src/core/state.js';
import {
  installationId,
  type InstallationRecord,
  type InstallPlan,
  type TargetId,
} from '../src/core/types.js';

let workspace: string;
let projectDir: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-conflict-'));
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

const SERVER = { command: 'light-plan', args: ['--serve'] };

/**
 * A bundle with one MCP server and instructions that name it -- the shape that
 * makes renaming interesting.
 */
async function makeBundle(name = 'planner', server = 'light-plan'): Promise<string> {
  const root = path.join(workspace, name);

  const files: Record<string, string> = {
    'hcm.yaml': `name: ${name}\nversion: 1.0.0\ndescription: test bundle\n`,
    [`mcp/${server}.json`]: JSON.stringify(SERVER),
    'subagents/planner.md':
      `---\ndescription: Plans work\ntools: [Read, mcp__${server}__create_plan]\n---\n\n` +
      `Call the ${server} server. Do not confuse it with ${server}-legacy or my${server}.\n`,
    'context/usage.md': `Use \`${server}\` for planning.\n`,
  };

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }

  return root;
}

async function plan(bundleRoot: string, target: TargetId = 'claude-code'): Promise<InstallPlan> {
  return buildPlan(await loadBundle(bundleRoot), target, 'project', projectDir);
}

async function record(built: InstallPlan, bundleRoot: string): Promise<InstallationRecord> {
  const receipts = await applyPlan(built);
  const entry: InstallationRecord = {
    id: installationId(built.bundle.manifest.name, built.target, 'project'),
    bundle: built.bundle.manifest.name,
    version: built.bundle.manifest.version,
    target: built.target,
    scope: 'project',
    source: { type: 'local', path: bundleRoot },
    installedAt: new Date().toISOString(),
    receipts,
  };
  await upsertInstallation('project', projectDir, entry);
  return entry;
}

const writeJson = async (relative: string, value: unknown): Promise<void> => {
  const target = path.join(projectDir, ...relative.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(value, null, 2));
};

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

/** A resolver that answers from a script, and records what it was asked. */
function scripted(answers: Record<string, Resolution>): ConflictResolver & { asked: ConflictGroup[] } {
  const asked: ConflictGroup[] = [];
  const resolver = async (group: ConflictGroup): Promise<Resolution> => {
    asked.push(group);
    const answer = answers[group.key];
    if (!answer) throw new Error(`unexpected question about ${group.key}`);
    return answer;
  };
  return Object.assign(resolver, { asked });
}

const resolve = (built: InstallPlan, resolver: ConflictResolver) =>
  resolvePlanConflicts(built, { policy: 'prompt', resolver, cwd: projectDir });

// ---------------------------------------------------------------------------

describe('an MCP server that is already configured, identically', () => {
  it('is adopted, not reported as a conflict', async () => {
    await writeJson('.mcp.json', { mcpServers: { 'light-plan': SERVER } });

    const built = await plan(await makeBundle());

    expect(built.conflicts).toEqual([]);
    const mcpAction = built.actions.find((action) => action.path === '.mcp.json');
    expect(mcpAction?.adopt).toBe(true);
  });

  it('leaves the file untouched, formatting and all', async () => {
    const original = '{\n    "mcpServers": {\n        "light-plan": {\n' +
      '            "command": "light-plan",\n            "args": [\n' +
      '                "--serve"\n            ]\n        }\n    }\n}';
    await fs.writeFile(path.join(projectDir, '.mcp.json'), original);

    const bundleRoot = await makeBundle();
    await record(await plan(bundleRoot), bundleRoot);

    expect(await readText('.mcp.json')).toBe(original);
  });

  it('survives uninstall, because the bundle did not put it there', async () => {
    await writeJson('.mcp.json', { mcpServers: { 'light-plan': SERVER } });

    const bundleRoot = await makeBundle();
    const entry = await record(await plan(bundleRoot), bundleRoot);

    const results = await rollback(entry, projectDir);
    const mcp = results.find((result) => result.receipt.path === '.mcp.json');

    expect(mcp?.status).toBe('kept');
    expect((await readJson('.mcp.json')).mcpServers).toEqual({ 'light-plan': SERVER });
    // Everything the bundle really did write is still removed.
    expect(await exists('.claude/agents/planner.md')).toBe(false);
  });

  it('stays adopted across a reinstall', async () => {
    await writeJson('.mcp.json', { mcpServers: { 'light-plan': SERVER } });

    const bundleRoot = await makeBundle();
    await record(await plan(bundleRoot), bundleRoot);
    const second = await record(await plan(bundleRoot), bundleRoot);

    const mcp = second.receipts.find((receipt) => receipt.path === '.mcp.json');
    expect(mcp?.op === 'json-value' && mcp.preexisting).toBe(true);

    await rollback(second, projectDir);
    expect((await readJson('.mcp.json')).mcpServers).toEqual({ 'light-plan': SERVER });
  });

  it('does not stop another bundle from adopting the same server', async () => {
    await writeJson('.mcp.json', { mcpServers: { 'light-plan': SERVER } });

    const first = await makeBundle('planner');
    await record(await plan(first), first);

    // A second bundle shipping the same server sees no owner to collide with.
    // (Its subagent does collide -- both fixtures ship one called "planner",
    // and this one's says something else -- which is exactly the contrast:
    // written items are owned, adopted ones are not.)
    const secondRoot = await makeBundle('scheduler');
    await fs.writeFile(
      path.join(secondRoot, 'subagents', 'planner.md'),
      '---\ndescription: Schedules work\n---\n\nA different prompt entirely.\n',
    );
    const second = await plan(secondRoot);

    expect(second.conflicts.map((conflict) => conflict.path)).toEqual([
      '.claude/agents/planner.md',
    ]);
    expect(second.actions.find((action) => action.path === '.mcp.json')?.adopt).toBe(true);
  });

  it('adopts an identical binary asset, comparing bytes not text', async () => {
    // Bytes that do not survive a round trip through UTF-8.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
    const bundleRoot = await makeBundle();
    await fs.mkdir(path.join(bundleRoot, 'assets'), { recursive: true });
    await fs.writeFile(path.join(bundleRoot, 'assets', 'logo.png'), bytes);

    await fs.mkdir(path.join(projectDir, '.claude'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.claude', 'logo.png'), bytes);

    const built = await plan(bundleRoot);
    const asset = built.actions.find((action) => action.path === '.claude/logo.png');

    expect(built.conflicts).toEqual([]);
    expect(asset?.adopt).toBe(true);
  });

  it('still owns what it actually wrote', async () => {
    await writeJson('.mcp.json', { mcpServers: { 'light-plan': SERVER } });

    const bundleRoot = await makeBundle();
    const entry = await record(await plan(bundleRoot), bundleRoot);

    const agent = entry.receipts.find((receipt) => receipt.path === '.claude/agents/planner.md');
    expect(agent?.op === 'file' && agent.preexisting).toBeUndefined();
  });
});

describe('an MCP server that is already configured, differently', () => {
  const different = { mcpServers: { 'light-plan': { command: 'something-else' } } };

  it('is offered as a four-way choice', async () => {
    await writeJson('.mcp.json', different);
    const built = await plan(await makeBundle());
    const resolver = scripted({ 'mcp:light-plan': { choice: 'skip' } });

    await resolve(built, resolver);

    expect(resolver.asked).toHaveLength(1);
    expect(resolver.asked[0]?.canRename).toBe(true);
    expect(resolver.asked[0]?.label).toBe('mcp "light-plan"');
    expect(resolver.asked[0]?.suggestedName).toBe('planner-light-plan');
  });

  it('skip installs everything else and leaves the server alone', async () => {
    await writeJson('.mcp.json', different);
    const bundleRoot = await makeBundle();
    const resolved = await resolve(
      await plan(bundleRoot),
      scripted({ 'mcp:light-plan': { choice: 'skip' } }),
    );

    expect(resolved.plan.actions.some((action) => action.path === '.mcp.json')).toBe(false);
    await applyPlan(resolved.plan);

    expect((await readJson('.mcp.json')).mcpServers).toEqual({
      'light-plan': { command: 'something-else' },
    });
    expect(await exists('.claude/agents/planner.md')).toBe(true);
  });

  it('overwrite replaces it, and uninstall puts the old value back', async () => {
    await writeJson('.mcp.json', different);
    const bundleRoot = await makeBundle();
    const resolved = await resolve(
      await plan(bundleRoot),
      scripted({ 'mcp:light-plan': { choice: 'overwrite' } }),
    );
    const entry = await record(resolved.plan, bundleRoot);

    expect((await readJson('.mcp.json')).mcpServers).toEqual({ 'light-plan': SERVER });

    await rollback(entry, projectDir);
    expect((await readJson('.mcp.json')).mcpServers).toEqual({
      'light-plan': { command: 'something-else' },
    });
  });

  it('abort stops the run with nothing written', async () => {
    await writeJson('.mcp.json', different);
    const built = await plan(await makeBundle());

    await expect(resolve(built, scripted({ 'mcp:light-plan': { choice: 'abort' } }))).rejects.toBeInstanceOf(
      AbortedError,
    );
    expect(await exists('.claude/agents/planner.md')).toBe(false);
  });

  it('rename installs under the new name and repoints the instructions', async () => {
    await writeJson('.mcp.json', different);
    const bundleRoot = await makeBundle();
    const resolved = await resolve(
      await plan(bundleRoot),
      scripted({ 'mcp:light-plan': { choice: 'rename', newName: 'planner-light-plan' } }),
    );
    await applyPlan(resolved.plan);

    const servers = (await readJson('.mcp.json')).mcpServers as Record<string, unknown>;
    expect(servers['planner-light-plan']).toEqual(SERVER);
    // The one that was already there is untouched.
    expect(servers['light-plan']).toEqual({ command: 'something-else' });

    const agent = await readText('.claude/agents/planner.md');
    expect(agent).toContain('mcp__planner-light-plan__create_plan');
    expect(agent).toContain('Call the planner-light-plan server.');
    // Longer names that merely start with the old one are left alone.
    expect(agent).toContain('light-plan-legacy');
    expect(agent).toContain('mylight-plan');

    expect(await readText('CLAUDE.md')).toContain('`planner-light-plan`');

    expect(resolved.outcomes[0]?.choice).toBe('rename');
    expect(resolved.outcomes[0]?.detail).toContain('rewrote');
  });

  it('renaming onto another taken name asks again', async () => {
    await writeJson('.mcp.json', {
      mcpServers: {
        'light-plan': { command: 'something-else' },
        'planner-light-plan': { command: 'also-taken' },
      },
    });

    const answers: Resolution[] = [
      { choice: 'rename', newName: 'planner-light-plan' },
      { choice: 'rename', newName: 'planner-light-plan-2' },
    ];
    let asked = 0;
    const resolver: ConflictResolver = async () => answers[asked++]!;

    const resolved = await resolve(await plan(await makeBundle()), resolver);
    await applyPlan(resolved.plan);

    expect(asked).toBe(2);
    const servers = (await readJson('.mcp.json')).mcpServers as Record<string, unknown>;
    expect(servers['planner-light-plan-2']).toEqual(SERVER);
    expect(servers['planner-light-plan']).toEqual({ command: 'also-taken' });
  });

  it('renames in the reasonix [[plugins]] table too, without touching its command', async () => {
    await fs.writeFile(
      path.join(projectDir, 'reasonix.toml'),
      '[[plugins]]\nname = "light-plan"\ncommand = "someone-elses"\n',
    );

    const resolved = await resolve(
      await plan(await makeBundle(), 'reasonix'),
      scripted({ 'mcp:light-plan': { choice: 'rename', newName: 'planner-light-plan' } }),
    );
    await applyPlan(resolved.plan);

    const toml = await readText('reasonix.toml');
    expect(toml).toContain('name = "planner-light-plan"');
    // The renamed server still launches the same executable.
    expect(toml).toContain('command = "light-plan"');
    expect(toml).toContain('command = "someone-elses"');
  });
});

describe('a skill or subagent that is already there', () => {
  it('offers skip, overwrite and abort but not rename', async () => {
    const bundleRoot = await makeBundle();
    await fs.mkdir(path.join(projectDir, '.claude', 'agents'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.claude/agents/planner.md'), 'mine, hand written\n');

    const built = await plan(bundleRoot);
    const resolver = scripted({ 'subagent:planner': { choice: 'skip' } });
    await resolve(built, resolver);

    expect(resolver.asked[0]?.canRename).toBe(false);
    expect(resolver.asked[0]?.label).toBe('subagent "planner"');
  });

  it('skip keeps the hand-written one', async () => {
    const bundleRoot = await makeBundle();
    await fs.mkdir(path.join(projectDir, '.claude', 'agents'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.claude/agents/planner.md'), 'mine, hand written\n');

    const resolved = await resolve(
      await plan(bundleRoot),
      scripted({ 'subagent:planner': { choice: 'skip' } }),
    );
    await applyPlan(resolved.plan);

    expect(await readText('.claude/agents/planner.md')).toBe('mine, hand written\n');
    // The rest of the bundle still installed.
    expect(await exists('.mcp.json')).toBe(true);
  });

  it('overwrite replaces it', async () => {
    const bundleRoot = await makeBundle();
    await fs.mkdir(path.join(projectDir, '.claude', 'agents'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.claude/agents/planner.md'), 'mine, hand written\n');

    const resolved = await resolve(
      await plan(bundleRoot),
      scripted({ 'subagent:planner': { choice: 'overwrite' } }),
    );
    await applyPlan(resolved.plan);

    expect(await readText('.claude/agents/planner.md')).toContain('Plans work');
  });

  it('skipping one file of a skill skips the whole skill', async () => {
    const bundleRoot = await makeBundle();
    const skill = path.join(bundleRoot, 'skills', 'planning');
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, 'SKILL.md'), '---\ndescription: Plan\n---\n\nPlan it.\n');
    await fs.writeFile(path.join(skill, 'template.md'), 'a template\n');

    const installed = path.join(projectDir, '.claude', 'skills', 'planning');
    await fs.mkdir(installed, { recursive: true });
    await fs.writeFile(path.join(installed, 'SKILL.md'), 'a different skill\n');

    const resolved = await resolve(
      await plan(bundleRoot),
      scripted({ 'skill:planning': { choice: 'skip' } }),
    );
    await applyPlan(resolved.plan);

    // Neither file lands: half a skill is worse than none.
    expect(await readText('.claude/skills/planning/SKILL.md')).toBe('a different skill\n');
    expect(await exists('.claude/skills/planning/template.md')).toBe(false);
  });
});

describe('policies for when nobody can be asked', () => {
  const different = { mcpServers: { 'light-plan': { command: 'something-else' } } };

  it('abort is an error listing the conflicts', async () => {
    await writeJson('.mcp.json', different);
    const built = await plan(await makeBundle());

    await expect(
      resolvePlanConflicts(built, { policy: 'abort', cwd: projectDir }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('skip and overwrite need no resolver', async () => {
    await writeJson('.mcp.json', different);

    const skipped = await resolvePlanConflicts(await plan(await makeBundle()), {
      policy: 'skip',
      cwd: projectDir,
    });
    expect(skipped.plan.actions.some((action) => action.path === '.mcp.json')).toBe(false);

    const forced = await resolvePlanConflicts(await plan(await makeBundle()), {
      policy: 'overwrite',
      cwd: projectDir,
    });
    expect(forced.plan.actions.some((action) => action.path === '.mcp.json')).toBe(true);
  });
});

describe('remembering answers across targets', () => {
  it('asks once for a bundle installed into two harnesses', async () => {
    await writeJson('.mcp.json', { mcpServers: { 'light-plan': { command: 'something-else' } } });
    await fs.writeFile(
      path.join(projectDir, 'reasonix.toml'),
      '[[plugins]]\nname = "light-plan"\ncommand = "someone-elses"\n',
    );

    const bundleRoot = await makeBundle();
    const decisions = new Map<string, Resolution>();
    const resolver = scripted({
      'mcp:light-plan': { choice: 'rename', newName: 'planner-light-plan' },
    });

    for (const target of ['claude-code', 'reasonix'] as TargetId[]) {
      const resolved = await resolvePlanConflicts(await plan(bundleRoot, target), {
        policy: 'prompt',
        resolver,
        decisions,
        cwd: projectDir,
      });
      await applyPlan(resolved.plan);
    }

    expect(resolver.asked).toHaveLength(1);
    expect((await readJson('.mcp.json')).mcpServers).toHaveProperty('planner-light-plan');
    expect(await readText('reasonix.toml')).toContain('name = "planner-light-plan"');
  });

  it('carries a rename into a harness that had no collision of its own', async () => {
    // Only Claude Code has the clashing server; Reasonix is untouched.
    await writeJson('.mcp.json', { mcpServers: { 'light-plan': { command: 'something-else' } } });

    const bundleRoot = await makeBundle();
    const decisions = new Map<string, Resolution>();
    const resolver = scripted({
      'mcp:light-plan': { choice: 'rename', newName: 'planner-light-plan' },
    });

    for (const target of ['claude-code', 'reasonix'] as TargetId[]) {
      const resolved = await resolvePlanConflicts(await plan(bundleRoot, target), {
        policy: 'prompt',
        resolver,
        decisions,
        cwd: projectDir,
      });
      await applyPlan(resolved.plan);
    }

    // One name across both harnesses, and both sets of instructions agree.
    expect(await readText('reasonix.toml')).toContain('name = "planner-light-plan"');
    expect(await readText('REASONIX.md')).toContain('`planner-light-plan`');
    expect(await readText('CLAUDE.md')).toContain('`planner-light-plan`');
  });

  it('keeps two bundles that ship the same name apart', async () => {
    await writeJson('.mcp.json', { mcpServers: { 'light-plan': { command: 'something-else' } } });

    const decisions = new Map<string, Resolution>();
    const first = await makeBundle('planner');
    const second = await makeBundle('scheduler');

    const asked: string[] = [];
    const resolver: ConflictResolver = async (group) => {
      asked.push(group.label);
      // Skip everything; the point is only that both bundles get asked.
      return { choice: 'skip' };
    };

    for (const bundleRoot of [first, second]) {
      await resolvePlanConflicts(await plan(bundleRoot), {
        policy: 'prompt',
        resolver,
        decisions,
        cwd: projectDir,
      });
    }

    expect(asked).toEqual(['mcp "light-plan"', 'mcp "light-plan"']);
  });
});

describe('rewriteReferences', () => {
  const action = (contents: string) => ({
    path: 'x.md',
    describe: 'x.md',
    payload: { kind: 'file' as const, contents },
  });

  it('rewrites the tool namespace and the bare name', () => {
    const result = rewriteReferences([action('mcp__old__go and old itself')], 'old', 'new');
    expect((result.actions[0]?.payload as { contents: string }).contents).toBe(
      'mcp__new__go and new itself',
    );
    expect(result.total).toBe(2);
  });

  it('leaves longer names that merely contain it alone', () => {
    const result = rewriteReferences([action('old-timer myold old_field')], 'old', 'new');
    expect((result.actions[0]?.payload as { contents: string }).contents).toBe(
      'old-timer myold old_field',
    );
    expect(result.total).toBe(0);
  });

  it('handles a name with regex characters in it', () => {
    const result = rewriteReferences([action('use a.b here')], 'a.b', 'c');
    expect((result.actions[0]?.payload as { contents: string }).contents).toBe('use c here');
  });

  it('does not touch binary payloads', () => {
    const bytes = Buffer.from('old');
    const result = rewriteReferences(
      [{ path: 'logo.png', describe: 'logo.png', payload: { kind: 'file', contents: bytes } }],
      'old',
      'new',
    );
    expect((result.actions[0]?.payload as { contents: Buffer }).contents).toBe(bytes);
  });
});
