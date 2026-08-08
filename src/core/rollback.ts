/**
 * Uninstall: replay receipts in reverse.
 *
 * Every removal re-reads the file as it is *now* and matches by structure
 * (pointer + value hash) or by marker block -- never by position. Anything
 * that no longer matches what we wrote is reported as `modified` and left
 * alone unless `--force` is given, so hand edits are never silently discarded.
 */

import path from 'node:path';
import {
  fromPosix,
  pruneEmptyDirs,
  readJsonIfExists,
  readTextIfExists,
  removeFile,
  writeJson,
  writeText,
} from './fsx.js';
import { sha256 } from './hash.js';
import { isEffectivelyEmpty, removeBlock } from '../merge/blocks.js';
import {
  type JsonObject,
  pruneEmptyAncestors,
  removeArrayItems,
  removeAtPointer,
} from '../merge/json-merge.js';
import { isPreexisting, type InstallationRecord, type Receipt } from './types.js';

export type RemovalStatus = 'removed' | 'restored' | 'missing' | 'modified' | 'partial' | 'kept';

export interface RemovalResult {
  receipt: Receipt;
  status: RemovalStatus;
  detail?: string;
}

export interface RollbackOptions {
  /** Remove items even when their current value differs from what we wrote. */
  force?: boolean;
  /** Report what would happen without touching anything. */
  dryRun?: boolean;
}

export async function rollback(
  record: InstallationRecord,
  scopeRoot: string,
  options: RollbackOptions = {},
): Promise<RemovalResult[]> {
  const results: RemovalResult[] = [];
  const groups = groupByPath(record.receipts);

  for (const [relativePath, receipts] of groups) {
    const absolutePath = fromPosix(scopeRoot, relativePath);

    if (receipts.every((receipt) => receipt.op === 'file')) {
      results.push(...(await rollbackFiles(absolutePath, scopeRoot, receipts, options)));
      continue;
    }

    if (receipts.every((receipt) => receipt.op === 'block')) {
      results.push(...(await rollbackBlocks(absolutePath, scopeRoot, receipts, options)));
      continue;
    }

    results.push(...(await rollbackJson(absolutePath, scopeRoot, receipts, options)));
  }

  return results;
}

function groupByPath(receipts: Receipt[]): Map<string, Receipt[]> {
  const groups = new Map<string, Receipt[]>();
  // Reverse so later writes are undone first.
  for (const receipt of [...receipts].reverse()) {
    const existing = groups.get(receipt.path);
    if (existing) existing.push(receipt);
    else groups.set(receipt.path, [receipt]);
  }
  return groups;
}

async function rollbackFiles(
  absolutePath: string,
  scopeRoot: string,
  receipts: Receipt[],
  options: RollbackOptions,
): Promise<RemovalResult[]> {
  const results: RemovalResult[] = [];

  for (const receipt of receipts) {
    if (receipt.op !== 'file') continue;

    if (isPreexisting(receipt)) {
      results.push({ receipt, status: 'kept', detail: 'was already here before we installed' });
      continue;
    }

    const current = await readTextIfExists(absolutePath);
    if (current === undefined) {
      results.push({ receipt, status: 'missing' });
      continue;
    }

    if (sha256(current) !== receipt.hash && !options.force) {
      results.push({ receipt, status: 'modified', detail: 'edited since install' });
      continue;
    }

    if (!options.dryRun) {
      await removeFile(absolutePath);
      await pruneEmptyDirs(path.dirname(absolutePath), scopeRoot);
    }
    results.push({ receipt, status: 'removed' });
  }

  return results;
}

async function rollbackBlocks(
  absolutePath: string,
  scopeRoot: string,
  receipts: Receipt[],
  options: RollbackOptions,
): Promise<RemovalResult[]> {
  const results: RemovalResult[] = [];
  const original = await readTextIfExists(absolutePath);

  if (original === undefined) {
    return receipts.map((receipt) => ({ receipt, status: 'missing' as const }));
  }

  let content = original;

  for (const receipt of receipts) {
    if (receipt.op !== 'block') continue;
    const next = removeBlock(content, receipt.syntax, receipt.blockId);
    if (next === undefined) {
      results.push({ receipt, status: 'missing', detail: 'marker block not found' });
      continue;
    }
    content = next;
    results.push({ receipt, status: 'removed' });
  }

  if (!options.dryRun && content !== original) {
    // Nothing but our blocks was ever in here, so take the file away too.
    if (isEffectivelyEmpty(content)) {
      await removeFile(absolutePath);
      await pruneEmptyDirs(path.dirname(absolutePath), scopeRoot);
    } else {
      await writeText(absolutePath, content);
    }
  }

  return results;
}

async function rollbackJson(
  absolutePath: string,
  scopeRoot: string,
  receipts: Receipt[],
  options: RollbackOptions,
): Promise<RemovalResult[]> {
  const results: RemovalResult[] = [];
  const doc = await readJsonIfExists<JsonObject>(absolutePath);

  if (doc === undefined) {
    return receipts.map((receipt) => ({
      receipt,
      status: isPreexisting(receipt) ? ('kept' as const) : ('missing' as const),
    }));
  }

  let changed = false;

  for (const receipt of receipts) {
    if (receipt.op === 'json-value') {
      if (isPreexisting(receipt)) {
        results.push({ receipt, status: 'kept', detail: 'was already here before we installed' });
        continue;
      }

      const outcome = removeAtPointer(doc, receipt.pointer, receipt.hash, {
        restore: receipt.previous,
        hadPrevious: receipt.hadPrevious,
        force: options.force ?? false,
      });
      if (outcome === 'modified') {
        results.push({ receipt, status: 'modified', detail: 'value changed since install' });
        continue;
      }
      if (outcome === 'removed') {
        changed = true;
        pruneEmptyAncestors(doc, receipt.pointer);
      } else if (outcome === 'restored') {
        changed = true;
      }
      results.push({ receipt, status: outcome });
      continue;
    }

    if (receipt.op === 'json-array-item') {
      const { removed, missing } = removeArrayItems(doc, receipt.pointer, receipt.hashes);
      if (removed > 0) {
        changed = true;
        pruneEmptyAncestors(doc, receipt.pointer);
      }

      const status: RemovalStatus =
        removed === 0 ? 'missing' : missing > 0 ? 'partial' : 'removed';
      results.push({
        receipt,
        status,
        ...(missing > 0 ? { detail: `${missing} item(s) already gone` } : {}),
      });
    }
  }

  if (!options.dryRun && changed) {
    // An empty JSON document carries no information, so remove the file too.
    if (Object.keys(doc).length === 0) {
      await removeFile(absolutePath);
      await pruneEmptyDirs(path.dirname(absolutePath), scopeRoot);
    } else {
      await writeJson(absolutePath, doc);
    }
  }

  return results;
}

/** Check whether everything a record claims is still present and unmodified. */
export async function auditInstallation(
  record: InstallationRecord,
  scopeRoot: string,
): Promise<RemovalResult[]> {
  return rollback(record, scopeRoot, { dryRun: true });
}
