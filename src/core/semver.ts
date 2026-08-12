/**
 * A small semver subset, enough for bundle dependency ranges.
 *
 * Bundles version themselves; a bundle that depends on another has to say which
 * versions of it will do. Rather than take a dependency on `semver` for the
 * handful of operators anybody writes in practice, this implements them
 * directly:
 *
 *   *  x  (empty)      any version
 *   1.2.3  =1.2.3      exactly that one
 *   ^1.2.3             the same left-most non-zero digit: >=1.2.3 <2.0.0
 *   ~1.2.3             the same minor:                    >=1.2.3 <1.3.0
 *   >=1.2.3  >  <  <=  as written
 *   1.2.x  1.x         wildcards in the trailing positions
 *   a b                both (a space is "and")
 *   a || b             either
 *
 * Anything else is refused when the manifest is read, rather than quietly
 * matching nothing at install time.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty for a release. */
  prerelease: (string | number)[];
}

const VERSION_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(input: string): Version | undefined {
  const match = VERSION_PATTERN.exec(input.trim());
  if (!match) return undefined;

  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: (match[4] ?? '')
      .split('.')
      .filter(Boolean)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
  };
}

export function isValidVersion(input: string): boolean {
  return parseVersion(input) !== undefined;
}

export function formatVersion(version: Version): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length ? `${core}-${version.prerelease.join('.')}` : core;
}

/** -1, 0 or 1, ordering releases above their own prereleases as semver says. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  // 1.0.0-alpha < 1.0.0, and a version with no prerelease wins.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftIsNumber = typeof left === 'number';
    const rightIsNumber = typeof right === 'number';
    // Numeric identifiers always compare below alphanumeric ones.
    if (leftIsNumber !== rightIsNumber) return leftIsNumber ? -1 : 1;
    return left < right ? -1 : 1;
  }

  return 0;
}

/** Compare two version strings; unparseable ones sort last but compare equal. */
export function compareVersionStrings(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  return compareVersions(left, right);
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

type Operator = '<' | '<=' | '>' | '>=' | '=';

interface Comparator {
  operator: Operator;
  version: Version;
}

/** One space-separated group; every comparator in it has to hold. */
type ComparatorSet = Comparator[];

const ANY: ComparatorSet = [];

/**
 * Turn a range into alternative comparator sets. `undefined` means the range is
 * not one we understand, which callers report rather than silently ignore.
 */
export function parseRange(range: string): ComparatorSet[] | undefined {
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X') return [ANY];

  const alternatives: ComparatorSet[] = [];

  for (const alternative of trimmed.split('||')) {
    const set: ComparatorSet = [];

    for (const part of alternative.trim().split(/\s+/).filter(Boolean)) {
      const comparators = parseComparator(part);
      if (!comparators) return undefined;
      set.push(...comparators);
    }

    alternatives.push(set);
  }

  return alternatives;
}

const COMPARATOR_PATTERN = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/;

function parseComparator(input: string): Comparator[] | undefined {
  const match = COMPARATOR_PATTERN.exec(input);
  if (!match) return undefined;

  const operator = match[1] ?? '';
  const rest = (match[2] ?? '').trim();

  // A wildcard in a trailing position is a range of its own: 1.2.x means
  // ">=1.2.0 <1.3.0". Combining one with ^ or ~ says nothing extra, so it is
  // treated the same way whichever prefix was written.
  const wildcard = parseWildcard(rest);
  if (wildcard) return wildcard;

  const version = parseVersion(rest);
  if (!version) return undefined;

  if (operator === '^') return [{ operator: '>=', version }, { operator: '<', version: caretCeiling(version) }];
  if (operator === '~') return [{ operator: '>=', version }, { operator: '<', version: tildeCeiling(version) }];
  if (operator === '' || operator === '=') return [{ operator: '=', version }];
  return [{ operator: operator as Operator, version }];
}

/** `1.x`, `1.2.x`, `1.*` -- everything sharing the stated prefix. */
function parseWildcard(input: string): Comparator[] | undefined {
  const parts = input.replace(/^v/, '').split('.');
  const wildcardAt = parts.findIndex((part) => part === 'x' || part === 'X' || part === '*');
  if (wildcardAt < 0) return undefined;
  // Only trailing wildcards make sense: `1.x.2` is not a range anybody means.
  if (parts.slice(wildcardAt).some((part) => !/^[xX*]$/.test(part))) return undefined;
  if (wildcardAt === 0) return [];

  const numbers = parts.slice(0, wildcardAt).map(Number);
  if (numbers.some((value) => !Number.isInteger(value) || value < 0)) return undefined;

  const floor: Version = {
    major: numbers[0] as number,
    minor: numbers[1] ?? 0,
    patch: 0,
    prerelease: [],
  };
  const ceiling: Version =
    wildcardAt === 1
      ? { major: floor.major + 1, minor: 0, patch: 0, prerelease: [] }
      : { major: floor.major, minor: floor.minor + 1, patch: 0, prerelease: [] };

  return [{ operator: '>=', version: floor }, { operator: '<', version: ceiling }];
}

/** `^0.2.3` is `<0.3.0`: below 1.0.0 the minor is where breaking changes live. */
function caretCeiling(version: Version): Version {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0, prerelease: [] };
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0, prerelease: [] };
  return { major: 0, minor: 0, patch: version.patch + 1, prerelease: [] };
}

function tildeCeiling(version: Version): Version {
  return { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] };
}

export function isValidRange(range: string): boolean {
  return parseRange(range) !== undefined;
}

/**
 * Does `version` fall inside `range`?
 *
 * A prerelease only ever satisfies a range that mentions a prerelease of the
 * same major.minor.patch -- `^1.2.3` does not pick up `2.0.0-beta.1`, which is
 * the rule everyone relies on without thinking about it.
 */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;

  const alternatives = parseRange(range);
  if (!alternatives) return false;

  return alternatives.some((set) => satisfiesSet(parsed, set));
}

function satisfiesSet(version: Version, set: ComparatorSet): boolean {
  // "*" constrains nothing, so it takes prereleases too -- a bundle whose only
  // published version is 1.0.0-rc.1 should still satisfy "any version of it".
  if (set.length === 0) return true;
  if (!set.every((comparator) => satisfiesComparator(version, comparator))) return false;

  if (version.prerelease.length === 0) return true;
  return set.some(
    (comparator) =>
      comparator.version.prerelease.length > 0 &&
      comparator.version.major === version.major &&
      comparator.version.minor === version.minor &&
      comparator.version.patch === version.patch,
  );
}

function satisfiesComparator(version: Version, comparator: Comparator): boolean {
  const order = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case '=':
      return order === 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
  }
}
