/**
 * Renaming a resource on the way in.
 *
 * When an MCP server in the bundle collides with one the project already has,
 * installing it under a different name is only half the job: the bundle's own
 * skills, subagents, commands and context refer to the server by name, and a
 * renamed server those instructions cannot find is worse than no server.
 *
 * So a rename also rewrites the references inside everything else this bundle
 * is about to write. That is a textual substitution -- it cannot know which
 * mentions were meant as the server and which were an English word -- so it is
 * deliberately narrow, and always reports what it touched.
 */

import type { PlanAction } from './types.js';

/** A server name is usable if a harness could address it as an identifier. */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
 *   `<name>`             the bare name, when not glued to other name characters
 *
 * Binary payloads (a skill's images, say) are left alone.
 */
export function rewriteReferences(actions: PlanAction[], from: string, to: string): RewriteReport {
  if (from === to) return { actions, touched: [], total: 0 };

  const quoted = escapeRegExp(from);
  const namespaced = new RegExp(`mcp__${quoted}__`, 'g');
  // Dashes and underscores are part of a name, so `light-plan` must not match
  // inside `light-plan-extra`, and `plan` must not match inside `light-plan`.
  const bare = new RegExp(`(^|[^A-Za-z0-9_-])${quoted}(?![A-Za-z0-9_-])`, 'g');

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
