/**
 * Bundles from any git host, by the HTTPS clone URL -- and `hcm registry
 * update`, which reads them again.
 *
 * Three layers, the same three the code has:
 *
 *   the reference   what a pasted URL means (`core/git.ts`)
 *   the protocol    reading refs and a pack without git (`core/git-http.ts`)
 *   the registry    add, update and install with such a source
 *
 * Nothing here uses the network or the `git` program. `FakeGitHost` answers
 * the two requests of the protocol from memory.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sourceToReference } from '../src/commands/export.js';
import { installCommand } from '../src/commands/install.js';
import { registryUpdateCommand } from '../src/commands/registry.js';
import { updateCommand } from '../src/commands/update.js';
import { HcmError } from '../src/core/errors.js';
import { describeGitSource, gitReference, parseGitSource } from '../src/core/git.js';
import {
  applyDelta,
  downloadGitTree,
  gitAuthorization,
  parsePack,
  readFiles,
} from '../src/core/git-http.js';
import { describeSource } from '../src/core/github.js';
import { configureLogger } from '../src/core/logger.js';
import { addToRegistry, parseSource, readRegistry } from '../src/core/registry.js';
import { storeEntryDir } from '../src/core/store.js';
import { makeWorkspace } from './support/fixtures.js';
import { FakeGitHost, makeDelta, makeObject, makePack } from './support/git-host.js';

const AZURE = 'https://dev.azure.com/acme/platform/_git/agent-kits';

/** Run something that must fail, and hand back the error. */
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
// The reference
// ---------------------------------------------------------------------------

describe('a clone URL as a source', () => {
  it('reads the clone URL of each host as it is', () => {
    for (const url of [
      AZURE,
      'https://acme.visualstudio.com/platform/_git/agent-kits',
      'https://bitbucket.org/acme/agent-kits.git',
      'https://gitlab.com/acme/platform/agent-kits.git',
      'http://git.example.com:8080/team/agent-kits.git',
    ]) {
      expect(parseGitSource(url)).toEqual({ type: 'git', url, ref: 'HEAD' });
    }
  });

  it('keeps the user name that the Azure DevOps clone box adds', () => {
    expect(parseGitSource('https://acme@dev.azure.com/acme/platform/_git/agent-kits')).toEqual({
      type: 'git',
      url: 'https://acme@dev.azure.com/acme/platform/_git/agent-kits',
      ref: 'HEAD',
    });
  });

  it('reads a ref and a folder from the fragment', () => {
    expect(parseGitSource(`${AZURE}#v1.2.0`)).toMatchObject({ url: AZURE, ref: 'v1.2.0' });
    expect(parseGitSource(`${AZURE}#release/2:bundles/my-kit`)).toEqual({
      type: 'git',
      url: AZURE,
      ref: 'release/2',
      subdir: 'bundles/my-kit',
    });
    expect(parseGitSource(`${AZURE}#:/bundles/my-kit/`)).toEqual({
      type: 'git',
      url: AZURE,
      ref: 'HEAD',
      subdir: 'bundles/my-kit',
    });
  });

  it('reads the branch and the folder of an Azure DevOps browser URL', () => {
    expect(parseGitSource(`${AZURE}?path=/bundles/my-kit&version=GBrelease/2`)).toEqual({
      type: 'git',
      url: AZURE,
      ref: 'release/2',
      subdir: 'bundles/my-kit',
    });
    expect(parseGitSource(`${AZURE}?path=/&version=GTv1.2.0`)).toEqual({
      type: 'git',
      url: AZURE,
      ref: 'v1.2.0',
    });
  });

  it('drops a trailing slash and the query string of another host', () => {
    expect(parseGitSource('https://gitlab.com/acme/agent-kits/?ref_type=heads')).toMatchObject({
      url: 'https://gitlab.com/acme/agent-kits',
    });
  });

  it('refuses a password in the URL, because the registry records the URL', async () => {
    const error = await failure(() => parseGitSource('https://me:s3cret@bitbucket.org/acme/kits.git'));
    expect(error.message).toMatch(/password or a token/);
    expect(error.hint).toMatch(/HCM_GIT_TOKEN/);
  });

  it('refuses a folder outside the repository', async () => {
    const error = await failure(() => parseGitSource(`${AZURE}#main:../elsewhere`));
    expect(error.message).toMatch(/outside the repository/);
  });

  it('leaves everything that is not an HTTP URL alone', () => {
    for (const input of ['./my-kit', 'acme/my-kit', 'C:/local/my-kit', 'git@host:acme/kit.git', '']) {
      expect(parseGitSource(input)).toBeUndefined();
    }
  });
});

