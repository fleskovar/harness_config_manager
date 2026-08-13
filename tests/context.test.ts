/**
 * The context cache: install a bundle, let something else rewrite CLAUDE.md the
 * way an agent would, and put the sections back.
 *
 * These go through the command layer rather than the core functions, because
 * what is being tested is the whole loop -- install captures, the commands
 * restore, and the install ledger stays honest about what is where.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  contextAppendCommand,
  contextOverrideCommand,
  contextRemoveCommand,
} from '../src/commands/context.js';
import { installCommand } from '../src/commands/install.js';
import { uninstallCommand } from '../src/commands/uninstall.js';
import { contextFiles, readContextLedger } from '../src/core/context.js';
import { configureLogger } from '../src/core/logger.js';
import { auditInstallation } from '../src/core/rollback.js';
import { readState } from '../src/core/state.js';
import type { Scope, TargetId } from '../src/core/types.js';

let workspace: string;
let projectDir: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-context-'));
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });

  // Keep the registry, store and user-scope state inside the workspace, so a
  // test never reads or writes the machine's real ~/.hcm.
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

/** A bundle whose context is split into two sections, as the feature intends. */
async function makeBundle(name: string, sections: Record<string, string>): Promise<string> {
  const root = path.join(workspace, name);
  const files: Record<string, string> = {
    'hcm.yaml': `name: ${name}\nversion: 1.0.0\ndescription: test bundle\n`,
    ...Object.fromEntries(
      Object.entries(sections).map(([file, body]) => [`context/${file}`, body]),
    ),
  };

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }

  return root;
}

const TWO_SECTIONS = {
  '10-conventions.md':
    '## Conventions\n\n- Every behavioural change needs a test that fails without it.\n- Prefer fixing the root cause over widening a type.\n',
  '20-workflow.md':
    '## Workflow\n\n- Run the checks before saying a change is done.\n- Never describe a red suite as passing.\n',
};

async function install(root: string, targets: TargetId[] = ['claude-code']): Promise<void> {
  await installCommand(root, { targets, scope: 'project', cwd: projectDir, onConflict: 'abort' });
}

const options = (extra: Record<string, unknown> = {}) => ({
  scope: 'project' as Scope,
  cwd: projectDir,
  ...extra,
});

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

/** What `hcm status` would say about the sections: nothing missing is green. */
async function driftedItems(): Promise<number> {
  const state = await readState('project', projectDir);
  let drifted = 0;
  for (const record of state.installations) {
    const results = await auditInstallation(record, projectDir);
    drifted += results.filter(
      (result) => result.status === 'missing' || result.status === 'modified',
    ).length;
  }
  return drifted;
}

describe('capturing context on install', () => {
  it('caches every section and where it went', async () => {
    await install(await makeBundle('alpha', TWO_SECTIONS));

    const ledger = await readContextLedger('project', projectDir);
    expect(ledger.sections.map((section) => section.name)).toEqual([
      '10-conventions',
      '20-workflow',
    ]);
    // The order is the order of the files, which is what the numbering is for.
    expect(ledger.sections.map((section) => section.order)).toEqual([0, 1]);
    expect(ledger.sections[0]?.placements).toEqual([
      {
        target: 'claude-code',
        path: 'CLAUDE.md',
        blockId: 'alpha/10-conventions',
        updatedAt: expect.any(String),
      },
    ]);

    expect(await readText('.hcm/context/alpha/10-conventions.md')).toContain('## Conventions');
    expect(await readText('.hcm/context/alpha/20-workflow.md')).toContain('## Workflow');
  });

  it('records one placement per target, and groups the shared file once', async () => {
    // OpenCode and Pi both write AGENTS.md; the section belongs there once.
    await install(await makeBundle('alpha', TWO_SECTIONS), ['opencode', 'pi']);

    const ledger = await readContextLedger('project', projectDir);
    expect(ledger.sections[0]?.placements.map((placement) => placement.target)).toEqual([
      'opencode',
      'pi',
    ]);

    const files = await contextFiles('project', projectDir);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('AGENTS.md');
    expect(files[0]?.items).toHaveLength(2);
    // One block, owned by both installations.
    expect(files[0]?.targets).toEqual(['opencode', 'pi']);
    expect(files[0]?.items[0]?.targets).toEqual(['opencode', 'pi']);
  });

  it('moves both installations’ receipts when a shared file changes', async () => {
    await install(await makeBundle('alpha', TWO_SECTIONS), ['opencode', 'pi']);
    expect(await driftedItems()).toBe(0);

    // Removing the block takes it away from OpenCode and Pi alike, so neither
    // installation should be left claiming it. Two harnesses share this file,
    // so the command has to say which it means: `all` is how you mean both.
    await contextRemoveCommand([], options({ targets: ['all'] }));
    expect(await driftedItems()).toBe(0);

    const state = await readState('project', projectDir);
    for (const record of state.installations) {
      expect(record.receipts.filter((receipt) => receipt.op === 'block')).toEqual([]);
    }

    await contextAppendCommand([], options({ targets: ['all'] }));
    expect(await driftedItems()).toBe(0);
    const after = await readState('project', projectDir);
    for (const record of after.installations) {
      expect(record.receipts.filter((receipt) => receipt.op === 'block')).toHaveLength(2);
    }
  });

  it('forgets the cache when the bundle is uninstalled', async () => {
    await install(await makeBundle('alpha', TWO_SECTIONS));
    await uninstallCommand('alpha', { scope: 'project', cwd: projectDir });

    expect((await readContextLedger('project', projectDir)).sections).toEqual([]);
    expect(await exists('.hcm/context/alpha/10-conventions.md')).toBe(false);
  });
});

