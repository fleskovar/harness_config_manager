import type {
  BundleResource,
  PlanAction,
  ResourceKind,
  Scope,
  TargetId,
  TargetOptions,
} from '../core/types.js';

export type { TargetOptions };

export interface TargetContext {
  /** Bundle name, used for block ids and conflict messages. */
  bundle: string;
  scope: Scope;
  /** What is installed on this machine; see `TargetOptions`. */
  options: TargetOptions;
}

export interface Target {
  id: TargetId;
  title: string;
  docs: string;
  /** Absolute directory that plan paths are relative to. */
  scopeRoot(scope: Scope, cwd: string): string;
  /**
   * Paths under `scopeRoot`, any one of which means this harness is set up
   * here. `.` means the scope root itself -- which is what identifies a harness
   * whose user-scope root *is* its own config directory.
   *
   * Only unambiguous evidence belongs here. `.mcp.json` and `AGENTS.md` are
   * written by more than one harness, so finding one says nothing about which
   * harness put it there; see `core/overlap.ts` for what that costs elsewhere.
   */
  markers(scope: Scope): string[];
  /** Kinds this target knows how to install. */
  supports: ResourceKind[];
  /** Anything about this harness a user should know before installing into it. */
  notes?: string[];
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
