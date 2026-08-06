import { createHash } from 'node:crypto';

/** sha256 of arbitrary bytes or text, hex encoded. */
export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Deterministic JSON serialisation: object keys sorted at every level so that
 * a value hashes identically no matter how the host file was formatted or
 * reordered. This is what makes "is this still the value we wrote?" reliable.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

/** sha256 of the canonical JSON form of a value. */
export function hashValue(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Structural equality via canonical JSON. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