describe('which source a reference becomes', () => {
  const cwd = path.resolve('/work');

  it('keeps github.com on the GitHub path', () => {
    expect(parseSource('https://github.com/acme/my-kit.git', cwd)).toEqual({
      type: 'github',
      owner: 'acme',
      repo: 'my-kit',
      ref: 'HEAD',
    });
  });

  it('reads github.com with the git protocol when the URL says git+', () => {
    expect(parseSource('git+https://github.com/acme/my-kit.git#v2', cwd)).toEqual({
      type: 'git',
      url: 'https://github.com/acme/my-kit.git',
      ref: 'v2',
    });
  });

  it('reads every other host with the git protocol', () => {
    expect(parseSource(AZURE, cwd)).toEqual({ type: 'git', url: AZURE, ref: 'HEAD' });
  });

  it('still reads a path as a path', () => {
    expect(parseSource('./my-kit', cwd)).toEqual({
      type: 'local',
      path: path.join(cwd, 'my-kit'),
    });
  });

  it('says why an SSH URL of another host cannot be read', async () => {
    for (const input of [
      'git@ssh.dev.azure.com:v3/acme/platform/agent-kits',
      'git@bitbucket.org:acme/agent-kits.git',
      'ssh://git@gitlab.com/acme/agent-kits.git',
    ]) {
      const error = await failure(() => parseSource(input, cwd));
      expect(error.hint).toMatch(/HTTPS clone URL/);
    }
    // github.com is the exception: its SSH URL names the same archive.
    expect(parseSource('git@github.com:acme/my-kit.git', cwd)).toMatchObject({ type: 'github' });
  });
});

