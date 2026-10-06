/**
 * Bundles that ship inside the hcm package itself.
 *
 * They are always available, on a fresh machine with an empty registry, and
 * they always match the hcm that is running: the files are read in place from
 * the package, never copied into the store, so upgrading hcm upgrades them and
 * `hcm update` carries the new version into every project that installed one.
 *
 * They are never written to `registry.json` either. The registry describes what
 * the user chose to add; these come with the program, and a path recorded there
 * would go stale the moment the package moved -- a new Node version, a global
 * reinstall, an `npx` cache.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuiltinBundle {
  /**
   * Fixed rather than assigned, and reserved: `nextRegistryId` never hands it
   * out, a registry file holding it is renumbered, and no bundle may be called
   * it. So it reads the same on every machine -- which is what lets
   * documentation say `hcm install 0`.
   */
  id: string;
  /** The manifest name, reserved: `hcm registry add` refuses to reuse it. */
  name: string;
  /** Directory under `builtin/` in the package. */
  dir: string;
}

export const BUILTIN_BUNDLES: readonly BuiltinBundle[] = [{ id: '0', name: 'hcm', dir: 'hcm' }];

/**
 * `builtin/` at the package root. Two levels up holds in both layouts:
 * `src/core/builtin.ts` under tsx, and `dist/core/builtin.js` once published.
 */
const BUILTIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'builtin');

export function builtinDir(bundle: BuiltinBundle): string {
  return path.join(BUILTIN_ROOT, bundle.dir);
}

/** The built-in bundle a reference names, by name or id. */
export function findBuiltin(reference: string): BuiltinBundle | undefined {
  const wanted = reference.trim().toLowerCase();
  return BUILTIN_BUNDLES.find(
    (bundle) => bundle.name.toLowerCase() === wanted || bundle.id === wanted,
  );
}

/** An id that belongs to a built-in bundle and is never given to a registered one. */
export function isReservedId(id: string): boolean {
  return BUILTIN_BUNDLES.some((bundle) => bundle.id === id.trim().toLowerCase());
}

export function isBuiltinName(name: string): boolean {
  return BUILTIN_BUNDLES.some((bundle) => bundle.name === name);
}
