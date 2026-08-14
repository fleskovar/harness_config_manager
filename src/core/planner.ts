/**
 * Planning: turn a loaded bundle into the concrete list of writes for one
 * target and scope, and check them against what is already on disk.
 *
 * Nothing here touches the filesystem except to read. `--dry-run` is just a
 * plan that never reaches the executor.
 */

import { inFlavors } from './flavors.js';
import { fromPosix, readBytesIfExists, readTextIfExists } from './fsx.js';
import { hashValue, sha256 } from './hash.js';
import { remapReferences } from './refmap.js';
import { getTarget } from '../targets/index.js';
import { hasBlock } from '../merge/blocks.js';
import { getAtPointer } from '../merge/json-merge.js';
import { collidingTables, existingArrayEntryNames, tryParseToml } from '../merge/toml.js';
import { type Claim, claimingBundles, claimPath, collectClaims, ownedReceipts } from './state.js';
import { readJsonIfExists } from './fsx.js';
import type { Target } from '../targets/types.js';
import { isPreexisting } from './types.js';
import type {
  BundleResource,
  InstallPlan,
  LoadedBundle,
  PlanAction,
  PlanConflict,
  Receipt,
  Scope,
  TargetId,
  TargetOptions,
} from './types.js';

export async function buildPlan(
  bundle: LoadedBundle,
  targetId: TargetId,
  scope: Scope,
  cwd: string,
  targetOptions: TargetOptions = {},
  flavors: string[] = [],
): Promise<InstallPlan> {
  const target = getTarget(targetId);
  const scopeRoot = target.scopeRoot(scope, cwd);
  const actions: PlanAction[] = [];
  const skipped: InstallPlan['skipped'] = [];

  const declared = bundle.manifest.targets;
  if (declared && declared.length > 0 && !declared.includes(targetId)) {
    return {
      bundle,
      target: targetId,
      scope,
      targetOptions,
      flavors,
      scopeRoot,
      actions: [],
      conflicts: [],
      skipped: bundle.resources.map((resource) => ({
        resource,
        reason: `bundle does not declare support for ${targetId}`,
      })),
    };
  }

  for (const resource of bundle.resources) {
    // A narrowed install is one that plans less. Everything downstream --
    // conflicts, receipts, the context cache -- then describes the subset
    // without having to know a flavor exists.
    if (!inFlavors(resource, flavors)) {
      skipped.push({ resource, reason: `not in the flavor(s) asked for: ${flavors.join(', ')}` });
      continue;
    }
    if (!target.supports.includes(resource.kind)) {
      skipped.push({ resource, reason: `${target.title} has no mapping for ${resource.kind}` });
      continue;
    }
    actions.push(...resourceActions(target, resource, bundle.manifest.name, scope, targetOptions));
  }

  // References inside the bundle are written against the bundle's own layout,
  // which this target is about to take apart -- so they are rewritten to point
  // at where the files are actually going. Before conflict detection, so that
  // hashes, receipts and --dry-run all describe the text that will be on disk.
  const remap = remapReferences(bundle, actions);
  const conflicts = await detectConflicts(remap.actions, scopeRoot, bundle.manifest.name, cwd);

  return {
    bundle,
    target: targetId,
    scope,
    targetOptions,
    flavors,
    scopeRoot,
    actions: remap.actions,
    conflicts,
    skipped,
    references: { rewrites: remap.rewrites, dropped: remap.dropped },
  };
}

/**
 * The writes one resource implies, each tagged with the resource it came from.
 * Also used when a conflict resolution renames a resource and its actions have
 * to be regenerated under the new name.
 */
export function resourceActions(
  target: Target,
  resource: BundleResource,
  bundleName: string,
  scope: Scope,
  options: TargetOptions = {},
): PlanAction[] {
  return target
    .actions(resource, { bundle: bundleName, scope, options })
    .map((action) => ({ ...action, resource }));
}

/**
 * A conflict is anything where writing would silently destroy something we do
 * not own: a foreign file at the same path, a JSON key another bundle claims
 * *with different content*, or a TOML table that already exists (which would
 * produce invalid TOML).
 *
 * Two outcomes are not conflicts:
 *
 *   adopt  the item is already exactly what we would write and nobody claims
 *          it -- it was here before hcm. Recorded, not written, not ours to
 *          remove.
 *   share  the item is exactly what we would write and another installation
 *          claims it. Nothing needs writing, and we claim it too: two bundles
 *          shipping the same asset store one copy, and it survives until the
 *          last of them is uninstalled.
 *
 * Exported because resolving a conflict (skip, overwrite, rename) changes the
 * action list, and the result has to be re-checked against disk.
 */
