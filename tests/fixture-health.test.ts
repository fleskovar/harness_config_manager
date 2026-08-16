/**
 * The fixtures themselves, kept honest.
 *
 * Every bundle under `tests/fixtures/` except `broken-refs-kit` and
 * `invalid-kit` is meant to be one somebody would be happy to ship, and a test
 * that starts from a broken fixture proves nothing. So they are validated here,
 * as assets rather than as behaviour.
 *
 * The two deliberately-broken ones are asserted from the other direction, in
 * `tests/cases/validate-names-every-mistake/` and
 * `tests/cases/refs-finds-four-broken/`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { validateCommand } from '../src/commands/validate.js';
import { configureLogger } from '../src/core/logger.js';
import { scanReferences } from '../src/core/refs.js';
import { fixturePath, makeWorkspace } from './support/fixtures.js';

let workspace: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await makeWorkspace('fixture-health');
  previousHome = process.env.HCM_HOME;
  process.env.HCM_HOME = `${workspace}/home`;
  configureLogger({ quiet: true });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HCM_HOME;
  else process.env.HCM_HOME = previousHome;
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('the healthy fixtures', () => {
  const HEALTHY = [
    'bundles/review-kit',
    'bundles/review-kit-v2',
    'bundles/polyglot-kit',
    'bundles/branded-kit',
    'collections/sprint-collection/team-conventions',
    'collections/sprint-collection/sprint-kit',
  ];

  it.each(HEALTHY)('%s validates', async (relative) => {
    expect(await validateCommand(fixturePath(relative), { cwd: workspace })).toBe(true);
  });

  it.each(HEALTHY)('%s has no broken references', async (relative) => {
    const result = await scanReferences(fixturePath(relative));
    expect(result.broken.map((ref) => `${ref.fileRelative}: ${ref.ref}`)).toEqual([]);
  });
});