describe('writing a git source back out', () => {
  it('round-trips through the reference that export writes', () => {
    for (const reference of [
      AZURE,
      `${AZURE}#v1.2.0`,
      `${AZURE}#main:bundles/my-kit`,
      `${AZURE}#:bundles/my-kit`,
      'git+https://github.com/acme/my-kit.git#:bundles/my-kit',
    ]) {
      const source = parseSource(reference, '/work');
      expect(source.type).toBe('git');
      expect(sourceToReference(source)).toBe(reference);
    }
  });

  it('describes the source with the ref it reads', () => {
    const source = parseGitSource(`${AZURE}#:bundles/my-kit`)!;
    expect(describeGitSource(source)).toBe(`${AZURE}#HEAD:bundles/my-kit`);
    expect(describeSource(source)).toBe(`${AZURE}#HEAD:bundles/my-kit`);
    expect(gitReference(parseGitSource(describeGitSource(source))!)).toBe(gitReference(source));
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe('the token for a host', () => {
  const basic = (header: string | undefined): string =>
    Buffer.from((header ?? '').replace(/^Basic /, ''), 'base64').toString();

  it('sends nothing when no token is set', () => {
    expect(gitAuthorization(new URL(AZURE), {})).toBeUndefined();
  });

  it('sends HCM_GIT_TOKEN as the password', () => {
    expect(basic(gitAuthorization(new URL(AZURE), { HCM_GIT_TOKEN: 'pat' }))).toBe('git:pat');
  });

  it('prefers the token of the host', () => {
    const env = { HCM_GIT_TOKEN: 'general', HCM_GIT_TOKEN_DEV_AZURE_COM: 'azure' };
    expect(basic(gitAuthorization(new URL(AZURE), env))).toBe('git:azure');
    expect(basic(gitAuthorization(new URL('https://gitlab.com/a/b.git'), env))).toBe('git:general');
  });

  it('uses the user name of the URL, then HCM_GIT_USERNAME', () => {
    const env = { HCM_GIT_TOKEN: 'pat', HCM_GIT_USERNAME: 'fallback' };
    expect(basic(gitAuthorization(new URL('https://me@bitbucket.org/a/b.git'), env))).toBe('me:pat');
    expect(basic(gitAuthorization(new URL('https://bitbucket.org/a/b.git'), env))).toBe(
      'fallback:pat',
    );
  });

  it('uses the token user name that Bitbucket expects', () => {
    const header = gitAuthorization(new URL('https://bitbucket.org/a/b.git'), { HCM_GIT_TOKEN: 't' });
    expect(basic(header)).toBe('x-token-auth:t');
  });
});

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------

describe('reading a pack', () => {
  it('applies a delta that copies and inserts', () => {
    const base = Buffer.from('The quick brown fox jumps over the lazy dog.\n');
    const target = Buffer.from('The quick brown cat sleeps.\n');
    expect(applyDelta(base, makeDelta(base, target)).toString()).toBe(target.toString());
  });

  it('applies a delta for a target longer than one insert instruction', () => {
    const base = Buffer.from('header\n');
    const target = Buffer.from(`header\n${'line of text\n'.repeat(40)}`);
    expect(applyDelta(base, makeDelta(base, target)).equals(target)).toBe(true);
  });

  it('refuses a delta that does not match its base', async () => {
    const delta = makeDelta(Buffer.from('one base'), Buffer.from('one target'));
    const error = await failure(() => applyDelta(Buffer.from('another base!'), delta));
    expect(error.message).toMatch(/does not match its base/);
  });

  const blobs = ['shared start, first file\n', 'shared start, second file\n', 'shared start, third\n'].map(
    (text) => makeObject('blob', Buffer.from(text)),
  );

  it.each(['none', 'ofs', 'ref'] as const)('reads every object (deltas: %s)', (deltas) => {
    const objects = parsePack(makePack(blobs, deltas));
    expect(objects.size).toBe(3);
    for (const blob of blobs) {
      expect(objects.get(blob.id)?.data.toString()).toBe(blob.data.toString());
    }
  });

  it('finds the base of a delta that is far back in the pack', () => {
    // Bytes that do not compress, so the base takes about 20 kB of the pack and
    // the distance back to it needs three bytes.
    const noise = Buffer.concat(
      Array.from({ length: 625 }, (_, index) => createHash('sha256').update(`${index}`).digest()),
    );
    const large = [
      makeObject('blob', noise),
      makeObject('blob', Buffer.concat([noise.subarray(0, 15000), Buffer.from('second')])),
      makeObject('blob', Buffer.concat([noise, Buffer.from('third')])),
    ];

    const objects = parsePack(makePack(large, 'ofs'));
    for (const blob of large) expect(objects.get(blob.id)?.data.equals(blob.data)).toBe(true);
  });

  it('refuses a pack that is cut short', async () => {
    const pack = makePack(blobs);
    const error = await failure(() => parsePack(pack.subarray(0, pack.length - 40)));
    expect(error.message).toMatch(/cannot read/);
  });

  it('refuses a file name that leaves the directory', async () => {
    const blob = makeObject('blob', Buffer.from('x'));
    for (const name of ['..', 'a/b', 'a\\b']) {
      const tree = makeObject(
        'tree',
        Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.from(blob.id, 'hex')]),
      );
      const commit = makeObject('commit', Buffer.from(`tree ${tree.id}\n\nmessage\n`));
      const objects = parsePack(makePack([commit, tree, blob]));

      const error = await failure(() => readFiles(objects, commit.id));
      expect(error.message).toMatch(/file name that hcm does not write/);
    }
  });
});

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

describe('downloading a commit', () => {
  const FILES = {
    'README.md': '# kits\n',
    'bundles/alpha/hcm.yaml': 'name: alpha\nversion: 1.0.0\n',
    'bundles/alpha/skills/one/SKILL.md': '---\ndescription: one\n---\n\nBody.\n',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const serve = (host: FakeGitHost): FakeGitHost => {
    vi.stubGlobal('fetch', host.fetch);
    return host;
  };

  const read = (download: { files: { path: string; data: Buffer }[] }): Record<string, string> =>
    Object.fromEntries(download.files.map((file) => [file.path, file.data.toString()]));

  it.each([
    ['whole objects in side-band packets', {}],
    ['offset deltas', { deltas: 'ofs' as const }],
    ['deltas that come before their base', { deltas: 'ref' as const }],
    ['a raw pack with no side band', { sideBand: false }],
  ])('reads %s', async (_name, options) => {
    const host = serve(new FakeGitHost(options));
    const commit = host.commit(AZURE, FILES);

    const download = await downloadGitTree({ url: AZURE, ref: 'HEAD' });
    expect(download.commit).toBe(commit);
    expect(read(download)).toEqual(FILES);
  });

  it('asks for one commit, not the history', async () => {
    const host = serve(new FakeGitHost());
    host.commit(AZURE, FILES);
    const bodies: string[] = [];
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      if (init?.body) bodies.push(Buffer.from(init.body as Uint8Array).toString('latin1'));
      return host.fetch(input, init);
    });

    await downloadGitTree({ url: AZURE, ref: 'HEAD' });
    expect(bodies[0]).toContain('deepen 1');
    // Only capabilities the server offered, and never thin-pack: a thin pack
    // leaves out objects that this client does not have.
    expect(bodies[0]).toMatch(/want [0-9a-f]{40} multi_ack_detailed side-band-64k ofs-delta no-progress agent=/);
    expect(bodies[0]).not.toContain('thin-pack');
  });

  it('reads a branch, a tag and a commit id', async () => {
    const host = serve(new FakeGitHost());
    const first = host.commit(AZURE, { 'a.txt': 'one\n' });
    host.tag(AZURE, 'v1.0.0', first);
    host.commit(AZURE, { 'a.txt': 'two\n' });
    host.commit(AZURE, { 'a.txt': 'next\n' }, 'release/2');

    expect(read(await downloadGitTree({ url: AZURE, ref: 'HEAD' }))).toEqual({ 'a.txt': 'two\n' });
    expect(read(await downloadGitTree({ url: AZURE, ref: 'main' }))).toEqual({ 'a.txt': 'two\n' });
    expect(read(await downloadGitTree({ url: AZURE, ref: 'release/2' }))).toEqual({
      'a.txt': 'next\n',
    });
    expect(read(await downloadGitTree({ url: AZURE, ref: 'v1.0.0' }))).toEqual({ 'a.txt': 'one\n' });
    expect(read(await downloadGitTree({ url: AZURE, ref: first }))).toEqual({ 'a.txt': 'one\n' });
  });

  it('names the branches when the ref is not one of them', async () => {
    const host = serve(new FakeGitHost());
    host.commit(AZURE, FILES);
    host.commit(AZURE, FILES, 'develop');

    const error = await failure(() => downloadGitTree({ url: AZURE, ref: 'nope' }));
    expect(error.message).toMatch(/"nope" is not a branch, a tag or a full commit id/);
    expect(error.hint).toBe('Branches: develop, main');
  });

  it('reports what the server says about a commit it does not send', async () => {
    const host = serve(new FakeGitHost());
    host.commit(AZURE, FILES);

    const error = await failure(() => downloadGitTree({ url: AZURE, ref: 'a'.repeat(40) }));
    expect(error.message).toMatch(/refused the request: upload-pack: not our ref/);
  });

  it('points at the token when a private repository refuses access', async () => {
    const host = serve(new FakeGitHost({ token: 'pat' }));
    host.commit(AZURE, FILES);

    const error = await failure(() => downloadGitTree({ url: AZURE, ref: 'HEAD' }));
    expect(error.message).toBe(`${AZURE} refused access (HTTP 401)`);
    expect(error.hint).toMatch(/HCM_GIT_TOKEN/);
    expect(error.hint).toMatch(/HCM_GIT_TOKEN_DEV_AZURE_COM/);
  });

  it('reads a private repository with the token from the environment', async () => {
    const host = serve(new FakeGitHost({ token: 'pat' }));
    host.commit(AZURE, FILES);
    vi.stubEnv('HCM_GIT_TOKEN_DEV_AZURE_COM', 'pat');

    const withUser = 'https://acme@dev.azure.com/acme/platform/_git/agent-kits';
    expect(read(await downloadGitTree({ url: withUser, ref: 'HEAD' }))).toEqual(FILES);

    // The user name goes into the header. `fetch` refuses a URL that has one.
    expect(host.requests.every((seen) => !seen.url.includes('@'))).toBe(true);
    expect(Buffer.from(host.requests[0]!.authorization!.slice(6), 'base64').toString()).toBe(
      'acme:pat',
    );
  });

  it('says so when the URL answers, but not as a git repository', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>Sign in</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));

    const error = await failure(() => downloadGitTree({ url: AZURE, ref: 'HEAD' }));
    expect(error.message).toMatch(/did not answer as a git repository/);
  });

  it('says so when the URL names no repository', async () => {
    serve(new FakeGitHost());
    const error = await failure(() => downloadGitTree({ url: AZURE, ref: 'HEAD' }));
    expect(error.message).toMatch(/Repository not found/);
  });
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe('a git source in the registry', () => {
  let workspace: string;
  let projectDir: string;
  let previousHome: string | undefined;
  let host: FakeGitHost;

  const kit = (name: string, version: string, body = 'Version one.'): Record<string, string> => ({
    [`${name}/hcm.yaml`]: `name: ${name}\nversion: ${version}\n`,
    [`${name}/subagents/${name}-reviewer.md`]: `---\ndescription: Reviews\n---\n\n${body}\n`,
  });

  beforeEach(async () => {
    workspace = await makeWorkspace('git-source');
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

  const stored = async (name: string, relative: string): Promise<string | undefined> => {
    const entry = (await readRegistry()).entries.find((candidate) => candidate.name === name);
    try {
      return await fs.readFile(path.join(await storeEntryDir(entry!.store!), relative), 'utf8');
    } catch {
      return undefined;
    }
  };

  it('registers the bundle at the root of a repository', async () => {
    host.commit(AZURE, {
      'hcm.yaml': 'name: solo\nversion: 1.0.0\n',
      'subagents/reviewer.md': '---\ndescription: Reviews\n---\n\nBody.\n',
    });

    const [entry] = await addToRegistry(AZURE, projectDir);
    expect(entry).toMatchObject({
      name: 'solo',
      version: '1.0.0',
      source: { type: 'git', url: AZURE, ref: 'HEAD' },
    });
    expect(await stored('solo', 'subagents/reviewer.md')).toContain('Body.');
  });

  it('registers every bundle of a collection, each with its own folder', async () => {
    host.commit(AZURE, { ...kit('alpha', '1.0.0'), ...kit('beta', '2.0.0'), 'README.md': '# kits\n' });

    const entries = await addToRegistry(AZURE, projectDir);
    expect(entries.map((entry) => [entry.name, entry.source])).toEqual([
      ['alpha', { type: 'git', url: AZURE, ref: 'HEAD', subdir: 'alpha' }],
      ['beta', { type: 'git', url: AZURE, ref: 'HEAD', subdir: 'beta' }],
    ]);
    // One repository, one download.
    expect(host.downloads).toBe(1);
  });

  it('registers the folder that the reference names', async () => {
    host.commit(AZURE, {
      ...Object.fromEntries(
        Object.entries(kit('alpha', '1.0.0')).map(([file, text]) => [`bundles/${file}`, text]),
      ),
      'docs/guide.md': '# guide\n',
    });

    const [entry] = await addToRegistry(`${AZURE}#:bundles`, projectDir);
    expect(entry?.source).toEqual({ type: 'git', url: AZURE, ref: 'HEAD', subdir: 'bundles/alpha' });
  });

  it('names the folder to ask for when the bundles are deeper in the repository', async () => {
    host.commit(AZURE, {
      ...Object.fromEntries(
        Object.entries(kit('alpha', '1.0.0')).map(([file, text]) => [`bundles/${file}`, text]),
      ),
    });

    const error = await failure(() => addToRegistry(AZURE, projectDir));
    expect(error.message).toBe(`No bundle found in ${AZURE}#HEAD`);
    expect(error.hint).toContain('bundles/alpha');
    expect(error.hint).toContain(`"${AZURE}#:bundles"`);
  });

  it('refuses --dev, because there is no working copy to edit', async () => {
    host.commit(AZURE, kit('alpha', '1.0.0'));
    const error = await failure(() => addToRegistry(AZURE, projectDir, { dev: true }));
    expect(error.message).toMatch(/--dev only applies/);
  });

  describe('hcm registry update', () => {
    it('downloads the latest commit and replaces the stored copy', async () => {
      host.commit(AZURE, { ...kit('alpha', '1.0.0'), 'alpha/subagents/old.md': '---\ndescription: Old\n---\n\nOld.\n' });
      await addToRegistry(AZURE, projectDir);

      host.commit(AZURE, kit('alpha', '1.1.0', 'Version two.'));
      await registryUpdateCommand([]);

      const [entry] = (await readRegistry()).entries;
      expect(entry?.version).toBe('1.1.0');
      expect(await stored('alpha', 'subagents/alpha-reviewer.md')).toContain('Version two.');
      // A file that the new commit does not have is gone from the store too.
      expect(await stored('alpha', 'subagents/old.md')).toBeUndefined();
    });

    it('does not touch a project', async () => {
      host.commit(AZURE, kit('alpha', '1.0.0'));
      await addToRegistry(AZURE, projectDir);
      await installCommand('alpha', { targets: ['claude-code'], scope: 'project', cwd: projectDir });

      host.commit(AZURE, kit('alpha', '1.1.0', 'Version two.'));
      await registryUpdateCommand(['alpha']);

      const installed = path.join(projectDir, '.claude', 'agents', 'alpha-reviewer.md');
      expect(await fs.readFile(installed, 'utf8')).toContain('Version one.');

      // `hcm update` is the step that does.
      await updateCommand('alpha', { cwd: projectDir });
      expect(await fs.readFile(installed, 'utf8')).toContain('Version two.');
    });

    it('downloads a repository once for all the bundles it holds', async () => {
      host.commit(AZURE, { ...kit('alpha', '1.0.0'), ...kit('beta', '1.0.0') });
      await addToRegistry(AZURE, projectDir);
      const before = host.downloads;

      host.commit(AZURE, { ...kit('alpha', '1.1.0'), ...kit('beta', '1.2.0') });
      await registryUpdateCommand([]);

      expect(host.downloads - before).toBe(1);
      expect((await readRegistry()).entries.map((entry) => entry.version)).toEqual(['1.1.0', '1.2.0']);
    });

    it('updates only the bundles that it is given', async () => {
      const other = 'https://bitbucket.org/acme/other-kits.git';
      host.commit(AZURE, kit('alpha', '1.0.0'));
      host.commit(other, kit('beta', '1.0.0'));
      await addToRegistry(AZURE, projectDir);
      await addToRegistry(other, projectDir);

      host.commit(AZURE, kit('alpha', '2.0.0'));
      host.commit(other, kit('beta', '2.0.0'));
      await registryUpdateCommand(['beta']);

      expect((await readRegistry()).entries.map((entry) => [entry.name, entry.version])).toEqual([
        ['alpha', '1.0.0'],
        ['beta', '2.0.0'],
      ]);
    });

    it('changes nothing on a dry run', async () => {
      host.commit(AZURE, kit('alpha', '1.0.0'));
      await addToRegistry(AZURE, projectDir);

      host.commit(AZURE, kit('alpha', '1.1.0', 'Version two.'));
      await registryUpdateCommand([], { dryRun: true });

      expect((await readRegistry()).entries[0]?.version).toBe('1.0.0');
      expect(await stored('alpha', 'subagents/alpha-reviewer.md')).toContain('Version one.');
    });

    it('carries on past a source that it cannot read, and fails at the end', async () => {
      const gone = 'https://bitbucket.org/acme/gone.git';
      host.commit(gone, kit('alpha', '1.0.0'));
      host.commit(AZURE, kit('beta', '1.0.0'));
      await addToRegistry(gone, projectDir);
      await addToRegistry(AZURE, projectDir);

      // The first repository goes away; the second one moves on.
      const working = host;
      host = new FakeGitHost();
      vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
        String(input).startsWith(gone) ? host.fetch(input, init) : working.fetch(input, init),
      );
      working.commit(AZURE, kit('beta', '1.1.0'));

      await registryUpdateCommand([]);

      expect(process.exitCode).toBe(1);
      expect((await readRegistry()).entries.map((entry) => [entry.name, entry.version])).toEqual([
        ['alpha', '1.0.0'],
        ['beta', '1.1.0'],
      ]);
      // The stored copy of the bundle that failed is still the one that installs.
      expect(await stored('alpha', 'subagents/alpha-reviewer.md')).toContain('Version one.');
    });
  });
});
