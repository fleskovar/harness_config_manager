/**
 * TOML support, used by the Reasonix target.
 *
 * We deliberately do *not* parse-modify-restringify: that would discard the
 * user's comments and formatting across the whole file. Instead we append a
 * comment-delimited marker block (see blocks.ts) containing only our own
 * tables, and use parsing purely to detect conflicts before writing.
 */

import { parse as parseTomlText, stringify as stringifyToml } from 'smol-toml';

export function parseToml(text: string): Record<string, unknown> {
  return parseTomlText(text) as Record<string, unknown>;
}

/** Parse, tolerating an unreadable file by reporting it rather than throwing. */
export function tryParseToml(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    return { ok: true, value: parseToml(text) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Render a fragment as TOML text (no markers -- the caller wraps it). */
export function renderToml(fragment: Record<string, unknown>): string {
  return stringifyToml(fragment).trim();
}

/**
 * Render one `[[plugins]]`-style array-of-tables entry.
 * Array-of-tables entries are always safe to append: repeating the header adds
 * an element rather than redefining a table.
 */
export function renderArrayOfTables(tableName: string, entry: Record<string, unknown>): string {
  return renderToml({ [tableName]: [entry] });
}

/** Names already used by entries of an array-of-tables, by their `name` key. */
export function existingArrayEntryNames(doc: Record<string, unknown>, tableName: string): string[] {
  const table = doc[tableName];
  if (!Array.isArray(table)) return [];
  return table
    .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>).name : undefined))
    .filter((name): name is string => typeof name === 'string');
}

/**
 * Top-level table names in a fragment that are already defined in the document.
 *
 * TOML forbids defining the same table twice, so appending `[permissions]` to a
 * file that already has one produces an invalid document. We detect that up
 * front and surface it as a conflict instead of writing a broken file.
 */
export function collidingTables(
  doc: Record<string, unknown>,
  fragment: Record<string, unknown>,
): string[] {
  return Object.keys(fragment).filter((key) => {
    const existing = doc[key];
    // Array-of-tables can always be extended.
    if (Array.isArray(existing) && Array.isArray(fragment[key])) return false;
    return existing !== undefined;
  });
}
