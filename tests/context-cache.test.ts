/**
 * The context cache under `.hcm/`, and the dry run.
 *
 * What `hcm context append|override|remove` does to `CLAUDE.md` is four case
 * folders -- `tests/cases/context-*` -- because it is a project tree and reads
 * best as one. Two things are left here because they are not:
 *
 *   - the cached copies themselves, which live under `.hcm/` and are
 *     deliberately excluded from a case's baseline tree;
 *   - `--dry-run`, whose whole assertion is that the tree did *not* change.
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

describe('append --dry-run', () => {
  it('--dry-run says what append would do without doing it', async () => {
    await install();
    await letTheAgentRewriteIt();
    const before = await readText(projectDir, 'CLAUDE.md');

    await contextAppendCommand([], { ...context(), dryRun: true });

    expect(await readText(projectDir, 'CLAUDE.md')).toBe(before);
  });
});
