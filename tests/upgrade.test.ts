/**
 * `hcm upgrade`: a short name for `npm install -g harness-config-manager@<latest>`.
 * A fake npm records the calls, so that no test calls the real npm.
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HcmError } from '../src/core/errors.js';
import { PACKAGE_NAME, upgradeCommand, type NpmRunner } from '../src/commands/upgrade.js';

const GLOBAL_ROOT = path.resolve('/usr/lib/node_modules');
const GLOBAL_PACKAGE = path.join(GLOBAL_ROOT, PACKAGE_NAME);

interface FakeNpm extends NpmRunner {
  installs: string[][];
}

function fakeNpm(latest: string, options: { exitCode?: number; offline?: boolean } = {}): FakeNpm {
  const installs: string[][] = [];
  return {
    installs,
    async capture(args) {
      if (options.offline) throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
      if (args[0] === 'view') return `${latest}\n`;
      if (args[0] === 'root') return `${GLOBAL_ROOT}\n`;
      throw new Error(`unexpected npm ${args.join(' ')}`);
    },
    async run(args) {
      installs.push([...args]);
      return options.exitCode ?? 0;
    },
  };
}

let output: string[];

beforeEach(() => {
  output = [];
  const record = (...parts: unknown[]) => output.push(parts.join(' '));
  vi.spyOn(console, 'log').mockImplementation(record);
  vi.spyOn(console, 'warn').mockImplementation(record);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hcm upgrade', () => {
  it('installs the latest version when it is newer', async () => {
    const npm = fakeNpm('0.2.0');
    await upgradeCommand({ currentVersion: '0.1.6', packageRoot: GLOBAL_PACKAGE, npm });

    expect(npm.installs).toEqual([['install', '-g', `${PACKAGE_NAME}@0.2.0`]]);
    expect(output.join('\n')).toContain('hcm is now 0.2.0');
  });

  it('does nothing when this version is the latest', async () => {
    const npm = fakeNpm('0.1.6');
    await upgradeCommand({ currentVersion: '0.1.6', packageRoot: GLOBAL_PACKAGE, npm });

    expect(npm.installs).toEqual([]);
    expect(output.join('\n')).toContain('0.1.6 is the latest version');
  });

  it('does not downgrade a version that is newer than the published one', async () => {
    const npm = fakeNpm('0.1.6');
    await upgradeCommand({ currentVersion: '0.2.0-beta.1', packageRoot: GLOBAL_PACKAGE, npm });

    expect(npm.installs).toEqual([]);
  });

  it('only reports the new version with --check', async () => {
    const npm = fakeNpm('0.2.0');
    await upgradeCommand({
      check: true,
      currentVersion: '0.1.6',
      packageRoot: '/somewhere/else',
      npm,
    });

    expect(npm.installs).toEqual([]);
    expect(output.join('\n')).toContain('is available');
  });

  it('refuses when this hcm is not the global npm install', async () => {
    const npm = fakeNpm('0.2.0');
    const run = upgradeCommand({
      currentVersion: '0.1.6',
      packageRoot: path.resolve('/home/me/src/harness_config_manager'),
      npm,
    });

    await expect(run).rejects.toThrow(/not from the global npm install/);
    expect(npm.installs).toEqual([]);
  });

  it('reports a failed npm install as an error', async () => {
    const npm = fakeNpm('0.2.0', { exitCode: 1 });
    const run = upgradeCommand({ currentVersion: '0.1.6', packageRoot: GLOBAL_PACKAGE, npm });

    await expect(run).rejects.toThrow(/exit code 1\. hcm is still 0\.1\.6/);
  });

  it('reports an unreachable registry as an error', async () => {
    const npm = fakeNpm('0.2.0', { offline: true });
    const run = upgradeCommand({ currentVersion: '0.1.6', packageRoot: GLOBAL_PACKAGE, npm });

    await expect(run).rejects.toBeInstanceOf(HcmError);
    await expect(run).rejects.toThrow(/ENOTFOUND/);
  });
});