describe('hcm context append', () => {
  it('puts the sections back after an agent rewrites the file', async () => {
    await install(await makeBundle('alpha', TWO_SECTIONS));

    // The agent rewrites CLAUDE.md from scratch, markers and all.
    await fs.writeFile(
      path.join(projectDir, 'CLAUDE.md'),
      '# Project notes\n\nThis is a TypeScript CLI. Build with npm run build.\n',
    );
    expect(await driftedItems()).toBe(2);

    await contextAppendCommand([], options());

    const claudeMd = await readText('CLAUDE.md');
    expect(claudeMd).toContain('This is a TypeScript CLI.');
    expect(claudeMd).toContain('<!-- hcm:begin alpha/10-conventions -->');
    expect(claudeMd).toContain('Never describe a red suite as passing.');
    // Sections are back where the receipts say they are, so status is green.
    expect(await driftedItems()).toBe(0);
  });

  it('is idempotent, and leaves an edited section alone', async () => {
    await install(await makeBundle('alpha', TWO_SECTIONS));

    await contextAppendCommand([], options());
    await contextAppendCommand([], options());

    const claudeMd = await readText('CLAUDE.md');
    expect(claudeMd.match(/hcm:begin alpha\/10-conventions/g)).toHaveLength(1);

    // A hand edit inside the markers survives an append...
    await fs.writeFile(
      path.join(projectDir, 'CLAUDE.md'),
      claudeMd.replace('- Prefer fixing the root cause over widening a type.', '- Edited by hand.'),
    );
    await contextAppendCommand([], options());
    expect(await readText('CLAUDE.md')).toContain('- Edited by hand.');

    // ...and --force is how you put the bundle's own text back.
    await contextAppendCommand([], options({ force: true }));
    const forced = await readText('CLAUDE.md');
    expect(forced).not.toContain('- Edited by hand.');
    expect(forced).toContain('- Prefer fixing the root cause over widening a type.');
    expect(forced.match(/hcm:begin alpha\/10-conventions/g)).toHaveLength(1);
  });

  it('does not duplicate a section the agent kept but unwrapped', async () => {
    await install(await makeBundle('alpha', TWO_SECTIONS));

    // The rewrite dropped the markers but folded one section's text back in.
    await fs.writeFile(
      path.join(projectDir, 'CLAUDE.md'),
      `# Project notes\n\n${TWO_SECTIONS['10-conventions.md']}\n`,
    );

    await contextAppendCommand([], options());

    const claudeMd = await readText('CLAUDE.md');
    expect(claudeMd.match(/Every behavioural change needs a test/g)).toHaveLength(1);
    expect(claudeMd).not.toContain('hcm:begin alpha/10-conventions');
    // The section that really was gone came back.
    expect(claudeMd).toContain('<!-- hcm:begin alpha/20-workflow -->');
  });

  it('acts only on the bundles named', async () => {
    await install(await makeBundle('alpha', TWO_SECTIONS));
    await install(await makeBundle('beta', { 'notes.md': '## Beta\n\nBeta instructions here.\n' }));

    await fs.writeFile(path.join(projectDir, 'CLAUDE.md'), '# Rewritten\n');
    await contextAppendCommand(['beta'], options());

    const claudeMd = await readText('CLAUDE.md');
    expect(claudeMd).toContain('Beta instructions here.');
    expect(claudeMd).not.toContain('hcm:begin alpha/');
  });

  it('rejects a bundle it is not tracking', async () => {
    await install(await makeBundle('alpha', TWO_SECTIONS));
    await expect(contextAppendCommand(['nope'], options())).rejects.toThrow(
      /No context is tracked for: nope/,
    );
  });

  it('writes nothing on --dry-run', async () => {
    await install(await makeBundle('alpha', TWO_SECTIONS));
    await fs.writeFile(path.join(projectDir, 'CLAUDE.md'), '# Rewritten\n');

    await contextAppendCommand([], options({ dryRun: true }));
    expect(await readText('CLAUDE.md')).toBe('# Rewritten\n');
  });
});