export async function detectConflicts(
  actions: PlanAction[],
  scopeRoot: string,
  bundleName: string,
  cwd: string,
): Promise<PlanConflict[]> {
  const conflicts: PlanConflict[] = [];
  const claims = await collectClaims(cwd, { excludeBundle: bundleName });
  const mine = await ownedReceipts(cwd, bundleName);
  const jsonCache = new Map<string, unknown>();
  const textCache = new Map<string, string | undefined>();
  const byteCache = new Map<string, Buffer | undefined>();

  async function readJsonCached(relativePath: string): Promise<unknown> {
    if (!jsonCache.has(relativePath)) {
      jsonCache.set(relativePath, await readJsonIfExists(fromPosix(scopeRoot, relativePath)));
    }
    return jsonCache.get(relativePath);
  }

  async function readTextCached(relativePath: string): Promise<string | undefined> {
    if (!textCache.has(relativePath)) {
      textCache.set(relativePath, await readTextIfExists(fromPosix(scopeRoot, relativePath)));
    }
    return textCache.get(relativePath);
  }

  async function readBytesCached(relativePath: string): Promise<Buffer | undefined> {
    if (!byteCache.has(relativePath)) {
      byteCache.set(relativePath, await readBytesIfExists(fromPosix(scopeRoot, relativePath)));
    }
    return byteCache.get(relativePath);
  }

  for (const action of actions) {
    const { path: relativePath, payload, resource } = action;
    delete action.adopt;
    delete action.share;
    delete action.shareItems;

    const at = claimPath(scopeRoot, relativePath);

    if (payload.kind === 'file') {
      const key = `${at}::file`;
      const wanted = sha256(payload.contents);
      const held = claims.get(key) ?? [];
      const shareable = held.length > 0 && held.every((claim) => claim.hash === wanted);

      if (held.length > 0 && !shareable) {
        conflicts.push({
          path: relativePath,
          detail: `file is owned by ${owners(held)}`,
          owner: claimingBundles(held)[0] as string,
          resource,
        });
        continue;
      }

      // Text is compared as text and bytes as bytes: an image round-tripped
      // through UTF-8 would never match itself.
      const existing =
        typeof payload.contents === 'string'
          ? await readTextCached(relativePath)
          : await readBytesCached(relativePath);

      // Somebody claims it but it is not there any more: write it back, and
      // claim it alongside them rather than reporting a collision.
      if (existing === undefined) continue;

      const identical =
        typeof existing === 'string'
          ? existing === payload.contents
          : existing.equals(payload.contents as Buffer);

      if (shareable) {
        // Identical and already claimed: one copy on disk, two claims on it.
        if (identical) action.share = true;
        else if (!weWroteIt(mine, key) && !unchangedSinceWeWroteIt(mine, key, existing)) {
          conflicts.push({
            path: relativePath,
            detail: 'file was edited since another bundle installed it',
            owner: claimingBundles(held)[0] as string,
            resource,
          });
        }
        continue;
      }

      if (!weWroteIt(mine, key)) {
        // Not ours: identical means adopt, anything else needs a decision.
        if (identical) action.adopt = true;
        else {
          conflicts.push({
            path: relativePath,
            detail: 'file exists and differs from what we would write',
            resource,
          });
        }
      } else if (!identical && !unchangedSinceWeWroteIt(mine, key, existing)) {
        conflicts.push({
          path: relativePath,
          detail: 'file was edited since we installed it',
          resource,
        });
      }
      continue;
    }

    if (payload.kind === 'json-value') {
      const label = payload.pointer.join('.');
      const key = `${at}::json:${label}`;
      const wanted = hashValue(payload.value);
      const held = claims.get(key) ?? [];
      const shareable = held.length > 0 && held.every((claim) => claim.hash === wanted);

      if (held.length > 0 && !shareable) {
        conflicts.push({
          path: relativePath,
          detail: `${label} is owned by ${owners(held)}`,
          owner: claimingBundles(held)[0] as string,
          resource,
          pointer: payload.pointer,
        });
        continue;
      }

      const doc = await readJsonCached(relativePath);
      const existing = doc === undefined ? undefined : getAtPointer(doc, payload.pointer);
      if (existing === undefined) continue;

      const identical = hashValue(existing) === wanted;

      if (shareable) {
        if (identical) action.share = true;
        else if (!weWroteIt(mine, key) && !unchangedSinceWeWroteIt(mine, key, existing)) {
          conflicts.push({
            path: relativePath,
            detail: `${label} was changed since another bundle installed it`,
            owner: claimingBundles(held)[0] as string,
            resource,
            pointer: payload.pointer,
          });
        }
        continue;
      }

      if (!weWroteIt(mine, key)) {
        if (identical) action.adopt = true;
        else {
          conflicts.push({
            path: relativePath,
            detail: `${label} already set to a different value`,
            resource,
            pointer: payload.pointer,
          });
        }
        continue;
      }

      if (!identical && !unchangedSinceWeWroteIt(mine, key, existing)) {
        conflicts.push({
          path: relativePath,
          detail: `${label} already set to a different value`,
          resource,
          pointer: payload.pointer,
        });
      }
      continue;
    }

    if (payload.kind === 'json-array-item') {
      // Appending to a list is additive, so it never collides -- but an item
      // another installation contributed has to be claimed rather than silently
      // skipped, or removing that one would take ours away with it.
      const pointer = payload.pointer.join('.');
      const shared = payload.items
        .map((item) => hashValue(item))
        .filter((hash) => (claims.get(`${at}::item:${pointer}:${hash}`) ?? []).length > 0);
      if (shared.length > 0) action.shareItems = shared;
      continue;
    }

    // Marker blocks.
    const existing = await readTextCached(relativePath);
    const heldBlock = claims.get(`${at}::block:${payload.blockId}`) ?? [];
    if (heldBlock.length > 0) {
      conflicts.push({
        path: relativePath,
        detail: `block ${payload.blockId} is owned by ${owners(heldBlock)}`,
        owner: claimingBundles(heldBlock)[0] as string,
        resource,
      });
      continue;
    }

    if (payload.syntax === 'toml' && existing !== undefined) {
      const parsed = tryParseToml(existing);
      if (!parsed.ok) {
        conflicts.push({
          path: relativePath,
          detail: `existing TOML is unparseable: ${parsed.error}`,
          resource,
        });
        continue;
      }
      // Skip tables our own block already contributes -- reinstall is not a conflict.
      if (!hasBlock(existing, 'toml', payload.blockId)) {
        const fragment = tryParseToml(payload.body);
        if (fragment.ok) {
          const collisions = collidingTables(parsed.value, fragment.value);
          if (collisions.length > 0) {
            conflicts.push({
              path: relativePath,
              detail: `TOML table(s) already defined: [${collisions.join('], [')}] -- merge by hand`,
              resource,
            });
          }

          // Array-of-tables entries append rather than collide, so the table
          // name is fine -- but two [[plugins]] sharing a `name` would leave
          // Reasonix with an ambiguous server.
          for (const table of Object.keys(fragment.value)) {
            const incoming = existingArrayEntryNames(fragment.value, table);
            const present = new Set(existingArrayEntryNames(parsed.value, table));
            for (const name of incoming) {
              if (present.has(name)) {
                conflicts.push({
                  path: relativePath,
                  detail: `[[${table}]] named "${name}" already exists`,
                  resource,
                });
              }
            }
          }
        }
      }
    }
  }

  return conflicts;
}

