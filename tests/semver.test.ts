/**
 * The version-range subset dependency declarations are written in.
 */

import { describe, expect, it } from 'vitest';
import {
  compareVersionStrings,
  isValidRange,
  parseVersion,
  satisfies,
} from '../src/core/semver.js';

describe('parsing', () => {
  it('takes partial versions and a leading v', () => {
    expect(parseVersion('1')).toMatchObject({ major: 1, minor: 0, patch: 0 });
    expect(parseVersion('v2.3')).toMatchObject({ major: 2, minor: 3, patch: 0 });
    expect(parseVersion('1.2.3-beta.1')).toMatchObject({ prerelease: ['beta', 1] });
    // Build metadata is not part of the ordering, and is dropped.
    expect(parseVersion('1.2.3+build.9')).toMatchObject({ major: 1, minor: 2, patch: 3 });
  });

  it('refuses what is not a version', () => {
    expect(parseVersion('latest')).toBeUndefined();
    expect(parseVersion('')).toBeUndefined();
    expect(parseVersion('1.2.3.4')).toBeUndefined();
  });
});

describe('ordering', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersionStrings('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersionStrings('2.0.0', '2.0.0')).toBe(0);
  });

  it('puts a release above its own prereleases', () => {
    expect(compareVersionStrings('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareVersionStrings('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1);
    // Numeric identifiers sort below alphanumeric ones.
    expect(compareVersionStrings('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });
});

describe('ranges', () => {
  it('matches an exact version', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '1.2.3')).toBe(false);
    expect(satisfies('1.2.3', '=1.2.3')).toBe(true);
  });

  it('caret keeps the left-most non-zero digit', () => {
    expect(satisfies('1.9.9', '^1.2.3')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfies('1.2.2', '^1.2.3')).toBe(false);
    // Below 1.0.0 the minor is where the breakage lives.
    expect(satisfies('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.3')).toBe(false);
  });

  it('tilde keeps the minor', () => {
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
  });

  it('takes comparators, wildcards, and both kinds of join', () => {
    expect(satisfies('1.5.0', '>=1.2.3 <2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '>=1.2.3 <2.0.0')).toBe(false);
    expect(satisfies('1.2.9', '1.2.x')).toBe(true);
    expect(satisfies('1.3.0', '1.2.x')).toBe(false);
    expect(satisfies('3.1.0', '1.x')).toBe(false);
    expect(satisfies('1.0.0', '^1.0.0 || ^3.0.0')).toBe(true);
    expect(satisfies('3.4.0', '^1.0.0 || ^3.0.0')).toBe(true);
    expect(satisfies('2.4.0', '^1.0.0 || ^3.0.0')).toBe(false);
  });

  it('anything satisfies no constraint at all', () => {
    for (const range of ['*', 'x', '']) {
      expect(satisfies('1.2.3', range)).toBe(true);
      expect(satisfies('0.0.1-rc.1', range)).toBe(true);
    }
  });

  it('does not let a prerelease sneak into a range that never mentioned one', () => {
    // The rule everybody relies on without thinking about it: ^1.2.3 must not
    // pick up 2.0.0-beta.1 just because it sorts below 2.0.0.
    expect(satisfies('2.0.0-beta.1', '^1.2.3')).toBe(false);
    expect(satisfies('1.2.4-beta.1', '>=1.2.3')).toBe(false);
    // Unless the range asked for prereleases of that very version.
    expect(satisfies('1.2.4-beta.1', '>=1.2.4-alpha.1 <2.0.0')).toBe(true);
  });

  it('knows which ranges it cannot honour', () => {
    expect(isValidRange('^1.2.3')).toBe(true);
    expect(isValidRange('>=1.2 <2 || 3.x')).toBe(true);
    expect(isValidRange('latest')).toBe(false);
    expect(isValidRange('1.x.3')).toBe(false);
    // An unhonourable range matches nothing rather than everything.
    expect(satisfies('1.2.3', 'latest')).toBe(false);
  });
});
