/**
 * The Reasonix target must emit TOML matching docs/SPEC.md section 5.
 *
 * Every test here parses the file we actually wrote, rather than matching
 * strings, so a change that produces plausible-looking but invalid or
 * misshapen TOML fails.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBundle } from '../src/core/bundle.js';
import { applyPlan } from '../src/core/executor.js';
import { buildPlan } from '../src/core/planner.js';
import { rollback } from '../src/core/rollback.js';
import { installationId, type InstallationRecord } from '../src/core/types.js';

let workspace: string;
let projectDir: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-toml-'));
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/** Build a bundle whose mcp/ and settings/ contents are supplied by the test. */
async function makeBundle(
  name: string,
  servers: Record<string, unknown>,
  settings?: unknown,
): Promise<string> {
  const root = path.join(workspace, name);
  await fs.mkdir(path.join(root, 'mcp'), { recursive: true });
  await fs.writeFile(path.join(root, 'hcm.yaml'), `name: ${name}\nversion: 1.0.0\n`);

  for (const [server, definition] of Object.entries(servers)) {
    await fs.writeFile(
      path.join(root, 'mcp', `${server}.json`),
      JSON.stringify(definition, null, 2),
    );
  }

  if (settings !== undefined) {
    await fs.mkdir(path.join(root, 'settings'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'settings', 'settings.json'),
      JSON.stringify(settings, null, 2),
    );
  }

  return root;
}

async function install(bundleRoot: string): Promise<InstallationRecord> {
  const bundle = await loadBundle(bundleRoot);
  const plan = await buildPlan(bundle, 'reasonix', 'project', projectDir);
  expect(plan.conflicts).toEqual([]);
  const receipts = await applyPlan(plan);

  return {
    id: installationId(bundle.manifest.name, 'reasonix', 'project'),
    bundle: bundle.manifest.name,
    version: bundle.manifest.version,
    target: 'reasonix',
    scope: 'project',
    source: { type: 'local', path: bundleRoot },
    installedAt: new Date().toISOString(),
    receipts,
  };
}

/** Read reasonix.toml and parse it -- invalid TOML throws here. */
async function readConfig(): Promise<Record<string, unknown>> {
  const text = await fs.readFile(path.join(projectDir, 'reasonix.toml'), 'utf8');
  return parseToml(text) as Record<string, unknown>;
}

type Plugin = Record<string, unknown>;

const plugins = (config: Record<string, unknown>): Plugin[] => (config.plugins ?? []) as Plugin[];

describe('[[plugins]] per SPEC section 5', () => {
  it('emits a stdio server with command, args and env', async () => {
    const bundle = await makeBundle('kit', {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        env: { LOG_LEVEL: 'debug' },
      },
    });
    await install(bundle);

    expect(plugins(await readConfig())).toEqual([
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        env: { LOG_LEVEL: 'debug' },
      },
    ]);
  });

  it('leaves type implicit for stdio, which is the documented default', async () => {
    const bundle = await makeBundle('kit', { local: { command: 'my-server' } });
    await install(bundle);

    expect(plugins(await readConfig())[0]).not.toHaveProperty('type');
  });

  it('marks a URL-based server as http so it is not spawned as a command', async () => {
    const bundle = await makeBundle('kit', {
      stripe: {
        url: 'https://mcp.stripe.com',
        headers: { Authorization: 'Bearer ${STRIPE_KEY}' },
      },
    });
    await install(bundle);

    expect(plugins(await readConfig())).toEqual([
      {
        name: 'stripe',
        type: 'http',
        url: 'https://mcp.stripe.com',
        // ${VAR} expansion is Reasonix's job; the value passes through intact.
        headers: { Authorization: 'Bearer ${STRIPE_KEY}' },
      },
    ]);
  });

  it('honours an explicit transport such as sse', async () => {
    const bundle = await makeBundle('kit', {
      events: { type: 'sse', url: 'https://example.com/sse' },
    });
    await install(bundle);

    expect(plugins(await readConfig())[0]).toMatchObject({ type: 'sse' });
  });

  it('maps timeouts to their snake_case spec names', async () => {
    const bundle = await makeBundle('kit', {
      slow: {
        command: 'slow-server',
        startupTimeoutSeconds: 60,
        callTimeoutSeconds: 600,
        toolTimeoutSeconds: { generate_video: 1800 },
      },
    });
    await install(bundle);

    expect(plugins(await readConfig())[0]).toEqual({
      name: 'slow',
      command: 'slow-server',
      startup_timeout_seconds: 60,
      call_timeout_seconds: 600,
      tool_timeout_seconds: { generate_video: 1800 },
    });
  });

  it('accepts spec-style snake_case in the bundle source too', async () => {
    const bundle = await makeBundle('kit', {
      slow: { command: 'slow-server', startup_timeout_seconds: 45, call_timeout_seconds: 90 },
    });
    await install(bundle);

    expect(plugins(await readConfig())[0]).toMatchObject({
      startup_timeout_seconds: 45,
      call_timeout_seconds: 90,
    });
  });
});

