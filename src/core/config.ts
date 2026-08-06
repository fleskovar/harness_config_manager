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
}

/** Settings a user may set, with the help text shown by `hcm config`. */
export const CONFIG_KEYS: Record<keyof HcmConfig, string> = {
  cacheDir: 'Directory holding bundles downloaded from GitHub',
};

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

/** Where a setting's current value comes from, for `hcm config` output. */
export async function describeSetting(
  key: keyof HcmConfig,
): Promise<{ value: string; origin: 'env' | 'config' | 'default' }> {
  if (key === 'cacheDir') {
    if (process.env.HCM_CACHE_DIR) {
      return { value: expandPath(process.env.HCM_CACHE_DIR), origin: 'env' };
    }
    const config = await readConfig();
    if (config.cacheDir) return { value: expandPath(config.cacheDir), origin: 'config' };
    return { value: path.join(hcmHome(), 'cache'), origin: 'default' };
  }
  throw new HcmError(`Unknown setting "${key}"`);
}

export function assertConfigKey(key: string): asserts key is keyof HcmConfig {
  if (!(key in CONFIG_KEYS)) {
    throw new HcmError(
      `Unknown setting "${key}"`,
      `Known settings: ${Object.keys(CONFIG_KEYS).join(', ')}`,
    );
  }
}
