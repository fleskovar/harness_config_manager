/**
 * The installation ledger: which bundles are installed, into which target and
 * scope, and exactly which items each one owns.
 *
 * Project scope writes `.hcm/state.json` next to the code so it can be
 * committed; user scope writes `~/.hcm/state.json`.
 */

import { fromPosix, readJsonIfExists, writeJson } from './fsx.js';
import { stateFile } from './paths.js';
import { getTarget } from '../targets/index.js';
import {
  type InstallationRecord,
  installationId,
  isPreexisting,
  type Receipt,
  type Scope,
  type StateFile,
  type TargetId,
} from './types.js';

const EMPTY: StateFile = { version: 1, installations: [] };

export async function readState(scope: Scope, cwd: string): Promise<StateFile> {
  const state = await readJsonIfExists<StateFile>(stateFile(scope, cwd));
  if (!state || !Array.isArray(state.installations)) return { ...EMPTY, installations: [] };
  return state;
}

export async function writeState(scope: Scope, cwd: string, state: StateFile): Promise<void> {
  await writeJson(stateFile(scope, cwd), state);
}

export async function findInstallation(
  scope: Scope,
  cwd: string,
  bundle: string,
  target: TargetId,
): Promise<InstallationRecord | undefined> {
  const state = await readState(scope, cwd);
  const id = installationId(bundle, target, scope);
  return state.installations.find((record) => record.id === id);
}

/** All installations of a bundle in a scope, across targets. */
export async function findInstallations(
  scope: Scope,
  cwd: string,
  bundle: string,
): Promise<InstallationRecord[]> {
  const state = await readState(scope, cwd);
  return state.installations.filter((record) => record.bundle === bundle);
}

export async function upsertInstallation(
  scope: Scope,
  cwd: string,
  record: InstallationRecord,
): Promise<void> {
  const state = await readState(scope, cwd);
  const index = state.installations.findIndex((existing) => existing.id === record.id);
  if (index >= 0) state.installations[index] = record;
  else state.installations.push(record);
  await writeState(scope, cwd, state);
}

export async function removeInstallation(scope: Scope, cwd: string, id: string): Promise<void> {
  const state = await readState(scope, cwd);
  state.installations = state.installations.filter((record) => record.id !== id);
  await writeState(scope, cwd, state);
}

/**
 * Edit the ledger in one read-modify-write. `mutate` returns true when it
 * changed something; nothing is written otherwise, so a no-op leaves the file
 * (and its timestamp) alone.
 */
export async function mutateInstallations(
  scope: Scope,
  cwd: string,
  mutate: (installations: InstallationRecord[]) => boolean,
): Promise<void> {
  const state = await readState(scope, cwd);
  if (!mutate(state.installations)) return;
  await writeState(scope, cwd, state);
}

/**
 * Add or drop the receipt for a marker block, so that taking a section out of
 * `CLAUDE.md` by hand -- with `hcm context remove` -- does not leave the ledger
 * claiming an item that is no longer there. Returns true when it changed
 * something.
 *
 * Does nothing when the bundle has no installation record for that target: a
 * section can be cached and managed without one, and inventing a record here
 * would give `hcm uninstall` something it never installed.
 */