describe('TOML rendering of plugin entries', () => {
  const readRaw = (): Promise<string> =>
    fs.readFile(path.join(projectDir, 'reasonix.toml'), 'utf8');

  it('writes nested objects as inline tables, not sub-tables', async () => {
    const bundle = await makeBundle('kit', {
      one: { command: 'a', env: { FOO: 'bar' } },
      two: { command: 'b' },
    });
    await install(bundle);

    const raw = await readRaw();
    // A [plugins.env] sub-table would bind to whichever [[plugins]] precedes
    // it, which is exactly the fragility marker blocks must not depend on.
    expect(raw).toContain('env = { FOO = "bar" }');
    expect(raw).not.toContain('[plugins.env]');

    // The env still lands on the right server.
    const parsed = plugins(await readConfig());
    expect(parsed.find((plugin) => plugin.name === 'one')?.env).toEqual({ FOO: 'bar' });
    expect(parsed.find((plugin) => plugin.name === 'two')).not.toHaveProperty('env');
  });

  it('escapes values that would otherwise break the file', async () => {
    const bundle = await makeBundle('kit', {
      awkward: {
        command: 'C:\\Program Files\\my-server.exe',
        args: ['--say', 'he said "hi"', 'tab\there'],
        env: { 'weird.key': 'line1\nline2' },
      },
    });
    await install(bundle);

    // Parsing is the real assertion: bad escaping throws or corrupts values.
    expect(plugins(await readConfig())[0]).toEqual({
      name: 'awkward',
      command: 'C:\\Program Files\\my-server.exe',
      args: ['--say', 'he said "hi"', 'tab\there'],
      env: { 'weird.key': 'line1\nline2' },
    });
  });

  it('renders an empty args list without breaking', async () => {
    const bundle = await makeBundle('kit', { bare: { command: 'srv', args: [] } });
    await install(bundle);

    expect(plugins(await readConfig())[0]).toEqual({ name: 'bare', command: 'srv', args: [] });
  });
});

describe('coexisting with a hand-written config', () => {
  it('appends after existing tables and stays valid TOML', async () => {
    // A realistic config using the tables from the spec.
    await fs.writeFile(
      path.join(projectDir, 'reasonix.toml'),
      [
        'default_model = "deepseek"',
        '',
        '[agent]',
        'temperature = 0.0',
        '',
        '[[providers]]',
        'name = "deepseek"',
        'kind = "openai"',
        'api_key_env = "DEEPSEEK_API_KEY"',
        '',
        '[[plugins]]',
        'name = "existing"',
        'command = "existing-server"',
        '',
      ].join('\n'),
    );

    const bundle = await makeBundle('kit', { added: { command: 'added-server' } });
    const record = await install(bundle);

    const config = await readConfig();
    // Our [[plugins]] entry appends to the existing array rather than replacing it.
    expect(plugins(config).map((plugin) => plugin.name)).toEqual(['existing', 'added']);
    // Everything the user wrote survives.
    expect(config.default_model).toBe('deepseek');
    expect(config.agent).toEqual({ temperature: 0 });
    expect(config.providers).toHaveLength(1);

    await rollback(record, projectDir);

    const after = await readConfig();
    expect(plugins(after).map((plugin) => plugin.name)).toEqual(['existing']);
    expect(after.default_model).toBe('deepseek');
    expect(after.providers).toHaveLength(1);
  });

  it('flags a [[plugins]] name that already exists', async () => {
    await fs.writeFile(
      path.join(projectDir, 'reasonix.toml'),
      '[[plugins]]\nname = "filesystem"\ncommand = "other"\n',
    );

    const bundle = await makeBundle('kit', { filesystem: { command: 'npx' } });
    const plan = await buildPlan(await loadBundle(bundle), 'reasonix', 'project', projectDir);

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.detail).toContain('[[plugins]] named "filesystem"');
  });

  it('does not treat reinstalling its own entry as a conflict', async () => {
    const bundle = await makeBundle('kit', { filesystem: { command: 'npx' } });
    await install(bundle);

    // install() asserts there are no conflicts, so a clean second run proves it.
    await install(bundle);
    expect(plugins(await readConfig())).toHaveLength(1);
  });
});

describe('[permissions] and other settings tables', () => {
  it('writes permission lists in the shape the spec documents', async () => {
    const bundle = await makeBundle(
      'kit',
      {},
      {
        permissions: {
          mode: 'ask',
          allow: ['Bash(go test:*)'],
          deny: ['Bash(rm -rf*)'],
          ask: [],
        },
      },
    );
    await install(bundle);

    expect((await readConfig()).permissions).toEqual({
      mode: 'ask',
      allow: ['Bash(go test:*)'],
      deny: ['Bash(rm -rf*)'],
      ask: [],
    });
  });

  it('supports nested tables such as [tools.shell]', async () => {
    const bundle = await makeBundle(
      'kit',
      {},
      { tools: { bash_timeout_seconds: 120, shell: { prefer: 'auto' } } },
    );
    await install(bundle);

    expect((await readConfig()).tools).toEqual({
      bash_timeout_seconds: 120,
      shell: { prefer: 'auto' },
    });
  });

  it('refuses to redefine a table the user already has', async () => {
    // TOML forbids defining [permissions] twice; appending would corrupt the file.
    await fs.writeFile(
      path.join(projectDir, 'reasonix.toml'),
      '[permissions]\nmode = "allow"\n',
    );

    const bundle = await makeBundle('kit', {}, { permissions: { allow: ['Bash(ls)'] } });
    const plan = await buildPlan(await loadBundle(bundle), 'reasonix', 'project', projectDir);

    expect(plan.conflicts.some((c) => c.detail.includes('[permissions]'))).toBe(true);
  });
});

describe('user scope', () => {
  it('writes config.toml rather than reasonix.toml', async () => {
    const bundle = await loadBundle(await makeBundle('kit', { fs: { command: 'npx' } }));
    const plan = await buildPlan(bundle, 'reasonix', 'user', projectDir);

    expect(plan.actions.map((action) => action.path)).toContain('config.toml');
  });
});
