/**
 * The requirements file of a project: `hcm install -r`.
 *
 * Three layers, the same three the code has:
 *
 *   the line        what one line of the file means (`core/requirements.ts`)
 *   the git program how an SSH source is downloaded (`core/git-cli.ts`)
 *   the install     a whole file, against a fake git host and the registry
 *
 * The git-program tests use a real repository in a temporary folder, read
 * through its path. They need `git` on the machine, and skip without it.
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installRequirementsCommand } from '../src/commands/requirements.js';
import { HcmError } from '../src/core/errors.js';
import { downloadWithGit, parseCatFileBatch, parseLsTree } from '../src/core/git-cli.js';
import { configureLogger } from '../src/core/logger.js';
import { addToRegistry } from '../src/core/registry.js';
import {
  parseRequirementLine,
  parseRequirements,
  parseRequirementSource,
  tokenize,
} from '../src/core/requirements.js';
import { readState } from '../src/core/state.js';
import { makeWorkspace } from './support/fixtures.js';
import { FakeGitHost } from './support/git-host.js';

const BASE = path.resolve('/work/project');
const AZURE = 'https://dev.azure.com/acme/platform/_git/agent-kits';

async function failure(run: () => unknown): Promise<HcmError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(HcmError);
    return error as HcmError;
  }
  throw new Error('expected a failure');
}

// ---------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------

describe('a line of the requirements file', () => {
  it('reads the example of the feature request, line for line', () => {
    const file = [
      'my-bundle-1 @ https://github.com/fleskovar/agent_assets.git@branch_a',
      'my-bundle-3 @ https://github.com/fleskovar/agent_assets.git@branch_b',
      'my-bundle-4 @ git+ssh://git@github.com:fleskovar/agent_assets.git@branch_c --flavor python',
      'my-bundle-5',
    ].join('\n');

    expect(parseRequirements(file, BASE)).toEqual([
      {
        line: 1,
        name: 'my-bundle-1',
        source: { type: 'github', owner: 'fleskovar', repo: 'agent_assets', ref: 'branch_a' },
      },
      {
        line: 2,
        name: 'my-bundle-3',
        source: { type: 'github', owner: 'fleskovar', repo: 'agent_assets', ref: 'branch_b' },
      },
      {
        line: 3,
        name: 'my-bundle-4',
        source: { type: 'git', url: 'ssh://git@github.com/fleskovar/agent_assets.git', ref: 'branch_c' },
        flavors: ['python'],
      },
      { line: 4, name: 'my-bundle-5' },
    ]);
  });

  it('reads Azure DevOps over HTTPS and over SSH', () => {
    expect(parseRequirementSource(`${AZURE}@release/2`, BASE)).toEqual({
      type: 'git',
      url: AZURE,
      ref: 'release/2',
    });
    // The user name before the host is not a ref.
    expect(parseRequirementSource('https://acme@dev.azure.com/acme/platform/_git/kits', BASE)).toEqual({
      type: 'git',
      url: 'https://acme@dev.azure.com/acme/platform/_git/kits',
      ref: 'HEAD',
    });
    expect(parseRequirementSource('git@ssh.dev.azure.com:v3/acme/platform/kits@main', BASE)).toEqual({
      type: 'git',
      url: 'ssh://git@ssh.dev.azure.com/v3/acme/platform/kits',
      ref: 'main',
    });
  });

  it('reads github.com with the git protocol when the URL says git+', () => {
    expect(parseRequirementSource('git+https://github.com/acme/kits.git@v1.0.0', BASE)).toEqual({
      type: 'git',
      url: 'https://github.com/acme/kits.git',
      ref: 'v1.0.0',
    });
  });

  it('reads a folder from the folder of the file, and pip\'s #subdirectory=', () => {
    expect(parseRequirementSource('./agents/kits', BASE)).toEqual({
      type: 'local',
      path: path.join(BASE, 'agents', 'kits'),
    });
    expect(parseRequirementSource(`${AZURE}@main#subdirectory=bundles/team`, BASE)).toEqual({
      type: 'git',
      url: AZURE,
      ref: 'main',
      subdir: 'bundles/team',
    });
  });

  it('accepts the "@" with or without spaces around it', () => {
    for (const text of [`kit @ ${AZURE}@main`, `kit@ ${AZURE}@main`, `kit @${AZURE}@main`, `kit@${AZURE}@main`]) {
      expect(parseRequirementLine(text, BASE)).toEqual({
        name: 'kit',
        source: { type: 'git', url: AZURE, ref: 'main' },
      });
    }
  });

  it('reads the options of a line', () => {
    expect(
      parseRequirementLine(
        'kit --flavor python csharp -t claude-code pi --param TEAM="Platform team" --param=LANG=en',
        BASE,
      ),
    ).toEqual({
      name: 'kit',
      flavors: ['python', 'csharp'],
      targets: ['claude-code', 'pi'],
      params: ['TEAM=Platform team', 'LANG=en'],
    });
  });

  it('skips comments and blank lines, and a comment at the end of a line', () => {
    expect(parseRequirements('# header\n\n   \nkit  # the team kit\n', BASE)).toEqual([
      { line: 4, name: 'kit' },
    ]);
    expect(tokenize(`a ${AZURE}#subdirectory=x # note`)).toEqual(['a', `${AZURE}#subdirectory=x`]);
  });

  it('reports every bad line, with its number', async () => {
    const error = await failure(() =>
      parseRequirements(
        ['kit', 'kit', 'other --colour red', 'third @', `fourth @ ${AZURE}#main`, 'bad!name'].join('\n'),
        BASE,
      ),
    );
    expect(error.message).toMatch(/5 error/);
    expect(error.message).toMatch(/line 2: "kit" is also on line 1/);
    expect(error.message).toMatch(/line 3: "--colour" is not an option/);
    expect(error.message).toMatch(/line 4: .*no source/);
    expect(error.message).toMatch(/line 5: .*not a fragment/);
    expect(error.message).toMatch(/line 6: .*not a bundle name/);
  });
});

// ---------------------------------------------------------------------------
// The git program
// ---------------------------------------------------------------------------

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('reading the output of the git program', () => {
  it('reads ls-tree, and leaves out links, submodules and .git', () => {
    const output = Buffer.from(
      [
        '100644 blob aaaa\thcm.yaml',
        '100755 blob bbbb\tbin/run.sh',
        '120000 blob cccc\tlink',
        '160000 commit dddd\tvendor/sub',
        '',
      ].join('\0'),
    );
    expect(parseLsTree(output)).toEqual([
      { mode: '100644', id: 'aaaa', path: 'hcm.yaml' },
      { mode: '100755', id: 'bbbb', path: 'bin/run.sh' },
    ]);
  });

  it('refuses a path that leaves the folder', async () => {
    const error = await failure(() => parseLsTree(Buffer.from('100644 blob aaaa\t../evil\0')));
    expect(error.message).toMatch(/does not write/);
  });

  it('reads cat-file --batch, including bytes that look like a header', () => {
    const body = Buffer.from('line one\nbbbb blob 3\n');
    const output = Buffer.concat([
      Buffer.from(`aaaa blob ${body.length}\n`),
      body,
      Buffer.from('\nbbbb blob 3\nxyz\n'),
    ]);
    const objects = parseCatFileBatch(output);
    expect(objects.get('aaaa')?.toString()).toBe(body.toString());
    expect(objects.get('bbbb')?.toString()).toBe('xyz');
  });

  it('says what git said when the fetch fails', async () => {
    const error = await failure(() =>
      downloadWithGit({ url: 'ssh://git@example.invalid/kits.git', ref: 'main' }, async (args) =>
        args.includes('fetch')
          ? { code: 128, stdout: Buffer.alloc(0), stderr: 'fatal: Could not read from remote repository.' }
          : { code: 0, stdout: Buffer.alloc(0), stderr: '' },
      ),
    );
    expect(error.message).toMatch(/Could not read from remote repository/);
    expect(error.hint).toMatch(/git ls-remote/);
  });
});

describe.skipIf(!hasGit)('downloading with the git program', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeWorkspace('git-cli');
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], {
      cwd,
      encoding: 'utf8',
    });

  it('gives the files of a branch, as they are in the repository', async () => {
    const repo = path.join(workspace, 'repo');
    await fs.mkdir(path.join(repo, 'kits', 'alpha'), { recursive: true });
    git(repo, 'init', '--quiet', '--initial-branch=main');
    await fs.writeFile(path.join(repo, 'kits', 'alpha', 'hcm.yaml'), 'name: alpha\r\nversion: 1.0.0\r\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'one');
    git(repo, 'checkout', '--quiet', '-b', 'next');
    await fs.writeFile(path.join(repo, 'README.md'), 'next\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'two');

    const main = await downloadWithGit({ url: repo, ref: 'main' });
    expect(main.files.map((file) => file.path)).toEqual(['kits/alpha/hcm.yaml']);
    // The bytes of the blob, line endings included.
    expect(main.files[0]?.data.toString()).toBe('name: alpha\r\nversion: 1.0.0\r\n');

    const next = await downloadWithGit({ url: repo, ref: 'next' });
    expect(next.files.map((file) => file.path).sort()).toEqual(['README.md', 'kits/alpha/hcm.yaml']);
    expect(next.commit).toBe(git(repo, 'rev-parse', 'next').trim());
  });
});

// ---------------------------------------------------------------------------
// The install
// ---------------------------------------------------------------------------

describe('hcm install -r', () => {
  let workspace: string;
  let projectDir: string;
  let previousHome: string | undefined;
  let host: FakeGitHost;

  const kit = (name: string, version: string, folder = 'bundles'): Record<string, string> => ({
    [`${folder}/${name}/hcm.yaml`]: `name: ${name}\nversion: ${version}\n`,
    [`${folder}/${name}/subagents/${name}-reviewer.md`]: '---\ndescription: Reviews\n---\n\nBody.\n',
  });

  const flavoredKit = (name: string): Record<string, string> => ({
    [`bundles/${name}/hcm.yaml`]: [
      `name: ${name}`,
      'version: 1.0.0',
      'flavors:',
      '  python:',
      '    includes: [rules/python.md]',
      '  csharp:',
      '    includes: [rules/csharp.md]',
      '',
    ].join('\n'),
    [`bundles/${name}/rules/python.md`]: 'Python rules.\n',
    [`bundles/${name}/rules/csharp.md`]: 'C# rules.\n',
    [`bundles/${name}/rules/common.md`]: 'Common rules.\n',
  });

  const writeRequirements = (lines: string[], file = 'hcm-requirements.txt'): Promise<void> =>
    fs.writeFile(path.join(projectDir, file), `${lines.join('\n')}\n`);

  const installed = async (): Promise<Record<string, unknown>[]> =>
    (await readState('project', projectDir)).installations.map((record) => ({
      bundle: record.bundle,
      target: record.target,
      source: record.source,
      ...(record.flavors ? { flavors: record.flavors } : {}),
      ...(record.track ? { track: record.track } : {}),
    }));

  const run = (file?: string, extra: Record<string, unknown> = {}) =>
    installRequirementsCommand(file, {
      scope: 'project',
      cwd: projectDir,
      targets: ['claude-code'],
      prompt: false,
      ...extra,
    });

  beforeEach(async () => {
    workspace = await makeWorkspace('requirements');
    projectDir = path.join(workspace, 'project');
    await fs.mkdir(projectDir, { recursive: true });

    previousHome = process.env.HCM_HOME;
    process.env.HCM_HOME = path.join(workspace, 'home');
    configureLogger({ quiet: true });

    host = new FakeGitHost();
    vi.stubGlobal('fetch', host.fetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (previousHome === undefined) delete process.env.HCM_HOME;
    else process.env.HCM_HOME = previousHome;
    process.exitCode = undefined;
    configureLogger({});
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('installs the named bundles of a repository, from two branches, and skips the others', async () => {
    host.commit(AZURE, { ...kit('alpha', '1.0.0'), ...kit('skipped', '1.0.0'), ...flavoredKit('beta') });
    host.commit(AZURE, { ...kit('alpha', '2.0.0'), ...flavoredKit('beta') }, 'next');

    await writeRequirements([
      '# the agent bundles of this project',
      `alpha @ ${AZURE}@next`,
      `beta  @ ${AZURE} --flavor python`,
    ]);
    await run();

    expect(await installed()).toEqual([
      {
        bundle: 'alpha',
        target: 'claude-code',
        source: { type: 'git', url: AZURE, ref: 'next', subdir: 'bundles/alpha' },
        track: 'source',
      },
      {
        bundle: 'beta',
        target: 'claude-code',
        source: { type: 'git', url: AZURE, ref: 'HEAD', subdir: 'bundles/beta' },
        flavors: ['python'],
        track: 'source',
      },
    ]);

    const state = await readState('project', projectDir);
    const beta = state.installations.find((record) => record.bundle === 'beta')!;
    const files = beta.receipts.map((receipt) => path.basename(receipt.path));
    expect(files).toContain('python.md');
    expect(files).toContain('common.md');
    expect(files).not.toContain('csharp.md');
  });

  it('installs a line with no source from the registry', async () => {
    const local = path.join(workspace, 'team-kit');
    await fs.mkdir(path.join(local, 'subagents'), { recursive: true });
    await fs.writeFile(path.join(local, 'hcm.yaml'), 'name: team-kit\nversion: 3.0.0\n');
    await fs.writeFile(path.join(local, 'subagents', 'helper.md'), '---\ndescription: Helps\n---\n\nHelp.\n');
    await addToRegistry(local, workspace);

    await writeRequirements(['team-kit']);
    await run();

    expect(await installed()).toEqual([
      { bundle: 'team-kit', target: 'claude-code', source: { type: 'local', path: local } },
    ]);
  });

  it('reads a folder from the folder of the file, not from the working directory', async () => {
    const agents = path.join(projectDir, 'tools', 'agents');
    await fs.mkdir(path.join(agents, 'kits', 'docs-kit', 'subagents'), { recursive: true });
    await fs.writeFile(path.join(agents, 'kits', 'docs-kit', 'hcm.yaml'), 'name: docs-kit\nversion: 1.0.0\n');
    await fs.writeFile(
      path.join(agents, 'kits', 'docs-kit', 'subagents', 'writer.md'),
      '---\ndescription: Writes\n---\n\nWrite.\n',
    );
    await writeRequirements(['docs-kit @ ./kits'], 'tools/agents/requirements.txt');

    await run('tools/agents/requirements.txt');

    expect(await installed()).toEqual([
      {
        bundle: 'docs-kit',
        target: 'claude-code',
        source: { type: 'local', path: path.join(agents, 'kits', 'docs-kit') },
        track: 'source',
      },
    ]);
  });

  it('can run again, and installs the same thing', async () => {
    host.commit(AZURE, { ...kit('alpha', '1.0.0') });
    await writeRequirements([`alpha @ ${AZURE}`]);

    await run();
    const first = await installed();
    await run();

    expect(await installed()).toEqual(first);
  });

  it('changes the flavor of an installation when the line changes', async () => {
    host.commit(AZURE, flavoredKit('beta'));
    const rules = async (): Promise<string[]> =>
      (await readState('project', projectDir)).installations
        .flatMap((record) => record.receipts.map((receipt) => path.basename(receipt.path)))
        .sort();

    await writeRequirements([`beta @ ${AZURE} --flavor python`]);
    await run();
    expect(await rules()).toEqual(['common.md', 'python.md']);

    await writeRequirements([`beta @ ${AZURE} --flavor csharp`]);
    await run();
    expect(await rules()).toEqual(['common.md', 'csharp.md']);
    expect((await installed())[0]).toMatchObject({ flavors: ['csharp'] });
  });

  it('moves an installation to the new ref when the line changes', async () => {
    host.commit(AZURE, kit('alpha', '1.0.0'));
    host.commit(AZURE, kit('alpha', '2.0.0'), 'next');

    await writeRequirements([`alpha @ ${AZURE}`]);
    await run();
    await writeRequirements([`alpha @ ${AZURE}@next`]);
    await run();

    const [record] = (await readState('project', projectDir)).installations;
    expect(record).toMatchObject({ version: '2.0.0', source: { ref: 'next' } });
  });

  it('installs nothing when one line cannot be found, and names every such line', async () => {
    host.commit(AZURE, { ...kit('alpha', '1.0.0'), ...kit('beta', '1.0.0') });
    await writeRequirements([`alpha @ ${AZURE}`, `gamma @ ${AZURE}`, 'not-registered']);

    const error = await failure(() => run());
    expect(error.message).toMatch(/nothing was installed/);
    expect(error.message).toMatch(/line 2 \(gamma\): There is no bundle "gamma"/);
    expect(error.message).toMatch(/Bundles there: alpha, beta/);
    expect(error.message).toMatch(/line 3 \(not-registered\): .*no bundle of that name is registered/);
    expect(await installed()).toEqual([]);
  });

  it('writes nothing on a dry run', async () => {
    host.commit(AZURE, { ...kit('alpha', '1.0.0') });
    await writeRequirements([`alpha @ ${AZURE}`]);

    await run(undefined, { dryRun: true });

    expect(await installed()).toEqual([]);
  });

  it('says how to start when the file is not there', async () => {
    const error = await failure(() => run());
    expect(error.message).toMatch(/No such file: .*hcm-requirements\.txt/);
  });
});
