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
export function tryParseToml(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    return { ok: true, value: parseToml(text) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Render a fragment as TOML text (no markers -- the caller wraps it).
 * Nested objects become sub-tables, which is the idiomatic form for the
 * settings tables the Reasonix spec documents ([permissions], [tools.shell]).
 */
export function renderToml(fragment: Record<string, unknown>): string {
  return stringifyToml(fragment).trim();
}

/**
 * Render one `[[plugins]]`-style array-of-tables entry.
 *
 * Array-of-tables entries are always safe to append: repeating the header adds
 * an element rather than redefining a table.
 *
 * Nested objects are written as *inline* tables (`env = { FOO = "bar" }`)
 * rather than sub-tables (`[plugins.env]`). Both parse identically, but a
 * sub-table binds to whichever `[[plugins]]` header precedes it, so anything
 * inserted between the two would silently reattach it to the wrong server.
 * Inline tables keep each entry self-contained -- which matters here, because
 * these entries live inside marker blocks added and removed independently.
 * It is also the form the spec documents.
 */
export function renderArrayOfTables(tableName: string, entry: Record<string, unknown>): string {
  const lines = [`[[${tableName}]]`];
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined) continue;
    lines.push(`${renderKey(key)} = ${renderValue(value)}`);
  }
  return lines.join('\n');
}

/** Bare key where TOML allows it, quoted otherwise. */
function renderKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : renderString(key);
}

// Control characters that have no shorthand escape in a TOML basic string.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function renderString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(
      CONTROL_CHARS,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  return `"${escaped}"`;
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return renderString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cannot write ${value} to TOML`);
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[ ${value.map((item) => renderValue(item)).join(', ')} ]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, nested]) => nested !== undefined,
    );
    if (entries.length === 0) return '{}';
    const rendered = entries.map(([key, nested]) => `${renderKey(key)} = ${renderValue(nested)}`);
    return `{ ${rendered.join(', ')} }`;
  }

  throw new Error(`Cannot write value of type ${typeof value} to TOML`);
}

/** Names already used by entries of an array-of-tables, by their `name` key. */
export function existingArrayEntryNames(
  doc: Record<string, unknown>,
  tableName: string,
): string[] {
  const table = doc[tableName];
  if (!Array.isArray(table)) return [];
  return table
    .map((entry) =>
      entry && typeof entry === 'object' ? (entry as Record<string, unknown>).name : undefined,
    )
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