export function setBlockReceipt(
  installations: InstallationRecord[],
  id: string,
  block: { path: string; blockId: string },
  present: boolean,
): boolean {
  const record = installations.find((candidate) => candidate.id === id);
  if (!record) return false;

  const index = record.receipts.findIndex(
    (receipt) =>
      receipt.op === 'block' && receipt.path === block.path && receipt.blockId === block.blockId,
  );

  if (present) {
    if (index >= 0) return false;
    record.receipts.push({ op: 'block', ...block, syntax: 'markdown' });
    return true;
  }

  if (index < 0) return false;
  record.receipts.splice(index, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Claims: who is relying on what
// ---------------------------------------------------------------------------

/**
 * One installation's stake in one item.
 *
 * Ownership is not exclusive. Two bundles that ship the same shared asset --
 * because one depends on the other, or because both wrap the same service --
 * write it once and *both* claim it. The item goes away when the last claim
 * does, which is what makes uninstalling one of them safe.
 */
export interface Claim {
  /** The installation record id holding the claim. */
  id: string;
  bundle: string;
  target: TargetId;
  scope: Scope;
  /** What was written, where the receipt records a hash. Blocks have none. */
  hash?: string;
}

export interface ClaimFilter {
  /**
   * Ignore these installations' claims -- the ones being removed. A run that
   * takes several away at once has to discount all of them, or each would look
   * like a reason to keep the others' items.
   */
  excludeIds?: string[];
  /** Ignore every installation of this bundle, in any target or scope. */
  excludeBundle?: string;
}

/**
 * Every claim on every item hcm has installed, keyed by absolute location.
 *
 * Absolute, and across both scopes and all targets, because the sharing is
 * real: Claude Code and Pi write the same `.mcp.json`, OpenCode and Pi the same
 * `AGENTS.md`. Keying by scope-relative path would leave each target thinking
 * it was alone in a file it is not.
 */
export async function collectClaims(
  cwd: string,
  filter: ClaimFilter = {},
): Promise<Map<string, Claim[]>> {
  const claims = new Map<string, Claim[]>();
  const excluded = new Set(filter.excludeIds ?? []);

  for (const scope of ['project', 'user'] as Scope[]) {
    const state = await readState(scope, cwd);

    for (const record of state.installations) {
      if (excluded.has(record.id)) continue;
      if (filter.excludeBundle && record.bundle === filter.excludeBundle) continue;

      const scopeRoot = getTarget(record.target).scopeRoot(record.scope, cwd);

      for (const receipt of record.receipts) {
        // An adopted item was there before hcm and is nobody's to remove, so it
        // is no claim at all -- another bundle may adopt the same one happily.
        if (isPreexisting(receipt)) continue;

        for (const { key, hash } of claimKeys(receipt, scopeRoot)) {
          const held = claims.get(key);
          const claim: Claim = {
            id: record.id,
            bundle: record.bundle,
            target: record.target,
            scope: record.scope,
            ...(hash ? { hash } : {}),
          };
          if (held) held.push(claim);
          else claims.set(key, [claim]);
        }
      }
    }
  }

  return claims;
}

/**
 * The items *this* bundle has already written, wherever it is installed, keyed
 * the same way. Reinstalling over your own untouched item is a replacement, not
 * a conflict -- which is what makes `hcm update` work without `--force` while a
 * hand-edited item still stops it.
 */
export async function ownedReceipts(cwd: string, bundle: string): Promise<Map<string, Receipt>> {
  const owned = new Map<string, Receipt>();

  for (const scope of ['project', 'user'] as Scope[]) {
    const state = await readState(scope, cwd);

    for (const record of state.installations) {
      if (record.bundle !== bundle) continue;
      const scopeRoot = getTarget(record.target).scopeRoot(record.scope, cwd);
      for (const receipt of record.receipts) {
        for (const { key } of claimKeys(receipt, scopeRoot)) owned.set(key, receipt);
      }
    }
  }

  return owned;
}

/**
 * The keys a receipt claims, rooted at `scopeRoot`. An array receipt claims
 * each of its items separately, since another bundle may have contributed only
 * some of them.
 */
export function claimKeys(
  receipt: Receipt,
  scopeRoot: string,
): { key: string; hash?: string }[] {
  const at = claimPath(scopeRoot, receipt.path);

  switch (receipt.op) {
    case 'file':
      return [{ key: `${at}::file`, hash: receipt.hash }];
    case 'json-value':
      return [{ key: `${at}::json:${receipt.pointer.join('.')}`, hash: receipt.hash }];
    case 'json-array-item':
      return receipt.hashes.map((hash) => ({
        key: `${at}::item:${receipt.pointer.join('.')}:${hash}`,
        hash,
      }));
    case 'block':
      return [{ key: `${at}::block:${receipt.blockId}` }];
  }
}

/** The key prefix for one file: an absolute path, compared case-insensitively. */
export function claimPath(scopeRoot: string, relativePath: string): string {
  return fromPosix(scopeRoot, relativePath).toLowerCase();
}

/** The claims held on a key by anyone other than `id`. */
export function heldBy(claims: Map<string, Claim[]>, key: string, id?: string): Claim[] {
  const held = claims.get(key) ?? [];
  return id ? held.filter((claim) => claim.id !== id) : held;
}

/** Distinct bundle names in a set of claims, for messages. */
export function claimingBundles(claims: Claim[]): string[] {
  return [...new Set(claims.map((claim) => claim.bundle))].sort();
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Installations that named `bundle` as a dependency, in the same scope and
 * target -- which is the granularity an installation exists at, so it is the
 * granularity "still needed" is decided at.
 */
export async function findDependents(
  scope: Scope,
  cwd: string,
  bundle: string,
  target?: TargetId,
): Promise<InstallationRecord[]> {
  const state = await readState(scope, cwd);
  return state.installations.filter(
    (record) =>
      (target === undefined || record.target === target) &&
      record.bundle !== bundle &&
      (record.dependencies ?? []).some((dependency) => dependency.name === bundle),
  );
}
