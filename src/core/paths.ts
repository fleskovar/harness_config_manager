import path from 'node:path';
import { hcmHome, resolveCacheDir, resolveStoreDir } from './config.js';
import type { Scope } from './types.js';

export { hcmHome };

/** The directory holding everything hcm records about a scope. */
export function hcmDir(scope: Scope, cwd: string): string {
  return scope === 'user' ? hcmHome() : path.join(cwd, '.hcm');
}

/** Where install receipts are recorded for a given scope. */
export function stateFile(scope: Scope, cwd: string): string {
  return path.join(hcmDir(scope, cwd), 'state.json');
}

/** The ledger of cached context sections and where each one has been written. */
export function contextLedgerFile(scope: Scope, cwd: string): string {
  return path.join(hcmDir(scope, cwd), 'context.json');
}

/** Where the copies of those sections live, one file per section. */
export function contextCacheDir(scope: Scope, cwd: string): string {
  return path.join(hcmDir(scope, cwd), 'context');
}

/** The registry of known bundles is always user-level. */
export function registryFile(): string {
  return path.join(hcmHome(), 'registry.json');
}

/** Checkout cache for bundles fetched from GitHub; relocatable via config. */
export function cacheDir(): Promise<string> {
  return resolveCacheDir();
}

/**
 * Where registered bundles live: one directory per registry entry. This is the
 * folder `hcm registry open` shows, and the copy installs read from.
 */
export function storeDir(): Promise<string> {
  return resolveStoreDir();
}
