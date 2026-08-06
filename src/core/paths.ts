import os from 'node:os';
import path from 'node:path';
import type { Scope } from './types.js';

/** Everything hcm owns lives under one directory per scope. */
export function hcmHome(): string {
  return process.env.HCM_HOME ?? path.join(os.homedir(), '.hcm');
}

/** Where install receipts are recorded for a given scope. */
export function stateFile(scope: Scope, cwd: string): string {
  return scope === 'user'
    ? path.join(hcmHome(), 'state.json')
    : path.join(cwd, '.hcm', 'state.json');
}

/** The registry of known bundles is always user-level. */
export function registryFile(): string {
  return path.join(hcmHome(), 'registry.json');
}

/** Checkout cache for bundles fetched from GitHub. */
export function cacheDir(): string {
  return path.join(hcmHome(), 'cache');
}
