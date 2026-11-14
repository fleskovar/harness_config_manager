import { spawn } from 'node:child_process';
import path from 'node:path';
import { HcmError } from '../core/errors.js';
import { color, log } from '../core/logger.js';
import { compareVersionStrings, isValidVersion } from '../core/semver.js';

/** The npm package that puts `hcm` on the PATH. */
export const PACKAGE_NAME = 'harness-config-manager';

/** The two ways `hcm upgrade` calls npm. A port, so that tests do not call the real npm. */
export interface NpmRunner {
  /** Run npm and return its standard output. Reject if npm fails. */
  capture(args: readonly string[]): Promise<string>;
  /** Run npm with its output on the console. Resolve with the exit code. */
  run(args: readonly string[]): Promise<number>;
}

export interface UpgradeOptions {
  /** Only report if a newer version is available. Do not install it. */
  check?: boolean;
  /** The version of the hcm that runs now. */
  currentVersion: string;
  /** The folder that holds the `package.json` of the hcm that runs now. */
  packageRoot: string;
  npm?: NpmRunner;
}

/**
 * Upgrade hcm to the latest version on npm.
 *
 * The command is a short name for `npm install -g harness-config-manager@<latest>`.
 * It refuses to run when this hcm is not the global npm install: an `npm link`
 * copy or an `npx` copy is not the one that npm replaces.
 */
export async function upgradeCommand(options: UpgradeOptions): Promise<void> {
  const npm = options.npm ?? systemNpm;
  const current = options.currentVersion;
  const latest = await latestVersion(npm);

  if (compareVersionStrings(current, latest) >= 0) {
    log.success(`hcm ${current} is the latest version.`);
    return;
  }

  if (options.check) {
    log.info(
      `hcm ${color.bold(latest)} is available. This version is ${current}. ` +
        `Run "hcm upgrade" to install it.`,
    );
    return;
  }

  await assertGlobalInstall(npm, options.packageRoot);

  const spec = `${PACKAGE_NAME}@${latest}`;
  log.step(`Upgrade hcm ${current} → ${latest}: npm install -g ${spec}`);
  const exitCode = await npm.run(['install', '-g', spec]);
  if (exitCode !== 0) {
    throw new HcmError(
      `npm stopped with exit code ${exitCode}. hcm is still ${current}.`,
      'Read the npm output above. If npm reports a permission error, run the command ' +
        `as an administrator: npm install -g ${spec}`,
    );
  }

  log.success(`hcm is now ${latest}.`);
}

async function latestVersion(npm: NpmRunner): Promise<string> {
  let output: string;
  try {
    output = await npm.capture(['view', PACKAGE_NAME, 'version']);
  } catch (error) {
    throw new HcmError(
      `Cannot read the latest version of ${PACKAGE_NAME} from npm: ${(error as Error).message}`,
      'Make sure that npm is on the PATH and that the npm registry is reachable.',
    );
  }

  const latest = output.trim();
  if (!isValidVersion(latest)) {
    throw new HcmError(`npm returned "${latest}", which is not a version.`);
  }
  return latest;
}

async function assertGlobalInstall(npm: NpmRunner, packageRoot: string): Promise<void> {
  let globalRoot: string;
  try {
    globalRoot = (await npm.capture(['root', '-g'])).trim();
  } catch (error) {
    throw new HcmError(`Cannot find the global npm folder: ${(error as Error).message}`);
  }

  const expected = path.join(globalRoot, PACKAGE_NAME);
  if (!samePath(expected, packageRoot)) {
    throw new HcmError(
      `This hcm runs from ${packageRoot}, not from the global npm install (${expected}).`,
      `To install the global copy, run: npm install -g ${PACKAGE_NAME}@latest`,
    );
  }
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

/**
 * The real npm.
 *
 * On Windows, npm is `npm.cmd`, and Node runs a `.cmd` file only through a
 * shell. The arguments come from this module only, so the shell is safe.
 */
const systemNpm: NpmRunner = {
  capture(args) {
    return new Promise((resolve, reject) => {
      const child = spawnNpm(args, ['ignore', 'pipe', 'pipe']);
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `npm stopped with exit code ${code}`));
      });
    });
  },
  run(args) {
    return new Promise((resolve, reject) => {
      const child = spawnNpm(args, 'inherit');
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });
  },
};

function spawnNpm(
  args: readonly string[],
  stdio: 'inherit' | ['ignore', 'pipe', 'pipe'],
): ReturnType<typeof spawn> {
  return process.platform === 'win32'
    ? spawn(['npm', ...args].join(' '), { shell: true, stdio })
    : spawn('npm', [...args], { stdio });
}
