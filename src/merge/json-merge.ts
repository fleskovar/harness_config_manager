/**
 * Structural merge into JSON documents.
 *
 * JSON has no comments, so we cannot leave markers behind. Instead every write
 * is recorded as (pointer, hash-of-written-value). On uninstall we resolve the
 * pointer in the *current* file and only remove the item when it still hashes
 * to what we wrote. That survives reformatting, key reordering and other
 * bundles adding sibling keys, and it refuses to clobber edits the user made
 * by hand.
 */

import { hashValue, valuesEqual } from '../core/hash.js';

export type JsonObject = Record<string, unknown>;

/** Read a value at a pointer, or `undefined` when any segment is missing. */
export function getAtPointer(root: unknown, pointer: string[]): unknown {
  let current: unknown = root;
  for (const key of pointer) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[key];
  }
  return current;
}

export function hasPointer(root: unknown, pointer: string[]): boolean {
  let current: unknown = root;
  for (let i = 0; i < pointer.length; i += 1) {
    const key = pointer[i] as string;
    if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return false;
    current = (current as JsonObject)[key];
  }
  return true;
}

export interface SetResult {
  /** The value previously stored at the pointer, when there was one. */
  previous?: unknown;
  hadPrevious: boolean;
}

/**
 * Set a value at a pointer, creating intermediate objects as needed.
 * Mutates `root`.
 */
export function setAtPointer(root: JsonObject, pointer: string[], value: unknown): SetResult {
  if (pointer.length === 0) throw new Error('setAtPointer requires a non-empty pointer');

  let current: JsonObject = root;

  for (let i = 0; i < pointer.length - 1; i += 1) {
    const key = pointer[i] as string;
    const existing = current[key];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) current[key] = {};
    current = current[key] as JsonObject;
  }

  const leaf = pointer[pointer.length - 1] as string;
  const hadPrevious = Object.prototype.hasOwnProperty.call(current, leaf);
  const previous = hadPrevious ? current[leaf] : undefined;
  current[leaf] = value;

  return hadPrevious ? { previous, hadPrevious } : { hadPrevious };
}

/**
 * Remove a value at a pointer, but only when it still matches `expectedHash`.
 * Returns what happened so callers can report honestly.
 */
export type RemoveOutcome = 'removed' | 'restored' | 'missing' | 'modified';

export function removeAtPointer(
  root: JsonObject,
  pointer: string[],
  expectedHash: string,
  options: { restore?: unknown; hadPrevious?: boolean; force?: boolean } = {},
): RemoveOutcome {
  const parentPointer = pointer.slice(0, -1);
  const leaf = pointer[pointer.length - 1] as string;
  const parent = getAtPointer(root, parentPointer);

  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return 'missing';
  const parentObject = parent as JsonObject;
  if (!Object.prototype.hasOwnProperty.call(parentObject, leaf)) return 'missing';

  const currentHash = hashValue(parentObject[leaf]);
  if (currentHash !== expectedHash && !options.force) return 'modified';

  if (options.hadPrevious) {
    parentObject[leaf] = options.restore;
    return 'restored';
  }

  delete parentObject[leaf];
  return 'removed';
}

/**
 * Append items to an array at a pointer, skipping values already present.
 * Used for additive lists such as permission allow-lists.
 */
export function appendArrayItems(
  root: JsonObject,
  pointer: string[],
  items: unknown[],
): { appended: unknown[] } {
  let current: JsonObject = root;

  for (let i = 0; i < pointer.length - 1; i += 1) {
    const key = pointer[i] as string;
    const existing = current[key];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) current[key] = {};
    current = current[key] as JsonObject;
  }

  const leaf = pointer[pointer.length - 1] as string;
  if (!Array.isArray(current[leaf])) current[leaf] = [];

  const array = current[leaf] as unknown[];
  const appended: unknown[] = [];
  for (const item of items) {
    if (array.some((existing) => valuesEqual(existing, item))) continue;
    array.push(item);
    appended.push(item);
  }

  return { appended };
}

/** Remove array items whose canonical hash matches any of `hashes`. */
export function removeArrayItems(
  root: JsonObject,
  pointer: string[],
  hashes: string[],
): { removed: number; missing: number } {
  const target = getAtPointer(root, pointer);
  if (!Array.isArray(target)) return { removed: 0, missing: hashes.length };

  const wanted = new Set(hashes);
  let removed = 0;
  const kept = target.filter((item) => {
    const itemHash = hashValue(item);
    if (wanted.has(itemHash)) {
      wanted.delete(itemHash);
      removed += 1;
      return false;
    }
    return true;
  });

  target.length = 0;
  target.push(...kept);
  return { removed, missing: wanted.size };
}

/**
 * After removing an item, delete any now-empty containers above it, innermost
 * first, so uninstalling does not leave `{"mcpServers": {}}` behind.
 *
 * An empty object or array carries no configuration, so this is information
 * preserving -- and unlike tracking which containers we created at install
 * time, it stays correct across reinstalls.
 */
export function pruneEmptyAncestors(root: JsonObject, pointer: string[]): void {
  for (let depth = pointer.length; depth > 0; depth -= 1) {
    const current = pointer.slice(0, depth);
    const value = getAtPointer(root, current);

    // The leaf itself is normally already gone; keep walking up from there.
    if (value !== undefined) {
      const isEmpty =
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value) &&
          Object.keys(value).length === 0);
      if (!isEmpty) return;
    }

    const parent = getAtPointer(root, current.slice(0, -1));
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return;
    delete (parent as JsonObject)[current[current.length - 1] as string];
  }
}

/**
 * Flatten a settings fragment into leaf pointers.
 *
 * Objects are walked; arrays and primitives are treated as leaves so that each
 * one becomes an independently revocable receipt. `arrayPointers` marks the
 * pointers whose arrays should be appended to rather than replaced.
 */
export function flattenLeaves(
  fragment: unknown,
  basePointer: string[] = [],
): { pointer: string[]; value: unknown }[] {
  if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) {
    return basePointer.length ? [{ pointer: basePointer, value: fragment }] : [];
  }

  const out: { pointer: string[]; value: unknown }[] = [];
  for (const [key, value] of Object.entries(fragment as JsonObject)) {
    const pointer = [...basePointer, key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = flattenLeaves(value, pointer);
      // An empty object is itself a meaningful leaf.
      if (nested.length === 0) out.push({ pointer, value });
      else out.push(...nested);
    } else {
      out.push({ pointer, value });
    }
  }
  return out;
}
