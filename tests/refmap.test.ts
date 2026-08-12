/**
 * References written against the bundle's layout, rewritten to match the
 * harness's.
 *
 * Mostly end to end through `buildPlan`, because the mapping is read off the
 * plan and the thing worth proving is that it agrees with where the files
 * actually go -- a unit test with a hand-written map would prove only that the
 * rewriter can follow a map somebody made up.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { loadBundle } from '../src/core/bundle.js';
import { configureLogger } from '../src/core/logger.js';
import { buildPlan, resourceActions } from '../src/core/planner.js';
import { buildRefMap, remapReferences } from '../src/core/refmap.js';
import type { PlanAction, TargetId } from '../src/core/types.js';
import { getTarget } from '../src/targets/index.js';

let workspace: string;
let bundleDir: string;
let projectDir: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-refmap-'));
  bundleDir = path.join(workspace, 'demo-kit');
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

async function write(relativePath: string, contents: string): Promise<void> {
  const absolute = path.join(bundleDir, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, contents, 'utf8');
}

/** The bundle every test here starts from: one of each kind, pointing at each other. */
async function demoBundle(extra: Record<string, string> = {}): Promise<void> {
  await write('hcm.yaml', 'name: demo-kit\nversion: 1.0.0\n');
  await write(
    'skills/audit/SKILL.md',
    '---\ndescription: Audit.\n---\n\n' +
      'Work through `checklist.md`, then run `assets/scripts/audit.sh`.\n' +
      'See [the reviewer](subagents/code-reviewer.md).\n',
  );
  await write('skills/audit/checklist.md', '- one\n');
  await write(
    'commands/review-pr.md',
    '---\ndescription: Review.\n---\n\nFollow `skills/audit/checklist.md`.\n',
  );
  await write(
    'subagents/code-reviewer.md',
    '---\ndescription: Reviews.\n---\n\nUse `skills/audit/checklist.md`.\n',
  );
  await write('context/conventions.md', 'The checklist is `skills/audit/checklist.md`.\n');
  await write('assets/scripts/audit.sh', 'echo audit\n');

  for (const [file, contents] of Object.entries(extra)) await write(file, contents);
}

/** Plan `demo-kit` into one target and index the writes by path. */
async function planFor(target: TargetId): Promise<{
  contents: Map<string, string>;
  plan: Awaited<ReturnType<typeof buildPlan>>;
}> {
  const bundle = await loadBundle(bundleDir);
  const plan = await buildPlan(bundle, target, 'project', projectDir, {});

  const contents = new Map<string, string>();
  for (const action of plan.actions) {
    if (action.payload.kind === 'file' && typeof action.payload.contents === 'string') {
      contents.set(action.path, action.payload.contents);
    } else if (action.payload.kind === 'block') {
      contents.set(action.path, action.payload.body);
    } else if (action.payload.kind === 'json-value') {
      contents.set(action.path, JSON.stringify(action.payload.value));
    }
  }

  return { contents, plan };
}

// ---------------------------------------------------------------------------

