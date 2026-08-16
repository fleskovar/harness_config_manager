/**
 * A settings array two bundles both contribute to, unwound in the *other*
 * order.
 *
 * Most of what the sprint-collection fixtures prove is a project tree, and
 * reads best as one -- the six `tests/cases/dependency-*` folders cover
 * installing the dependency, sharing its skill, `--no-deps`, orphan pruning,
 * `--keep-orphans`, the dependents guard and `--cascade`.
 *
 * This is the one that is not. Those cases all remove the *dependent* first,
 * because that is what a person does. Removing the *dependency* first, with
 * `--ignore-dependents`, exercises the same claim arithmetic from the opposite
 * end: the entry both bundles asked for has to survive on the remaining claim,
 * and the one that was the departing bundle's alone has to go. Encoding that as
 * a second nearly-identical case folder would say less than these six lines do.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { uninstallCommand } from '../src/commands/uninstall.js';
import { configureLogger } from '../src/core/logger.js';
import { copyFixture, makeWorkspace, readJson } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let collection: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await makeWorkspace('shared-settings');
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });
  collection = await copyFixture(
    'collections/sprint-collection',
    path.join(workspace, 'sprint-collection'),
  );

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

const allowList = async (): Promise<string[]> => {
  const settings = await readJson<{ permissions: { allow: string[] } }>(
    projectDir,
    '.claude/settings.json',
  );
  return settings.permissions.allow;
};

describe('the settings file the two bundles share', () => {
  it('is left holding only the other bundle’s keys, whichever goes first', async () => {
    await installCommand(path.join(collection, 'sprint-kit'), {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
    });

    // Remove the dependency (ignoring the dependent) and sprint-kit's own two
    // permissions survive -- including the one both asked for.
    await uninstallCommand('team-conventions', {
      scope: 'project',
      cwd: projectDir,
      ignoreDependents: true,
    });

    expect(await allowList()).toEqual(['Bash(git log:*)', 'Bash(npm test:*)']);
  });
});
