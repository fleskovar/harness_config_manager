/**
 * What each installed bundle brings to a project: its items, and every file or
 * file entry that each item wrote. `hcm list --analysis` prints it.
 *
 * Installed files keep the names that the harness expects, so the file system
 * cannot tell which bundle owns them. The receipts can: each one records its
 * path, and, since this module exists, the bundle item it came from.
 */

import os from 'node:os';
import path from 'node:path';
import { toPosix } from './fsx.js';
import { claimKeys, type Claim } from './state.js';
import {
  describeReceipt,
  isPreexisting,
  KIND_DIRECTORIES,
  type InstallationRecord,
  type Receipt,
  type ResourceKind,
  type Scope,
  type TargetId,
} from './types.js';
import { getTarget } from '../targets/index.js';

/** One file, or one entry in a file, that an installation wrote. */
export interface AnalyzedEntry {
  op: Receipt['op'];
  /**
   * Where it is: relative to the project for project scope, from `~/` or as an
   * absolute path for user scope.
   */
  path: string;
  /** The path, plus the key or block inside the file for a partial entry. */
  location: string;
  /** It was there before hcm, so hcm does not remove it. */
  adopted: boolean;
  /** The other bundles that claim the same file or entry. */
  sharedWith: string[];
}

/**
 * One item of a bundle as installed. `kind` is `unknown` for receipts written
 * before hcm recorded the item. Those receipts are grouped under one item.
 */
export interface AnalyzedItem {
  kind: ResourceKind | 'unknown';
  name: string;
  entries: AnalyzedEntry[];
}

export interface AnalyzedInstallation {
  bundle: string;
  version: string;
  scope: Scope;
  target: TargetId;
  items: AnalyzedItem[];
}

/** The order in which items are shown: the order of the bundle schema. */
const KIND_ORDER: (ResourceKind | 'unknown')[] = [...Object.values(KIND_DIRECTORIES), 'unknown'];

/**
 * The item of a receipt. A context block without an item still names it: its
 * block id is `<bundle>/<resource>`.
 */
function itemKey(receipt: Receipt): { kind: ResourceKind | 'unknown'; name: string } {
  if (receipt.item) return receipt.item;
  if (receipt.op === 'block') {
    return { kind: 'context', name: receipt.blockId.slice(receipt.blockId.indexOf('/') + 1) };
  }
  return { kind: 'unknown', name: '' };
}

/** A path as a person finds it: in the project, under `~/`, or absolute. */
export function displayPath(scopeRoot: string, relative: string, cwd: string): string {
  const absolute = path.resolve(scopeRoot, ...relative.split('/'));
  for (const [base, prefix] of [
    [path.resolve(cwd), ''],
    [os.homedir(), '~/'],
  ] as const) {
    const inside = path.relative(base, absolute);
    if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) {
      return `${prefix}${toPosix(inside)}`;
    }
  }
  return toPosix(absolute);
}

/**
 * Break installations down into items and entries.
 *
 * `claims` is what `collectClaims` returns: every claim on every file and
 * entry. An entry that another bundle also claims is marked with that bundle,
 * because uninstalling one of them leaves the entry in place.
 */
export function analyzeInstallations(
  records: InstallationRecord[],
  claims: Map<string, Claim[]>,
  cwd: string,
): AnalyzedInstallation[] {
  return records.map((record) => {
    const scopeRoot = getTarget(record.target).scopeRoot(record.scope, cwd);
    const items = new Map<string, AnalyzedItem>();

    for (const receipt of record.receipts) {
      const { kind, name } = itemKey(receipt);
      const key = `${kind}:${name}`;
      let item = items.get(key);
      if (!item) {
        item = { kind, name, entries: [] };
        items.set(key, item);
      }

      const others = new Set<string>();
      for (const { key: claimKey } of claimKeys(receipt, scopeRoot)) {
        for (const claim of claims.get(claimKey) ?? []) {
          if (claim.bundle !== record.bundle) others.add(claim.bundle);
        }
      }

      const shown = displayPath(scopeRoot, receipt.path, cwd);
      item.entries.push({
        op: receipt.op,
        path: shown,
        location: shown + describeReceipt(receipt).slice(receipt.path.length),
        adopted: isPreexisting(receipt),
        sharedWith: [...others].sort(),
      });
    }

    const sorted = [...items.values()].sort(
      (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name),
    );
    for (const item of sorted) item.entries.sort((a, b) => a.location.localeCompare(b.location));

    return {
      bundle: record.bundle,
      version: record.version,
      scope: record.scope,
      target: record.target,
      items: sorted,
    };
  });
}
