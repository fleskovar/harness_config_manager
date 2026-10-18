/**
 * Renaming a resource on the way in.
 *
 * When a skill, subagent, command, rule, asset or MCP server in the bundle
 * collides with one the project already has, installing it under a different
 * name is only half the job: the rest of the bundle refers to it by name -- a
 * subagent that lists the skill, a command that says `/review-pr`, a tool
 * prefix `mcp__light-plan__` -- and a renamed resource those instructions
 * cannot find is worse than no resource.
 *
 * So a rename also rewrites the references inside everything else this bundle
 * is about to write. That is a textual substitution -- it cannot know which
 * mentions were meant as the resource and which were an English word -- so it
 * is deliberately narrow, and always reports what it touched.
 *
 * The suggested new name keeps the old one and adds the bundle's name as a
 * suffix: `review-pr` from `ts-review-kit` becomes `review-pr-ts-review-kit`.
 */

import type { PlanAction, ResourceKind } from './types.js';

/** A name is usable if a harness could address it as an identifier. */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One directory or file name of an asset path: anything except `.` and `..`. */
const PATH_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/**
 * Kinds addressed by a name hcm can change. A context section is already keyed
 * by its bundle, and a settings fragment is a set of keys that belong to the
 * harness, so neither has a name to change.
 */
export const RENAMABLE_KINDS: readonly ResourceKind[] = [
  'subagent',
  'skill',
  'command',
  'rule',
  'mcp',
  'asset',
];

export function canRename(kind: ResourceKind): boolean {
  return RENAMABLE_KINDS.includes(kind);
}

/**
 * True when `name` is usable for a resource of `kind`. An asset name is a path
 * inside the bundle's `assets/` directory; every other name is one identifier.
 */
export function isUsableName(kind: ResourceKind, name: string): boolean {
  if (kind !== 'asset') return NAME_PATTERN.test(name);
  return name.split('/').every((segment) => PATH_SEGMENT.test(segment));
}

/**
 * The name to suggest when `name` collides: the bundle's name as a suffix.
 *
 *   review-pr                -> review-pr-ts-review-kit
 *   review-pr-ts-review-kit  -> review-pr-ts-review-kit-2     (the suffix is taken too)
 *   scripts/lint.sh          -> scripts/lint-ts-review-kit.sh (an asset keeps its extension)
 */
export function disambiguatedName(kind: ResourceKind, name: string, bundleName: string): string {
  const slash = name.lastIndexOf('/');
  const directory = name.slice(0, slash + 1);
  const file = name.slice(slash + 1);
  const dot = kind === 'asset' ? file.lastIndexOf('.') : -1;
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const extension = dot > 0 ? file.slice(dot) : '';

  const suffixed = new RegExp(`^(.*)-${escapeRegExp(bundleName)}(?:-(\\d+))?$`).exec(stem);
  const next = suffixed
    ? `${suffixed[1]}-${bundleName}-${Number(suffixed[2] ?? 1) + 1}`
    : `${stem}-${bundleName}`;

  return `${directory}${next}${extension}`;
}

/**
 * Which mentions of a bare name a rewrite may touch.
 *
 *   any     every mention not glued to other name characters
 *   marked  only a mention written as a reference: after `/` (a path or a
 *           slash command), after `@`, or after a backtick
 *
 * A one-word skill or command name -- `review`, `testing` -- is also an
 * ordinary word, so only its marked mentions are rewritten. A name with a
 * separator in it, and an MCP server name, is distinct enough for `any`.
 */
export type BareMatch = 'any' | 'marked';

export function bareMatchFor(kind: ResourceKind, name: string): BareMatch {
  return kind === 'mcp' || /[-_./]/.test(name) ? 'any' : 'marked';
}

export interface RewriteReport {
  /** Rewritten copies; actions with no references are returned unchanged. */
  actions: PlanAction[];
  /** Scope-root-relative paths that changed, with how many mentions each. */
  touched: { path: string; count: number }[];
  total: number;
}

/**
 * Replace references to `from` with `to` across every text write in `actions`.
 *
 * Two forms are recognised:
 *   `mcp__<name>__tool`  the tool-namespace prefix the harnesses generate
 *   `<name>`             the bare name, when not glued to other name characters;
 *                        with `marked`, only where written as a reference
 *
 * Binary payloads (a skill's images, say) are left alone.
 */
export function rewriteReferences(
  actions: PlanAction[],
  from: string,
  to: string,
  match: BareMatch = 'any',
): RewriteReport {
  if (from === to) return { actions, touched: [], total: 0 };

  const quoted = escapeRegExp(from);
  const namespaced = new RegExp(`mcp__${quoted}__`, 'g');
  // Dashes and underscores are part of a name, so `light-plan` must not match
  // inside `light-plan-extra`, and `plan` must not match inside `light-plan`.
  const before = match === 'any' ? '(^|[^A-Za-z0-9_-])' : '([/@`])';
  const bare = new RegExp(`${before}${quoted}(?![A-Za-z0-9_-])`, 'g');

  const touched: { path: string; count: number }[] = [];
  let total = 0;

  const rewritten = actions.map((action) => {
    const { payload } = action;

    if (payload.kind === 'file' && typeof payload.contents === 'string') {
      const { text, count } = substitute(payload.contents, namespaced, bare, to);
      if (count === 0) return action;
      total += count;
      touched.push({ path: action.path, count });
      return { ...action, payload: { ...payload, contents: text } };
    }

    if (payload.kind === 'block') {
      const { text, count } = substitute(payload.body, namespaced, bare, to);
      if (count === 0) return action;
      total += count;
      touched.push({ path: action.path, count });
      return { ...action, payload: { ...payload, body: text } };
    }

    return action;
  });

  return { actions: rewritten, touched, total };
}

function substitute(
  input: string,
  namespaced: RegExp,
  bare: RegExp,
  to: string,
): { text: string; count: number } {
  let count = 0;

  // The namespaced form first: its `__` delimiters are name characters, so the
  // bare pattern would never reach inside it.
  let text = input.replace(namespaced, () => {
    count += 1;
    return `mcp__${to}__`;
  });

  text = text.replace(bare, (_match, prefix: string) => {
    count += 1;
    return `${prefix}${to}`;
  });

  return { text, count };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
