/**
 * The installation ledger: which bundles are installed, into which target and
 * scope, and exactly which items each one owns.
 *
 * Project scope writes `.hcm/state.json` next to the code so it can be
 * committed; user scope writes `~/.hcm/state.json`.
 */

import { readJsonIfExists, writeJson } from './fsx.js';
import { stateFile } from './paths.js';
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
 * Index of every item currently owned by *other* bundles in this scope+target,
 * used to detect cross-bundle conflicts before writing.
 * Keys are `path::descriptor`, values are the owning bundle name.
 */
export async function ownershipIndex(
  scope: Scope,
  cwd: string,
  target: TargetId,
  excludeBundle?: string,
): Promise<Map<string, string>> {
  const state = await readState(scope, cwd);
  const index = new Map<string, string>();

  for (const record of state.installations) {
    if (record.target !== target) continue;
    if (excludeBundle && record.bundle === excludeBundle) continue;
    for (const receipt of record.receipts) {
      // Adopted items were not created by that bundle, so it has no claim on
      // them -- another bundle may adopt the same item quite happily.
      if (isPreexisting(receipt)) continue;
      for (const key of ownershipKeys(receipt)) index.set(key, record.bundle);
    }
  }

  return index;
}

/**
 * The items *this* bundle already owns in this scope+target, keyed the same way
 * as `ownershipIndex`. Reinstalling over your own untouched item is a
 * replacement, not a conflict -- which is what makes `hcm update` work without
 * `--force` while a hand-edited item still stops it.
 */
export async function ownedReceipts(
  scope: Scope,
  cwd: string,
  target: TargetId,
  bundle: string,
): Promise<Map<string, Receipt>> {
  const state = await readState(scope, cwd);
  const owned = new Map<string, Receipt>();

  for (const record of state.installations) {
    if (record.target !== target || record.bundle !== bundle) continue;
    for (const receipt of record.receipts) {
      for (const key of ownershipKeys(receipt)) owned.set(key, receipt);
    }
  }

  return owned;
}

/** The ownership keys a receipt claims. Arrays claim each item separately. */
export function ownershipKeys(receipt: Receipt): string[] {
  switch (receipt.op) {
    case 'file':
      return [`${receipt.path}::file`];
    case 'json-value':
      return [`${receipt.path}::json:${receipt.pointer.join('.')}`];
    case 'json-array-item':
      return receipt.hashes.map((hash) => `${receipt.path}::item:${receipt.pointer.join('.')}:${hash}`);
    case 'block':
      return [`${receipt.path}::block:${receipt.blockId}`];
  }
}
