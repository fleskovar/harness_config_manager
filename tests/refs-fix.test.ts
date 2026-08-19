/**
 * Broken references, against a bundle you can solve by hand.
 *
 * The bundle is `tests/fixtures/bundles/broken-refs-kit`. Open it, read the
 * files, and work out for yourself which references point at nothing and what
 * each one meant -- there are four, and every one has a single obvious answer.
 * The `EXPECTED` table below is that answer written down, so a disagreement
 * between you and the app shows up as a failing assertion rather than as a
 * report nobody checked.
 *
 * The bundle is also stocked with filenames that are *not* references --
 * `audit-summary.md`, `reports/dependency-tree.txt`, `package.json` -- and the
 * count of four is as much an assertion about those as about the four.
 *
 * `tests/fixtures/README.md` has the same table in prose, with the reasoning.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFixFile, type FixFile, refsCheckCommand, refsFixCommand } from '../src/commands/refs.js';
import { configureLogger } from '../src/core/logger.js';
import { scanReferences } from '../src/core/refs.js';
import { copyFixture, makeWorkspace, readText } from './support/fixtures.js';

let workspace: string;
/** The copy of broken-refs-kit under test; the checked-in fixture is never touched. */
let kit: string;

beforeEach(async () => {
  workspace = await makeWorkspace('refs-fixture');
  kit = await copyFixture('bundles/broken-refs-kit', path.join(workspace, 'broken-refs-kit'));
  configureLogger({ quiet: true });
});

