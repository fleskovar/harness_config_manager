import type { BundleResource, PlanAction, ResourceKind, Scope, TargetId } from '../core/types.js';

export interface TargetContext {
  /** Bundle name, used for block ids and conflict messages. */
  bundle: string;
  scope: Scope;
}

export interface Target {
  id: TargetId;
  title: string;
  docs: string;
  /** Absolute directory that plan paths are relative to. */
  scopeRoot(scope: Scope, cwd: string): string;
  /** Kinds this target knows how to install. */
  supports: ResourceKind[];
  /**
   * Map one canonical resource to the writes it implies.
   * Returning `[]` means "nothing to do"; unsupported kinds are filtered out
   * by the planner before this is called.
   */
  actions(resource: BundleResource, ctx: TargetContext): PlanAction[];
}

/** Normalise a frontmatter value that may be a string or list into a list. */
export function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

/** Drop undefined entries so they never reach the rendered frontmatter. */
export function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