describe('hcm context override', () => {
  it('replaces the file with the sections, in order', async () => {
    await install(await makeBundle('alpha', TWO_SECTIONS));
    await fs.writeFile(
      path.join(projectDir, 'CLAUDE.md'),
      '# Notes the agent invented\n\nLots of stale detail.\n',
    );

    await contextOverrideCommand([], options({ force: true }));

    const claudeMd = await readText('CLAUDE.md');
    expect(claudeMd).not.toContain('Lots of stale detail.');
    expect(claudeMd.indexOf('alpha/10-conventions')).toBeLessThan(
      claudeMd.indexOf('alpha/20-workflow'),
    );
    expect(await driftedItems()).toBe(0);
  });

  it('keeps blocks other bundles own', async () => {
    // Pi folds rules into AGENTS.md next to context, so override must not eat them.
    const alpha = await makeBundle('alpha', TWO_SECTIONS);
    await fs.mkdir(path.join(alpha, 'rules'), { recursive: true });
    await fs.writeFile(
      path.join(alpha, 'rules', 'typescript.md'),
      '---\ndescription: TS\n---\n\n- Prefer named exports.\n',
    );
    await install(alpha, ['pi']);

    await contextOverrideCommand([], options({ force: true }));

    const agentsMd = await readText('AGENTS.md');
    expect(agentsMd).toContain('<!-- hcm:begin alpha/rules/typescript -->');
    expect(agentsMd).toContain('- Prefer named exports.');
    expect(await driftedItems()).toBe(0);
  });

  it('asks before discarding content hcm did not write', async () => {
    await install(await makeBundle('alpha', TWO_SECTIONS));
    await fs.writeFile(path.join(projectDir, 'CLAUDE.md'), '# Hand-written\n\nKeep me.\n');

    const asked: string[] = [];
    await contextOverrideCommand(
      [],
      options({
        confirmer: async (question: string) => {
          asked.push(question);
          return false;
        },
      }),
    );

    expect(asked).toHaveLength(1);
    expect(await readText('CLAUDE.md')).toBe('# Hand-written\n\nKeep me.\n');
  });

  it('refuses rather than guessing when there is nobody to ask', async () => {
    await install(await makeBundle('alpha', TWO_SECTIONS));
    await fs.writeFile(path.join(projectDir, 'CLAUDE.md'), '# Hand-written\n\nKeep me.\n');

    // vitest runs without a TTY, which is the same position CI is in.
    await expect(contextOverrideCommand([], options())).rejects.toThrow(
      /line\(s\) hcm did not write/,
    );
  });
});

describe('hcm context remove', () => {
  it('takes the sections out and keeps the cache', async () => {
    await install(await makeBundle('alpha', TWO_SECTIONS));
    await fs.writeFile(
      path.join(projectDir, 'CLAUDE.md'),
      `${await readText('CLAUDE.md')}\n# Mine\n\nHand-written tail.\n`,
    );

    await contextRemoveCommand([], options());

    const claudeMd = await readText('CLAUDE.md');
    expect(claudeMd).not.toContain('hcm:begin alpha/');
    expect(claudeMd).toContain('Hand-written tail.');

    // The ledger still knows about them, and status is not left complaining
    // about blocks we removed on purpose.
    expect((await readContextLedger('project', projectDir)).sections).toHaveLength(2);
    expect(await driftedItems()).toBe(0);

    await contextAppendCommand([], options());
    expect(await readText('CLAUDE.md')).toContain('<!-- hcm:begin alpha/20-workflow -->');
    expect(await driftedItems()).toBe(0);
  });

  it('deletes a file that held nothing else', async () => {
    await install(await makeBundle('alpha', TWO_SECTIONS));
    expect(await exists('CLAUDE.md')).toBe(true);

    await contextRemoveCommand([], options());
    expect(await exists('CLAUDE.md')).toBe(false);
  });

  it('reports a section that is already gone rather than failing', async () => {
    await install(await makeBundle('alpha', TWO_SECTIONS));
    await fs.writeFile(path.join(projectDir, 'CLAUDE.md'), '# Rewritten by an agent\n');

    await contextRemoveCommand([], options());
    expect(await readText('CLAUDE.md')).toBe('# Rewritten by an agent\n');
  });
});
