/**
 * Two resources of different kinds that end up in one file.
 *
 * Most of the time a bundle's namespaces are separate: a subagent called
 * `helper` and a skill called `helper` are two files in two directories, and
 * `hcm install` writes both. On three harnesses they are not separate, because
 * the harness has fewer directories than the bundle has kinds:
 *
 *   Reasonix, Pi     a subagent *is* a Skill  -> skills/<name>/SKILL.md
 *   Copilot CLI      a command *is* a Skill   -> skills/<name>/SKILL.md
 *
 * There the second write silently overwrites the first, so the bundle is
 * refused at validation time instead -- before anything is on disk, and
 * whichever harness it is being installed into, because a bundle that cannot be
 * installed everywhere it claims to support is broken wherever it is read.
 *
 * `tests/cases/validate-names-every-mistake/` shows one of these in a whole
 * bundle alongside the other validation failures. What is here is the rule
 * itself, over the inputs that distinguish it from the ones next to it.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBundle, validateBundle } from '../src/core/bundle.js';
import { makeWorkspace } from './support/fixtures.js';

let workspace: string;

beforeEach(async () => {
  workspace = await makeWorkspace('name-collisions');
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/** A bundle made of exactly the files named, and nothing else. */
async function problemsFor(files: Record<string, string>): Promise<string[]> {
  const root = path.join(workspace, 'kit');
  const all = { 'hcm.yaml': 'name: kit\nversion: 1.0.0\n', ...files };

  for (const [relative, contents] of Object.entries(all)) {
    const target = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }

  return validateBundle(await loadBundle(root));
}

const SKILL = '---\nname: audit\ndescription: Audits dependencies\n---\n\nAudit them.\n';
const COMMAND = '---\ndescription: Reviews a pull request\n---\n\nReview it.\n';
const SUBAGENT = '---\ndescription: Reviews code\n---\n\nReview the code.\n';

describe('a command and a skill of the same name', () => {
  it('is refused, naming both files and the harness that cannot hold them', async () => {
    const problems = await problemsFor({
      'skills/audit/SKILL.md': SKILL,
      'commands/audit.md': COMMAND,
    });

    expect(problems).toEqual([
      'Command "audit" collides with the skill of the same name (skills/audit, commands/audit.md): ' +
        'Copilot CLI stores both as skills/audit/',
    ]);
  });

  it('is fine when the names differ', async () => {
    expect(
      await problemsFor({
        'skills/audit/SKILL.md': SKILL,
        'commands/review-pr.md': COMMAND,
      }),
    ).toEqual([]);
  });

  it('is fine when there is no skill to collide with', async () => {
    expect(await problemsFor({ 'commands/audit.md': COMMAND })).toEqual([]);
  });

  /**
   * A command and a *subagent* of the same name is not a collision: no harness
   * files those two in one place. Copilot CLI puts the command in `skills/` and
   * the agent in `agents/`; Reasonix and Pi put the agent in `skills/` and the
   * command in `commands/` or `prompts/`.
   */
  it('is fine beside a subagent of the same name', async () => {
    expect(
      await problemsFor({
        'commands/audit.md': COMMAND,
        'subagents/audit.md': SUBAGENT,
      }),
    ).toEqual([]);
  });
});

describe('the two collision rules together', () => {
  it('reports one problem per pair, not one per harness', async () => {
    const problems = await problemsFor({
      'skills/audit/SKILL.md': SKILL,
      'commands/audit.md': COMMAND,
      'subagents/audit.md': SUBAGENT,
    });

    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^Subagent "audit" collides .* Reasonix and Pi store both/);
    expect(problems[1]).toMatch(/^Command "audit" collides .* Copilot CLI stores both/);
  });
});
