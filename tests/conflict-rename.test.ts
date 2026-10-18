/**
 * Renaming a resource that collides, for every kind addressed by name.
 *
 * `conflicts.test.ts` covers the MCP server, where renaming started. What is
 * here is the rest: a skill, a command and an asset install under the old name
 * plus the bundle's name as a suffix, the bundle's own instructions follow
 * them, and `hcm update` keeps the new name.
 *
 * The bundle is `kit`, so the suggestions read `audit-kit`, `review-pr-kit`
 * and `scripts/lint-kit.sh`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { updateCommand } from '../src/commands/update.js';
import { loadBundle } from '../src/core/bundle.js';
import {
  type ConflictGroup,
  type ConflictResolver,
  type Resolution,
  resolvePlanConflicts,
  seedRenames,
} from '../src/core/conflicts.js';
import { AbortedError, ConflictError } from '../src/core/errors.js';
import { applyPlan } from '../src/core/executor.js';
import { configureLogger } from '../src/core/logger.js';
import { buildPlan } from '../src/core/planner.js';
import { addToRegistry } from '../src/core/registry.js';
import { bareMatchFor, disambiguatedName, isUsableName, rewriteReferences } from '../src/core/rename.js';
import { readState } from '../src/core/state.js';
import type { InstallPlan, TargetId } from '../src/core/types.js';
import { exists, makeWorkspace, readText } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let bundleRoot: string;

const SKILL =
  '---\nname: audit\ndescription: Audits dependencies\n---\n\n' +
  'Work through `checklist.md`, then audit what is left. Run /audit again after a fix.\n';

const SUBAGENT =
  '---\ndescription: Fast recon\n---\n\n' +
  'Use the `audit` skill and read [the list](../skills/audit/checklist.md). ' +
  'Then /review-pr the change.\n';

const COMMAND =
  '---\ndescription: Reviews a pull request\n---\n\n' +
  'Review the pull request. Run /review-pr again when the author pushes.\n';

const HAND_WRITTEN = 'mine, hand written\n';

/** A bundle with one of each renamable markdown kind, an asset and settings. */
async function writeBundle(note = 'v1'): Promise<void> {
  const files: Record<string, string> = {
    'hcm.yaml': 'name: kit\nversion: 1.0.0\n',
    'skills/audit/SKILL.md': SKILL,
    'skills/audit/checklist.md': `- pin versions (${note})\n`,
    'subagents/scout.md': SUBAGENT,
    'commands/review-pr.md': COMMAND,
    'assets/scripts/lint.sh': 'echo lint\n',
    'settings/settings.json': JSON.stringify({ env: { KIT: '1' } }),
  };

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(bundleRoot, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
}

async function writeProject(relative: string, contents: string): Promise<void> {
  const target = path.join(projectDir, ...relative.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

async function plan(target: TargetId = 'claude-code'): Promise<InstallPlan> {
  return buildPlan(await loadBundle(bundleRoot), target, 'project', projectDir);
}

/** Answers "rename" with the suggested name, and records what it was asked. */
function acceptSuggestion(): ConflictResolver & { asked: ConflictGroup[] } {
  const asked: ConflictGroup[] = [];
  const resolver = async (group: ConflictGroup): Promise<Resolution> => {
    asked.push(group);
    return { choice: 'rename', newName: group.suggestedName };
  };
  return Object.assign(resolver, { asked });
}

const project = (relative: string): Promise<string> => readText(projectDir, relative);

beforeEach(async () => {
  workspace = await makeWorkspace('conflict-rename');
  projectDir = path.join(workspace, 'project');
  bundleRoot = path.join(workspace, 'kit');
  await fs.mkdir(projectDir, { recursive: true });
  await writeBundle();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('the suggested name', () => {
  it('adds the bundle name as a suffix', () => {
    expect(disambiguatedName('skill', 'audit', 'kit')).toBe('audit-kit');
    expect(disambiguatedName('command', 'review-pr', 'ts-review-kit')).toBe(
      'review-pr-ts-review-kit',
    );
  });

  it('counts up when the suffixed name is taken too', () => {
    expect(disambiguatedName('skill', 'audit-kit', 'kit')).toBe('audit-kit-2');
    expect(disambiguatedName('skill', 'audit-kit-2', 'kit')).toBe('audit-kit-3');
  });

  it('keeps the directory and the extension of an asset', () => {
    expect(disambiguatedName('asset', 'scripts/lint.sh', 'kit')).toBe('scripts/lint-kit.sh');
    expect(disambiguatedName('asset', 'Makefile', 'kit')).toBe('Makefile-kit');
  });

  it('keeps a dot in a skill name, which is not an extension', () => {
    expect(disambiguatedName('skill', 'db.audit', 'kit')).toBe('db.audit-kit');
  });

  it('accepts a path for an asset only', () => {
    expect(isUsableName('asset', 'scripts/lint-kit.sh')).toBe(true);
    expect(isUsableName('asset', '../lint.sh')).toBe(false);
    expect(isUsableName('skill', 'scripts/audit')).toBe(false);
  });
});

describe('which mentions a rename rewrites', () => {
  const action = (contents: string) => ({
    path: 'x.md',
    describe: 'x.md',
    payload: { kind: 'file' as const, contents },
  });
  const rewrite = (text: string, from: string, kind: 'skill' | 'mcp' = 'skill') =>
    (
      rewriteReferences([action(text)], from, `${from}-kit`, bareMatchFor(kind, from))
        .actions[0]?.payload as { contents: string }
    ).contents;

  it('rewrites every mention of a name with a separator', () => {
    expect(rewrite('run review-pr, then /review-pr', 'review-pr')).toBe(
      'run review-pr-kit, then /review-pr-kit',
    );
  });

  it('rewrites only the marked mentions of a one-word name', () => {
    expect(rewrite('audit it with `audit`, /audit or skills/audit/x.md', 'audit')).toBe(
      'audit it with `audit-kit`, /audit-kit or skills/audit-kit/x.md',
    );
  });

  it('keeps the wider match for a one-word MCP server name', () => {
    expect(rewrite('call the planner server', 'planner', 'mcp')).toBe(
      'call the planner-kit server',
    );
  });
});

describe('a skill that collides', () => {
  beforeEach(async () => {
    await writeProject('.claude/skills/audit/SKILL.md', HAND_WRITTEN);
  });

  it('offers rename, suggesting the bundle name as a suffix', async () => {
    const resolver = acceptSuggestion();
    await resolvePlanConflicts(await plan(), { policy: 'prompt', resolver, cwd: projectDir });

    expect(resolver.asked).toHaveLength(1);
    expect(resolver.asked[0]?.label).toBe('skill "audit"');
    expect(resolver.asked[0]?.canRename).toBe(true);
    expect(resolver.asked[0]?.suggestedName).toBe('audit-kit');
  });

  it('installs under the new name and leaves the existing one alone', async () => {
    const resolved = await resolvePlanConflicts(await plan(), {
      policy: 'prompt',
      resolver: acceptSuggestion(),
      cwd: projectDir,
    });
    await applyPlan(resolved.plan);

    expect(await project('.claude/skills/audit/SKILL.md')).toBe(HAND_WRITTEN);
    expect(await exists(projectDir, '.claude/skills/audit/checklist.md')).toBe(false);

    const skill = await project('.claude/skills/audit-kit/SKILL.md');
    expect(skill).toContain('name: audit-kit');
    // The skill's own mention of itself follows it; the English word does not.
    expect(skill).toContain('Run /audit-kit again');
    expect(skill).toContain('then audit what is left');
    expect(await project('.claude/skills/audit-kit/checklist.md')).toContain('pin versions');

    expect(resolved.renames).toEqual({ 'skill:audit': 'audit-kit' });
  });

  it('points the rest of the bundle at the new name', async () => {
    const resolved = await resolvePlanConflicts(await plan(), {
      policy: 'prompt',
      resolver: acceptSuggestion(),
      cwd: projectDir,
    });
    await applyPlan(resolved.plan);

    const agent = await project('.claude/agents/scout.md');
    expect(agent).toContain('Use the `audit-kit` skill');
    expect(agent).toContain('(../skills/audit-kit/checklist.md)');
    expect(resolved.outcomes[0]?.detail).toContain('rewrote 2 reference(s) in 1 file(s)');
  });

  it('is refused when the new name lands on another resource of the bundle', async () => {
    // On Pi a subagent is filed as a skill, so `scout` is already taken there.
    await writeProject('.pi/skills/audit/SKILL.md', HAND_WRITTEN);
    const resolver: ConflictResolver = async () => ({ choice: 'rename', newName: 'scout' });

    await expect(
      resolvePlanConflicts(await plan('pi'), { policy: 'prompt', resolver, cwd: projectDir }),
    ).rejects.toThrow(/Cannot rename skill "audit" to "scout"/);
    await expect(
      resolvePlanConflicts(await plan('pi'), { policy: 'prompt', resolver, cwd: projectDir }),
    ).rejects.toBeInstanceOf(AbortedError);
  });
});

describe('a command that collides', () => {
  it('renames the command and every slash-command mention of it', async () => {
    await writeProject('.claude/commands/review-pr.md', HAND_WRITTEN);

    const resolved = await resolvePlanConflicts(await plan(), {
      policy: 'prompt',
      resolver: acceptSuggestion(),
      cwd: projectDir,
    });
    await applyPlan(resolved.plan);

    expect(await project('.claude/commands/review-pr.md')).toBe(HAND_WRITTEN);
    expect(await project('.claude/commands/review-pr-kit.md')).toContain(
      'Run /review-pr-kit again',
    );
    expect(await project('.claude/agents/scout.md')).toContain('Then /review-pr-kit the change.');
  });
});

describe('an asset that collides', () => {
  it('keeps its directory and extension', async () => {
    await writeProject('.claude/scripts/lint.sh', 'echo theirs\n');
    const resolver = acceptSuggestion();

    const resolved = await resolvePlanConflicts(await plan(), {
      policy: 'prompt',
      resolver,
      cwd: projectDir,
    });
    await applyPlan(resolved.plan);

    expect(resolver.asked[0]?.suggestedName).toBe('scripts/lint-kit.sh');
    expect(await project('.claude/scripts/lint.sh')).toBe('echo theirs\n');
    expect(await project('.claude/scripts/lint-kit.sh')).toBe('echo lint\n');
  });
});

describe('--on-conflict rename', () => {
  it('renames every collision to the suggested name, without asking', async () => {
    await writeProject('.claude/skills/audit/SKILL.md', HAND_WRITTEN);
    await writeProject('.claude/commands/review-pr.md', HAND_WRITTEN);

    const resolved = await resolvePlanConflicts(await plan(), {
      policy: 'rename',
      cwd: projectDir,
    });
    await applyPlan(resolved.plan);

    expect(resolved.renames).toEqual({
      'skill:audit': 'audit-kit',
      'command:review-pr': 'review-pr-kit',
    });
    expect(await exists(projectDir, '.claude/skills/audit-kit/SKILL.md')).toBe(true);
    expect(await exists(projectDir, '.claude/commands/review-pr-kit.md')).toBe(true);
  });

  it('counts up when the suffixed name is taken too', async () => {
    await writeProject('.claude/skills/audit/SKILL.md', HAND_WRITTEN);
    await writeProject('.claude/skills/audit-kit/SKILL.md', HAND_WRITTEN);

    const resolved = await resolvePlanConflicts(await plan(), {
      policy: 'rename',
      cwd: projectDir,
    });

    expect(resolved.renames).toEqual({ 'skill:audit': 'audit-kit-2' });
  });

  it('stops at a collision with no name to change', async () => {
    await writeProject('.claude/settings.json', JSON.stringify({ env: { KIT: '0' } }));

    await expect(
      resolvePlanConflicts(await plan(), { policy: 'rename', cwd: projectDir }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('a rename recorded by an earlier install', () => {
  it('is applied again, collision or not', async () => {
    const decisions = new Map<string, Resolution>();
    seedRenames(decisions, 'kit', { 'skill:audit': 'audit-kit' });

    const resolved = await resolvePlanConflicts(await plan(), {
      policy: 'abort',
      decisions,
      cwd: projectDir,
    });

    expect(resolved.plan.actions.map((action) => action.path)).toContain(
      '.claude/skills/audit-kit/SKILL.md',
    );
    expect(resolved.renames).toEqual({ 'skill:audit': 'audit-kit' });
  });

  it('is kept by hcm update', async () => {
    const previousHome = process.env.HCM_HOME;
    process.env.HCM_HOME = path.join(workspace, 'home');
    delete process.env.HCM_REQUIRE_TARGET;
    configureLogger({ quiet: true });

    try {
      await addToRegistry(bundleRoot, workspace, { dev: true });
      await writeProject('.claude/skills/audit/SKILL.md', HAND_WRITTEN);

      const common = {
        targets: ['claude-code'],
        scope: 'project' as const,
        cwd: projectDir,
        prompt: false,
      };
      await installCommand('kit', { ...common, onConflict: 'rename' });

      const [installed] = (await readState('project', projectDir)).installations;
      expect(installed?.renames).toEqual({ 'skill:audit': 'audit-kit' });

      // A new version, and an update that would fail on any conflict at all.
      await writeBundle('v2');
      await updateCommand('kit', { ...common, onConflict: 'abort' });

      expect(await project('.claude/skills/audit/SKILL.md')).toBe(HAND_WRITTEN);
      expect(await project('.claude/skills/audit-kit/checklist.md')).toContain('(v2)');
      const [updated] = (await readState('project', projectDir)).installations;
      expect(updated?.renames).toEqual({ 'skill:audit': 'audit-kit' });
    } finally {
      if (previousHome === undefined) delete process.env.HCM_HOME;
      else process.env.HCM_HOME = previousHome;
      configureLogger({});
    }
  });
});