describe('remapping on the way in', () => {
  it('rewrites a bundle-relative reference to where the file lands', async () => {
    await demoBundle();
    const { contents } = await planFor('claude-code');

    // Relative to the command file, which is what will be reading it.
    expect(contents.get('.claude/commands/review-pr.md')).toContain(
      '`../skills/audit/checklist.md`',
    );
  });

  it('leaves a reference alone when the file lands in the same directory', async () => {
    await demoBundle();
    const { contents } = await planFor('claude-code');

    // A skill's supporting file is still next to its SKILL.md, so the plain
    // relative path is still right -- and is what the harnesses document.
    expect(contents.get('.claude/skills/audit/SKILL.md')).toContain('`checklist.md`');
  });

  it('follows a resource to wherever a given harness files it', async () => {
    await demoBundle();

    // A subagent is an agent file on Claude Code and a skill on Reasonix --
    // so the same reference climbs a different number of directories in each.
    expect((await planFor('claude-code')).contents.get('.claude/skills/audit/SKILL.md')).toContain(
      '(../../agents/code-reviewer.md)',
    );
    expect(
      (await planFor('reasonix')).contents.get('.reasonix/skills/audit/SKILL.md'),
    ).toContain('(../code-reviewer/SKILL.md)');
    expect(
      (await planFor('copilot')).contents.get('.github/skills/audit/SKILL.md'),
    ).toContain('(../../agents/code-reviewer.agent.md)');
  });

  it('points a reference to a context file at the instruction file it became', async () => {
    await demoBundle({
      'commands/uses-context.md':
        '---\ndescription: x\n---\n\nRead [the conventions](context/conventions.md).\n',
    });

    // The instruction files sit at the scope root, so a command has to climb
    // out of its own directory to name one.
    expect((await planFor('claude-code')).contents.get('.claude/commands/uses-context.md')).toContain(
      '(../../CLAUDE.md)',
    );
    expect((await planFor('pi')).contents.get('.pi/prompts/uses-context.md')).toContain(
      '(../../AGENTS.md)',
    );
    expect(
      (await planFor('reasonix')).contents.get('.reasonix/commands/uses-context.md'),
    ).toContain('(../../REASONIX.md)');
  });

  it('rewrites references inside a context block too', async () => {
    await demoBundle();
    const { contents } = await planFor('claude-code');

    // CLAUDE.md is at the scope root, so relative-to-itself has nothing to
    // climb and the path reads as a rooted one.
    expect(contents.get('CLAUDE.md')).toContain('`.claude/skills/audit/checklist.md`');
  });

  it('rewrites a path in an MCP server definition', async () => {
    await demoBundle({
      'mcp/runner.json': '{ "command": "bash", "args": ["assets/scripts/audit.sh"] }',
    });

    // .mcp.json is at the scope root, so relative to it is relative to the root.
    expect((await planFor('claude-code')).contents.get('.mcp.json')).toContain(
      '.claude/scripts/audit.sh',
    );
  });

  it('makes a path in a nested config relative to that config', async () => {
    await demoBundle({
      'settings/settings.json': '{ "hooks": { "preToolUse": "assets/scripts/audit.sh" } }',
    });

    // .claude/settings.json is a directory down, so the asset beside it is
    // named from there rather than from the project root.
    expect((await planFor('claude-code')).contents.get('.claude/settings.json')).toContain(
      'scripts/audit.sh',
    );
  });

  it('leaves alone strings in a config that are not paths', async () => {
    await demoBundle({
      'mcp/runner.json': '{ "command": "bash", "args": ["-c", "echo hello"] }',
    });

    const value = (await planFor('claude-code')).contents.get('.mcp.json') as string;
    expect(JSON.parse(value)).toEqual({ command: 'bash', args: ['-c', 'echo hello'] });
  });

  it('leaves a reference to something outside the bundle exactly as written', async () => {
    await demoBundle({
      'commands/external.md':
        '---\ndescription: x\n---\n\n' +
        'See [the docs](https://example.com/x.md) and `src/index.ts` in the project.\n',
    });

    const contents = (await planFor('claude-code')).contents.get(
      '.claude/commands/external.md',
    ) as string;
    expect(contents).toContain('(https://example.com/x.md)');
    expect(contents).toContain('`src/index.ts`');
  });

  it('keeps the anchor on a reference that has one', async () => {
    await demoBundle({
      'commands/anchored.md':
        '---\ndescription: x\n---\n\nSee [step 3](skills/audit/checklist.md#step-3).\n',
    });

    expect((await planFor('claude-code')).contents.get('.claude/commands/anchored.md')).toContain(
      '(../skills/audit/checklist.md#step-3)',
    );
  });

  it('reports every rewrite on the plan', async () => {
    await demoBundle();
    const { plan } = await planFor('claude-code');

    expect(plan.references?.rewrites).toContainEqual({
      path: '.claude/commands/review-pr.md',
      from: 'skills/audit/checklist.md',
      to: '../skills/audit/checklist.md',
    });
  });

  it('is idempotent -- a remapped reference is not remapped again', async () => {
    await demoBundle();
    const bundle = await loadBundle(bundleDir);
    const plan = await buildPlan(bundle, 'claude-code', 'project', projectDir, {});

    const again = remapReferences(bundle, plan.actions);

    expect(again.rewrites).toEqual([]);
    expect(again.actions).toEqual(plan.actions);
  });
});