afterEach(async () => {
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

/**
 * The whole answer key. Each row: the file the reference is written in, the
 * line it is on, what it says, and the file it should have said.
 *
 *   commands/review-pr.md          [the team's conventions](context/conventions.md)
 *       context/ holds 10-conventions.md and 20-pull-requests.md. Only one of
 *       them is about conventions. A link, so its target is a path whether or
 *       not it was written with a `./`.
 *   mcp/formatter.json             "../assets/format.sh"
 *       assets/ holds one file, and it is not called format.sh. A config value,
 *       in scope because of the `../`.
 *   skills/release-audit/SKILL.md  `./checklist.md`
 *       The skill's own directory holds release-checklist.md. The fix keeps the
 *       `./` the author wrote: that prefix is what made it a reference, and a
 *       repair that dropped it would drop the line out of every later check.
 *   subagents/code-reviewer.md     [the TypeScript rules](rules/typescrpt.md)
 *       A typo, one letter out from the file that is there.
 */
const EXPECTED = [
  {
    file: 'commands/review-pr.md',
    line: 8,
    broken: 'context/conventions.md',
    fix: 'context/10-conventions.md',
  },
  {
    file: 'mcp/formatter.json',
    line: 3,
    broken: '../assets/format.sh',
    fix: '../assets/format-code.sh',
  },
  {
    file: 'skills/release-audit/SKILL.md',
    line: 7,
    broken: './checklist.md',
    fix: './release-checklist.md',
  },
  {
    file: 'subagents/code-reviewer.md',
    line: 11,
    broken: 'rules/typescrpt.md',
    fix: 'rules/typescript.md',
  },
];

/** Every fix file entry cut down to its best candidate -- what the user does by hand. */
function keepBestCandidate(fixes: FixFile): FixFile {
  return Object.fromEntries(
    Object.entries(fixes).map(([key, entry]) => [
      key,
      { original_ref: entry.original_ref, new: entry.new.slice(0, 1) },
    ]),
  );
}

// ---------------------------------------------------------------------------

describe('hcm refs check, on a bundle with four broken references', () => {
  it('resolves the references in the bundle that are correct', async () => {
    const result = await scanReferences(kit);
    const resolved = result.refs.filter((ref) => ref.target !== undefined).map((ref) => ref.ref);

    // Both links in the command, written from the bundle root.
    expect(resolved).toContain('skills/release-audit/release-checklist.md');
    expect(resolved).toContain('rules/typescript.md');
    // A wikilink, resolved by name rather than by path.
    expect(resolved).toContain('release-checklist');
  });

  it('says nothing about the filenames the bundle only talks about', async () => {
    const reported = (await scanReferences(kit)).broken.map((ref) => ref.ref);

    // Sentences that name a file the skill will create, or that some other
    // project owns. A separator does not make one of them a reference either.
    expect(reported).not.toContain('audit-summary.md');
    expect(reported).not.toContain('reports/dependency-tree.txt');
    expect(reported).not.toContain('package.json');
    expect(reported).toHaveLength(EXPECTED.length);
  });

  it('--all-paths picks up the prose the default scope steps over', async () => {
    const reported = (await scanReferences(kit, { allPaths: true })).broken.map((ref) => ref.ref);

    // Which is the argument for the default: this one is a true sentence about
    // a file being written, not a reference that points at nothing.
    expect(reported).toContain('reports/dependency-tree.txt');
    expect(reported.length).toBeGreaterThan(EXPECTED.length);
  });

  it('fails on this bundle, and passes on the healthy one next to it', async () => {
    expect(await refsCheckCommand({ path: kit, cwd: workspace })).toBe(false);

    const healthy = await copyFixture('bundles/review-kit', path.join(workspace, 'review-kit'));
    expect(await refsCheckCommand({ path: healthy, cwd: workspace })).toBe(true);
  });
});

describe('hcm refs fix', () => {
  it('writes a fix file listing each broken reference with its candidates', async () => {
    const fixes = buildFixFile(await scanReferences(kit));

    expect(Object.keys(fixes)).toEqual(EXPECTED.map((expected) => expected.file));
    for (const expected of EXPECTED) {
      expect(fixes[expected.file]?.original_ref).toBe(expected.broken);
      expect(fixes[expected.file]?.new[0]).toBe(expected.fix);
    }
  });

  it('repairs the bundle when each entry is cut down to one candidate', async () => {
    const ok = await refsFixCommand({
      path: kit,
      cwd: workspace,
      // Stands in for the user editing the file: keep the best candidate, drop
      // the rest. This is the only judgement the round trip asks for.
      edit: async (file) => {
        const fixes = JSON.parse(await fs.readFile(file, 'utf8')) as FixFile;
        await fs.writeFile(file, JSON.stringify(keepBestCandidate(fixes), null, 2), 'utf8');
      },
    });

    expect(ok).toBe(true);
    expect((await scanReferences(kit)).broken).toEqual([]);

    // And the repaired text says what a human would have typed.
    const command = await readText(kit, 'commands/review-pr.md');
    expect(command).toContain('](context/10-conventions.md)');
    expect(command).not.toContain('context/conventions.md');

    expect(await readText(kit, 'subagents/code-reviewer.md')).toContain(
      '[the TypeScript rules](rules/typescript.md)',
    );
    expect(await readText(kit, 'skills/release-audit/SKILL.md')).toContain(
      '`./release-checklist.md`',
    );
    expect(JSON.parse(await readText(kit, 'mcp/formatter.json'))).toEqual({
      command: 'bash',
      args: ['../assets/format-code.sh', '--serve'],
    });
  });

  it('applies the unambiguous entries and leaves an undecided one alone', async () => {
    // The editor changes nothing. Three entries came with a single candidate and
    // are applied; `checklist.md` came with two, so nobody has chosen yet.
    const ok = await refsFixCommand({ path: kit, cwd: workspace, edit: async () => {} });

    expect(ok).toBe(false);
    expect((await scanReferences(kit)).broken.map((ref) => ref.ref)).toEqual(['./checklist.md']);
    expect(await readText(kit, 'skills/release-audit/SKILL.md')).toContain('`./checklist.md`');
  });

  it('--write hands over the file and changes nothing yet', async () => {
    expect(await refsFixCommand({ path: kit, cwd: workspace, write: 'fixes.json' })).toBe(true);

    const written = JSON.parse(await readText(workspace, 'fixes.json')) as FixFile;
    expect(Object.keys(written)).toEqual(EXPECTED.map((expected) => expected.file));
    expect(await readText(kit, 'commands/review-pr.md')).toContain('](context/conventions.md)');

    // ...and applying the edited file afterwards is the other half of the trip.
    await fs.writeFile(
      path.join(workspace, 'fixes.json'),
      JSON.stringify(keepBestCandidate(written), null, 2),
      'utf8',
    );

    expect(await refsFixCommand({ path: kit, cwd: workspace, file: 'fixes.json' })).toBe(true);
    expect((await scanReferences(kit)).broken).toEqual([]);
  });

  it('--dry-run reports the same repair without making it', async () => {
    const fixes = keepBestCandidate(buildFixFile(await scanReferences(kit)));
    await fs.writeFile(path.join(workspace, 'fixes.json'), JSON.stringify(fixes), 'utf8');

    await refsFixCommand({ path: kit, cwd: workspace, file: 'fixes.json', dryRun: true });

    expect((await scanReferences(kit)).broken).toHaveLength(EXPECTED.length);
  });
});
