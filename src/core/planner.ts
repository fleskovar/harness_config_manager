/**
 * Planning: turn a loaded bundle into the concrete list of writes for one
 * target and scope, and check them against what is already on disk.
 *
 * Nothing here touches the filesystem except to read. `--dry-run` is just a
 * plan that never reaches the executor.
 */

import { fromPosix, readTextIfExists } from './fsx.js';
import { hashValue } from './hash.js';
import { getTarget } from '../targets/index.js';
import { hasBlock } from '../merge/blocks.js';
import { getAtPointer } from '../merge/json-merge.js';
import { collidingTables, existingArrayEntryNames, tryParseToml } from '../merge/toml.js';
import { ownershipIndex } from './state.js';
import { readJsonIfExists } from './fsx.js';
import type {
  InstallPlan,
  LoadedBundle,
  PlanAction,
  PlanConflict,
  Scope,
  TargetId,
} from './types.js';

export async function buildPlan(
  bundle: LoadedBundle,
  targetId: TargetId,
  scope: Scope,
  cwd: string,
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
    if (!target.supports.includes(resource.kind)) {
      skipped.push({ resource, reason: `${target.title} has no mapping for ${resource.kind}` });
      continue;
    }
    actions.push(...target.actions(resource, { bundle: bundle.manifest.name, scope }));
  }

  const conflicts = await detectConflicts(actions, scopeRoot, bundle.manifest.name, targetId, scope, cwd);

  return { bundle, target: targetId, scope, scopeRoot, actions, conflicts, skipped };
}

/**
 * A conflict is anything where writing would silently destroy something we do
 * not own: a foreign file at the same path, a JSON key another bundle claims,
 * or a TOML table that already exists (which would produce invalid TOML).
 */
async function detectConflicts(
  actions: PlanAction[],
  scopeRoot: string,
  bundleName: string,
  targetId: TargetId,
  scope: Scope,
  cwd: string,
): Promise<PlanConflict[]> {
  const conflicts: PlanConflict[] = [];
  const owners = await ownershipIndex(scope, cwd, targetId, bundleName);
  const jsonCache = new Map<string, unknown>();
  const textCache = new Map<string, string | undefined>();

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

  for (const action of actions) {
    const { path: relativePath, payload } = action;

    if (payload.kind === 'file') {
      const existing = await readTextCached(relativePath);
      const owner = owners.get(`${relativePath}::file`);
      if (owner) {
        conflicts.push({
          path: relativePath,
          detail: `file is owned by bundle "${owner}"`,
          owner,
        });
      } else if (existing !== undefined) {
        const incoming = typeof payload.contents === 'string' ? payload.contents : payload.contents.toString('utf8');
        if (existing !== incoming) {
          conflicts.push({ path: relativePath, detail: 'file exists and differs from what we would write' });
        }
      }
      continue;
    }

    if (payload.kind === 'json-value') {
      const key = `${relativePath}::json:${payload.pointer.join('.')}`;
      const owner = owners.get(key);
      if (owner) {
        conflicts.push({
          path: relativePath,
          detail: `${payload.pointer.join('.')} is owned by bundle "${owner}"`,
          owner,
        });
        continue;
      }
      const doc = await readJsonCached(relativePath);
      const existing = doc === undefined ? undefined : getAtPointer(doc, payload.pointer);
      if (existing !== undefined && hashValue(existing) !== hashValue(payload.value)) {
        conflicts.push({
          path: relativePath,
          detail: `${payload.pointer.join('.')} already set to a different value`,
        });
      }
      continue;
    }

    if (payload.kind === 'json-array-item') {
      // Appending to a list is additive; another bundle owning other items is fine.
      continue;
    }

    // Marker blocks.
    const existing = await readTextCached(relativePath);
    const owner = owners.get(`${relativePath}::block:${payload.blockId}`);
    if (owner) {
      conflicts.push({
        path: relativePath,
        detail: `block ${payload.blockId} is owned by bundle "${owner}"`,
        owner,
      });
      continue;
    }

    if (payload.syntax === 'toml' && existing !== undefined) {
      const parsed = tryParseToml(existing);
      if (!parsed.ok) {
        conflicts.push({ path: relativePath, detail: `existing TOML is unparseable: ${parsed.error}` });
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