describe('what the plan knows', () => {
  it('maps every bundle file to the path it installs to', async () => {
    await demoBundle();
    const bundle = await loadBundle(bundleDir);
    const plan = await buildPlan(bundle, 'claude-code', 'project', projectDir, {});
    const map = buildRefMap(bundle, plan.actions);

    expect(Object.fromEntries(map.installed)).toMatchObject({
      'skills/audit/SKILL.md': '.claude/skills/audit/SKILL.md',
      'skills/audit/checklist.md': '.claude/skills/audit/checklist.md',
      'commands/review-pr.md': '.claude/commands/review-pr.md',
      'subagents/code-reviewer.md': '.claude/agents/code-reviewer.md',
      'context/conventions.md': 'CLAUDE.md',
      'assets/scripts/audit.sh': '.claude/scripts/audit.sh',
    });
  });

  it('reports a reference to a bundle file this target does not install', async () => {
    await demoBundle();
    const bundle = await loadBundle(bundleDir);

    // The actions a target with no mapping for `subagent` would produce. Built
    // from scratch rather than filtered out of a finished plan: that plan has
    // already been remapped, and there would be nothing left to notice.
    const target = getTarget('claude-code');
    const actions: PlanAction[] = bundle.resources
      .filter((resource) => resource.kind !== 'subagent')
      .flatMap((resource) => resourceActions(target, resource, bundle.manifest.name, 'project', {}));

    const report = remapReferences(bundle, actions);

    expect(report.dropped).toContainEqual({
      path: '.claude/skills/audit/SKILL.md',
      ref: 'subagents/code-reviewer.md',
      reason: 'the file it names is not installed into this harness',
    });
  });
});

describe('installed on disk', () => {
  it('writes the rewritten text, and uninstall still finds it unchanged', async () => {
    await demoBundle();

    await installCommand(bundleDir, {
      scope: 'project',
      targets: ['claude-code'],
      cwd: projectDir,
      onConflict: 'abort',
    });

    const skill = await fs.readFile(
      path.join(projectDir, '.claude', 'skills', 'audit', 'SKILL.md'),
      'utf8',
    );
    expect(skill).toContain('`checklist.md`');
    expect(skill).toContain('(../../agents/code-reviewer.md)');

    const command = await fs.readFile(
      path.join(projectDir, '.claude', 'commands', 'review-pr.md'),
      'utf8',
    );
    expect(command).toContain('`../skills/audit/checklist.md`');

    // The receipts hash what was written, not what the bundle said, so a second
    // pass sees an installation that is exactly as it left it.
    await installCommand(bundleDir, {
      scope: 'project',
      targets: ['claude-code'],
      cwd: projectDir,
      onConflict: 'abort',
    });
  });

  it('resolves what it wrote: every rewritten reference opens, from its own file', async () => {
    await demoBundle();

    await installCommand(bundleDir, {
      scope: 'project',
      targets: ['claude-code'],
      cwd: projectDir,
      onConflict: 'abort',
    });

    // The claim the whole rule rests on: take each rewritten reference, resolve
    // it against the directory of the file it was written into, and open it.
    const plan = await buildPlan(
      await loadBundle(bundleDir),
      'claude-code',
      'project',
      projectDir,
      {},
    );
    const rewrites = plan.references?.rewrites ?? [];
    expect(rewrites.length).toBeGreaterThan(0);

    for (const rewrite of rewrites) {
      const containing = path.dirname(path.join(projectDir, ...rewrite.path.split('/')));
      const resolved = path.resolve(containing, ...rewrite.to.split('#')[0]!.split('/'));
      await expect(
        fs.access(resolved),
        `${rewrite.path} says "${rewrite.to}", which should open`,
      ).resolves.toBeUndefined();
    }
  });

  it('rewrites against the harness home at user scope', async () => {
    await demoBundle();
    const home = path.join(workspace, 'pi-home');
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = home;

    try {
      const bundle = await loadBundle(bundleDir);
      const plan = await buildPlan(bundle, 'pi', 'user', projectDir, {});
      const command = plan.actions.find((action) => action.path === 'prompts/review-pr.md');

      // At user scope the root is the Pi config directory, so the layout loses
      // its `.pi/` prefix -- but a path relative to the command file is the
      // same either way, which is the point of the rule.
      expect(command?.payload.kind === 'file' && command.payload.contents).toContain(
        '`../skills/audit/checklist.md`',
      );
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});