/** "bundle \"alpha\"", or "bundles \"alpha\", \"beta\"" -- for conflict messages. */
function owners(claims: Claim[]): string {
  const names = claimingBundles(claims);
  return `${names.length === 1 ? 'bundle' : 'bundles'} ${names.map((name) => `"${name}"`).join(', ')}`;
}

/**
 * True when this bundle actually wrote the item, as opposed to adopting one
 * that was already there. Adopted items are never ours to overwrite silently,
 * so they are re-evaluated from scratch on every install.
 */
function weWroteIt(mine: Map<string, Receipt>, key: string): boolean {
  const receipt = mine.get(key);
  return receipt !== undefined && !isPreexisting(receipt);
}

/**
 * True when the item on disk is one this same bundle wrote and nobody has
 * touched since. Overwriting that is an upgrade, not a collision -- but an item
 * that no longer hashes to its receipt has been hand-edited, and still stops us.
 */
function unchangedSinceWeWroteIt(
  mine: Map<string, Receipt>,
  key: string,
  existing: unknown,
): boolean {
  const receipt = mine.get(key);
  if (!receipt) return false;
  if (receipt.op === 'file') {
    if (typeof existing !== 'string' && !Buffer.isBuffer(existing)) return false;
    return sha256(existing) === receipt.hash;
  }
  if (receipt.op === 'json-value') return hashValue(existing) === receipt.hash;
  return false;
}
