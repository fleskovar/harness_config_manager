/**
 * Context sections surviving the agent that rewrites CLAUDE.md.
 *
 * `tests/fixtures/projects/agent-rewritten/CLAUDE.md` is the fixture: a
 * CLAUDE.md as a coding agent might leave it after rewriting the file from
 * scratch. Read it against review-kit's two `context/` files and you can say in
 * advance what `hcm context append` has to do:
 *
 *   10-conventions     gone entirely            -> append it
 *   20-pull-requests   text kept, markers lost  -> leave it alone; appending
 *                                                  would say it twice
 *
 * and that the agent's own notes have to come through all of it untouched.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  contextAppendCommand,
  contextOverrideCommand,
  contextRemoveCommand,
} from '../src/commands/context.js';
import { installCommand } from '../src/commands/install.js';
import { contextFiles, inspectContext, readContextLedger } from '../src/core/context.js';
import { configureLogger } from '../src/core/logger.js';
import { copyFixture, exists, makeWorkspace, readText } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let kit: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await makeWorkspace('context-fixture');
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

/** Drop the agent's rewrite of CLAUDE.md over the installed one. */
const letTheAgentRewriteIt = (): Promise<string> =>
  copyFixture('projects/agent-rewritten', projectDir);

/** The options every `hcm context` subcommand takes. A function, because
 * `projectDir` is a fresh directory per test. */
const context = (): { scope: 'project'; cwd: string } => ({ scope: 'project', cwd: projectDir });

/** What the file says about each section right now, ignoring the ledger. */
async function presence(): Promise<Record<string, string>> {
  const [file] = await contextFiles('project', projectDir);
  if (!file) throw new Error('nothing tracked');
  const inspected = await inspectContext(file);
  return Object.fromEntries(inspected.map((row) => [row.item.section.name, row.presence]));
}

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

// ---------------------------------------------------------------------------

describe('what installing caches', () => {
  it('keeps a copy of each context section under .hcm', async () => {
    await install();

    expect(await exists(projectDir, '.hcm/context/review-kit/10-conventions.md')).toBe(true);
    expect(await exists(projectDir, '.hcm/context/review-kit/20-pull-requests.md')).toBe(true);

    const ledger = await readContextLedger('project', projectDir);
    expect(ledger.sections.map((section) => section.name)).toEqual([
      '10-conventions',
      '20-pull-requests',
    ]);
    // Filename order is section order -- that is what the numeric prefixes buy.
    expect(ledger.sections.map((section) => section.order)).toEqual([0, 1]);
    expect(ledger.sections[0]?.placements).toEqual([
      expect.objectContaining({
        target: 'claude-code',
        path: 'CLAUDE.md',
        blockId: 'review-kit/10-conventions',
      }),
    ]);
  });
});

describe('after the agent rewrites CLAUDE.md', () => {
  it('one section is gone and the other survived without its markers', async () => {
    await install();
    await letTheAgentRewriteIt();

    expect(await presence()).toEqual({
      '10-conventions': 'absent',
      '20-pull-requests': 'unmarked',
    });
  });

  it('append puts back only what is missing', async () => {
    await install();
    await letTheAgentRewriteIt();

    await contextAppendCommand([], context());

    const claudeMd = await readText(projectDir, 'CLAUDE.md');

    // The missing section is back, inside its markers.
    expect(claudeMd).toContain('<!-- hcm:begin review-kit/10-conventions -->');
    expect(claudeMd).toContain('## Review conventions');

    // The unmarked one was left exactly as the agent left it -- said once, not twice.
    expect(occurrences(claudeMd, '## Pull requests')).toBe(1);
    expect(claudeMd).not.toContain('<!-- hcm:begin review-kit/20-pull-requests -->');

    // And the agent's own notes are untouched.
    expect(claudeMd).toContain('- The build is `npm run build`; the tests are `npm test`.');
    expect(claudeMd).toContain('`src/server/` is the API');
  });

  it('append is idempotent: running it again changes nothing', async () => {
    await install();
    await letTheAgentRewriteIt();

    await contextAppendCommand([], context());
    const afterFirst = await readText(projectDir, 'CLAUDE.md');
    await contextAppendCommand([], context());

    expect(await readText(projectDir, 'CLAUDE.md')).toBe(afterFirst);
  });

  it('--dry-run says what append would do without doing it', async () => {
    await install();
    await letTheAgentRewriteIt();
    const before = await readText(projectDir, 'CLAUDE.md');

    await contextAppendCommand([], { ...context(), dryRun: true });

    expect(await readText(projectDir, 'CLAUDE.md')).toBe(before);
  });

  it('override throws the rewrite away and lays the sections down in order', async () => {
    await install();
    await letTheAgentRewriteIt();

    // --force stands in for answering "yes, discard those lines".
    await contextOverrideCommand([], { ...context(), force: true });

    const claudeMd = await readText(projectDir, 'CLAUDE.md');
    expect(claudeMd).not.toContain('- The build is `npm run build`');
    expect(claudeMd.indexOf('## Review conventions')).toBeLessThan(
      claudeMd.indexOf('## Pull requests'),
    );
    expect(await presence()).toEqual({
      '10-conventions': 'present',
      '20-pull-requests': 'present',
    });
  });
});

describe('taking the sections out and putting them back', () => {
  it('remove keeps the cached copies, so append can restore them', async () => {
    await install();

    await contextRemoveCommand([], context());

    // CLAUDE.md held nothing else, so it went with the last block.
    expect(await exists(projectDir, 'CLAUDE.md')).toBe(false);
    expect(await exists(projectDir, '.hcm/context/review-kit/10-conventions.md')).toBe(true);

    await contextAppendCommand([], context());

    const claudeMd = await readText(projectDir, 'CLAUDE.md');
    expect(claudeMd).toContain('## Review conventions');
    expect(claudeMd).toContain('## Pull requests');
    expect(await presence()).toEqual({
      '10-conventions': 'present',
      '20-pull-requests': 'present',
    });
  });
});
