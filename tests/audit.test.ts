/**
 * `hcm status`, which is `auditInstallation` under the hood.
 *
 * The *consequences* of a hand-edited file -- that uninstall leaves it, that
 * `--force` takes it -- are case folders:
 * `tests/cases/hand-edited-file-blocks-uninstall/` and
 * `tests/cases/hand-edited-file-goes-with-force/`. What is left here is the
 * report itself, which produces no project tree and so has no baseline to be.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { configureLogger } from '../src/core/logger.js';
import { auditInstallation } from '../src/core/rollback.js';
import { readState } from '../src/core/state.js';
import { copyFixture, makeWorkspace } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let kit: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await makeWorkspace('audit');
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

describe('a file edited by hand after installing', () => {
  it('is reported as modified, and it alone', async () => {
    await installCommand(kit, { targets: ['claude-code'], scope: 'project', cwd: projectDir });
    await fs.appendFile(
      path.join(projectDir, '.claude', 'agents', 'code-reviewer.md'),
      '\n<!-- A note somebody added locally. -->\n',
      'utf8',
    );

    const [record] = (await readState('project', projectDir)).installations;
    if (!record) throw new Error('review-kit should be installed');
    const audit = await auditInstallation(record, projectDir);

    expect(
      audit.find((result) => result.receipt.path === '.claude/agents/code-reviewer.md')?.status,
    ).toBe('modified');
    // Everything else is still exactly as installed.
    expect(audit.filter((result) => result.status === 'modified')).toHaveLength(1);
  });
});
