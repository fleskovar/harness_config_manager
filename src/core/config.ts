/**
 * User configuration.
 *
 * The config file itself always lives at `<hcm home>/config.json` -- it has to
 * live somewhere fixed, or there would be no way to find out where things were
 * moved to. `HCM_HOME` relocates the whole home directory; the settings inside
 * relocate individual pieces.
 */

import os from 'node:os';
import path from 'node:path';
import { HcmError } from './errors.js';
import { readJsonIfExists, writeJson } from './fsx.js';

export interface HcmConfig {
  /**
   * Where bundles fetched from GitHub are stored. Acts as a shared cache, so a
   * bundle downloaded once can be installed into many projects.
   */
  cacheDir?: string;
  /**
   * Where registered bundles are kept: one directory per registry entry, which
   * is what `hcm install <name>` reads and `hcm update` refreshes.
   */
  storeDir?: string;
  /**
   * Whether a command spanning several harnesses has to be told which one it
   * means. See `core/harnesses.ts` for what each value does.
   */
  requireTarget?: RequireTargetPolicy;
}

/** Settings a user may set, with the help text shown by `hcm config`. */
export const CONFIG_KEYS: Record<keyof HcmConfig, string> = {
  cacheDir: 'Directory holding bundles downloaded from GitHub',
  storeDir: 'Directory holding the registered bundles themselves',
  requireTarget: 'When to insist on -t: auto (multi-harness folders), always, never',
};

// ---------------------------------------------------------------------------
// requireTarget
// ---------------------------------------------------------------------------

/**
 * `auto`   ask for `-t` when the folder is set up for several harnesses and the
 *          command would touch more than one of them. The default.
 * `always` ask whenever a command would touch more than one, however the folder
 *          looks.
 * `never`  never ask; the blanket defaults hcm had before harnesses were
 *          detected at all.
 */
export type RequireTargetPolicy = 'auto' | 'always' | 'never';

export const REQUIRE_TARGET_POLICIES: RequireTargetPolicy[] = ['auto', 'always', 'never'];

export const DEFAULT_REQUIRE_TARGET: RequireTargetPolicy = 'auto';

export function assertRequireTargetPolicy(value: string): asserts value is RequireTargetPolicy {
  if (!REQUIRE_TARGET_POLICIES.includes(value as RequireTargetPolicy)) {
    throw new HcmError(
      `Invalid value "${value}" for requireTarget`,
      `Valid values: ${REQUIRE_TARGET_POLICIES.join(', ')}`,
    );
  }
}

/** Precedence: HCM_REQUIRE_TARGET, then config.json, then `auto`. */
export async function resolveRequireTarget(): Promise<RequireTargetPolicy> {
  const raw = process.env.HCM_REQUIRE_TARGET ?? (await readConfig()).requireTarget;
  if (!raw) return DEFAULT_REQUIRE_TARGET;
  assertRequireTargetPolicy(raw);
  return raw;
}

export function hcmHome(): string {
  return process.env.HCM_HOME ?? path.join(os.homedir(), '.hcm');
}

export function configFile(): string {
  return process.env.HCM_CONFIG ?? path.join(hcmHome(), 'config.json');
}

export async function readConfig(): Promise<HcmConfig> {
  return (await readJsonIfExists<HcmConfig>(configFile())) ?? {};
}

export async function writeConfig(config: HcmConfig): Promise<void> {
  await writeJson(configFile(), config);
}

/** Expand a leading `~` and make the path absolute. */
export function expandPath(value: string): string {
  const expanded = value.startsWith('~')
    ? path.join(os.homedir(), value.slice(1).replace(/^[/\\]/, ''))
    : value;
  return path.resolve(expanded);
}

/**
 * Resolve the bundle cache directory.
 * Precedence: HCM_CACHE_DIR, then config.json, then `<hcm home>/cache`.
 */
export async function resolveCacheDir(): Promise<string> {
  if (process.env.HCM_CACHE_DIR) return expandPath(process.env.HCM_CACHE_DIR);
  const config = await readConfig();
  if (config.cacheDir) return expandPath(config.cacheDir);
  return path.join(hcmHome(), 'cache');
}

/**
 * Resolve the bundle store directory.
 * Precedence: HCM_STORE_DIR, then config.json, then `<hcm home>/store`.
 */
export async function resolveStoreDir(): Promise<string> {
  if (process.env.HCM_STORE_DIR) return expandPath(process.env.HCM_STORE_DIR);
  const config = await readConfig();
  if (config.storeDir) return expandPath(config.storeDir);
  return path.join(hcmHome(), 'store');
}

/**
 * Env var and default for each setting, so one lookup covers them all.
 * `path` marks the settings whose values are directories: those are expanded
 * and made absolute, and the others -- `requireTarget` is a word, not a place
 * -- are reported exactly as written.
 */
const SETTING_SOURCES: Record<
  keyof HcmConfig,
  { env: string; fallback: () => string; path?: boolean }
> = {
  cacheDir: { env: 'HCM_CACHE_DIR', fallback: () => path.join(hcmHome(), 'cache'), path: true },
  storeDir: { env: 'HCM_STORE_DIR', fallback: () => path.join(hcmHome(), 'store'), path: true },
  requireTarget: { env: 'HCM_REQUIRE_TARGET', fallback: () => DEFAULT_REQUIRE_TARGET },
};

/** True for settings holding a directory, which are expanded before use. */
export function isPathSetting(key: keyof HcmConfig): boolean {
  return SETTING_SOURCES[key]?.path === true;
}

/** Where a setting's current value comes from, for `hcm config` output. */
export async function describeSetting(
  key: keyof HcmConfig,
): Promise<{ value: string; origin: 'env' | 'config' | 'default' }> {
  const setting = SETTING_SOURCES[key];
  if (!setting) throw new HcmError(`Unknown setting "${key}"`);

  const read = (value: string): string => (setting.path ? expandPath(value) : value);

  const fromEnv = process.env[setting.env];
  if (fromEnv) return { value: read(fromEnv), origin: 'env' };

  const config = await readConfig();
  const fromConfig = config[key];
  if (fromConfig) return { value: read(fromConfig), origin: 'config' };

  return { value: setting.fallback(), origin: 'default' };
}

export function assertConfigKey(key: string): asserts key is keyof HcmConfig {
  if (!(key in CONFIG_KEYS)) {
    throw new HcmError(
      `Unknown setting "${key}"`,
      `Known settings: ${Object.keys(CONFIG_KEYS).join(', ')}`,
    );
  }
}
