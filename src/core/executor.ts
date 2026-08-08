/**
 * Applying a plan and recording receipts.
 *
 * Actions touching the same file are grouped so each file is read once and
 * written once, which keeps JSON key order stable and avoids half-written
 * documents when several resources land in the same place.
 */

import {
  fromPosix,
  pathExists,
  readJsonIfExists,
  readTextIfExists,
  writeBytes,
  writeJson,
  writeText,
} from './fsx.js';
import { hashValue, sha256, valuesEqual } from './hash.js';
import { upsertBlock } from '../merge/blocks.js';
import { appendArrayItems, type JsonObject, setAtPointer } from '../merge/json-merge.js';
import type { InstallPlan, PlanAction, Receipt } from './types.js';

export async function applyPlan(plan: InstallPlan): Promise<Receipt[]> {
  const receipts: Receipt[] = [];
  const byFile = groupByPath(plan.actions);

  for (const [relativePath, actions] of byFile) {
    const absolutePath = fromPosix(plan.scopeRoot, relativePath);
    const kind = actions[0]?.payload.kind;

    if (kind === 'file') {
      for (const action of actions) {
        if (action.payload.kind !== 'file') continue;
        const { contents } = action.payload;

        // An adopted file is already byte-identical, so writing it would only
        // change its mtime -- and the receipt must say we do not own it.
        if (!action.adopt) {
          if (typeof contents === 'string') await writeText(absolutePath, contents);
          else await writeBytes(absolutePath, contents);
        }

        receipts.push({
          op: 'file',
          path: relativePath,
          hash: sha256(contents),
          ...(action.adopt ? { preexisting: true } : {}),
        });
      }
      continue;
    }

    if (kind === 'block') {
      receipts.push(...(await applyBlocks(absolutePath, relativePath, actions)));
      continue;
    }

    receipts.push(...(await applyJson(absolutePath, relativePath, actions)));
  }

  return receipts;
}

function groupByPath(actions: PlanAction[]): Map<string, PlanAction[]> {
  const groups = new Map<string, PlanAction[]>();
  for (const action of actions) {
    const existing = groups.get(action.path);
    if (existing) existing.push(action);
    else groups.set(action.path, [action]);
  }
  return groups;
}

async function applyBlocks(
  absolutePath: string,
  relativePath: string,
  actions: PlanAction[],
): Promise<Receipt[]> {
  let content = (await readTextIfExists(absolutePath)) ?? '';
  const receipts: Receipt[] = [];

  for (const action of actions) {
    if (action.payload.kind !== 'block') continue;
    const { blockId, syntax, body } = action.payload;
    content = upsertBlock(content, syntax, blockId, body);
    receipts.push({ op: 'block', path: relativePath, blockId, syntax });
  }

  await writeText(absolutePath, content);
  return receipts;
}

async function applyJson(
  absolutePath: string,
  relativePath: string,
  actions: PlanAction[],
): Promise<Receipt[]> {
  const existed = await pathExists(absolutePath);
  const doc: JsonObject = (await readJsonIfExists<JsonObject>(absolutePath)) ?? {};
  const receipts: Receipt[] = [];
  let changed = !existed;

  for (const action of actions) {
    if (action.payload.kind === 'json-value') {
      const { pointer, value } = action.payload;

      // Adopting: the key already holds exactly this value, so leave the
      // document (and its formatting) untouched and record it as not ours.
      if (action.adopt) {
        receipts.push({
          op: 'json-value',
          path: relativePath,
          pointer,
          hash: hashValue(value),
          hadPrevious: false,
          preexisting: true,
        });
        continue;
      }

      const result = setAtPointer(doc, pointer, value);
      changed = true;

      // Replacing a value with an identical one is a reinstall, not an
      // overwrite -- recording it as one would resurrect the key on uninstall.
      const overwrote = result.hadPrevious && !valuesEqual(result.previous, value);

      receipts.push({
        op: 'json-value',
        path: relativePath,
        pointer,
        hash: hashValue(value),
        hadPrevious: overwrote,
        ...(overwrote ? { previous: result.previous } : {}),
      });
      continue;
    }

    if (action.payload.kind === 'json-array-item') {
      const { pointer, items } = action.payload;
      const result = appendArrayItems(doc, pointer, items);
      if (result.appended.length > 0) changed = true;
      receipts.push({
        op: 'json-array-item',
        path: relativePath,
        pointer,
        // Only items we actually appended are ours to remove later.
        hashes: result.appended.map((item) => hashValue(item)),
      });
    }
  }

  // A pass that only adopted existing values has nothing to write; rewriting
  // would reformat a file we were asked to leave alone.
  if (changed) await writeJson(absolutePath, doc);
  return receipts;
}
