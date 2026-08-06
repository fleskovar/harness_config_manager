import path from 'node:path';
import { hcmHome, resolveCacheDir } from './config.js';
import type { Scope } from './types.js';

export { hcmHome };

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

/** Checkout cache for bundles fetched from GitHub; relocatable via config. */
export function cacheDir(): Promise<string> {
  return resolveCacheDir();
}
