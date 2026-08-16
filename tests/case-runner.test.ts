/**
 * The runner for the human-readable case folders in `tests/cases/`.
 *
 *   npm run test:cases
 *   npm run test:cases -- -t claude-code-every-kind
 *   npm run debug:case -- claude-code-every-kind
 *
 * One `describe` per case folder, discovered from disk, so **adding a case is
 * adding a folder** -- this file is never edited for it. Read
 * `tests/cases/README.md` for what goes in one, and any case's own `README.md`
 * for what that case proves.
 *
 * There is deliberately one assertion per output document rather than one for
 * the whole result: a failure then names the file that broke, and its diff is
 * that file's diff rather than a wall of every file in the project.
 */

import { readdirSync, readFileSync, statSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CASES_ROOT, JSON_INDENT, runCase, type CaseDefinition } from './run-case.js';

/** `UPDATE_BASELINES=1 npm run test:cases` -- see "Regenerating" in the README. */
const UPDATE_BASELINES = process.env.UPDATE_BASELINES === '1';

const caseNames = (): string[] =>
  readdirSync(CASES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => statSync(join(CASES_ROOT, name, 'inputs', 'case.json'), { throwIfNoEntry: false }))
    .sort();

const definitionOf = (caseDir: string): CaseDefinition =>
  JSON.parse(readFileSync(join(caseDir, 'inputs', 'case.json'), 'utf8')) as CaseDefinition;

/** The baseline tree: POSIX path -> text, exactly as `runCase` returns one. */
function readBaselineTree(caseDir: string): Record<string, string> {
  const root = join(caseDir, 'outputs', 'tree');
  const tree: Record<string, string> = {};

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const relative = full.slice(root.length + 1).split(/[\\/]/).join('/');
      tree[relative] = readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
    }
  };

  if (statSync(root, { throwIfNoEntry: false })) walk(root);
  return tree;
}

/** The baseline documents beside the tree: `state.json`, `report.json`, `error.txt`. */
function readBaselineDocuments(caseDir: string): Record<string, unknown> {
  const root = join(caseDir, 'outputs');
  const documents: Record<string, unknown> = {};

  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory()) continue;
    const text = readFileSync(join(root, entry.name), 'utf8').replace(/\r\n/g, '\n');
    documents[entry.name] = entry.name.endsWith('.json') ? JSON.parse(text) : text.trimEnd();
  }

  return documents;
}

function writeBaselines(
  caseDir: string,
  actual: Awaited<ReturnType<typeof runCase>>,
): void {
  rmSync(join(caseDir, 'outputs'), { recursive: true, force: true });

  for (const [relative, contents] of Object.entries(actual.tree)) {
    const target = join(caseDir, 'outputs', 'tree', ...relative.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }

  for (const [name, document] of Object.entries(actual.documents)) {
    const target = join(caseDir, 'outputs', name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      typeof document === 'string'
        ? `${document}\n`
        : `${JSON.stringify(document, null, JSON_INDENT)}\n`,
    );
  }
}

describe.each(caseNames())('%s', (caseName) => {
  const caseDir = join(CASES_ROOT, caseName);
  const definition = definitionOf(caseDir);

  it(definition.describes, async () => {
    const actual = await runCase(caseDir);

    if (UPDATE_BASELINES) {
      writeBaselines(caseDir, actual);
      return; // read the diff before committing it
    }

    const expectedTree = readBaselineTree(caseDir);
    const expectedDocuments = readBaselineDocuments(caseDir);

    // The file list first: a missing or unexpected file is a different failure
    // from a changed one, and saying so plainly beats a diff of every byte.
    expect(Object.keys(actual.tree).sort(), `${caseName} :: files in the project`).toEqual(
      Object.keys(expectedTree).sort(),
    );
    for (const file of Object.keys(expectedTree).sort()) {
      expect(actual.tree[file], `${caseName} :: ${file}`).toEqual(expectedTree[file]);
    }

    expect(Object.keys(actual.documents).sort(), `${caseName} :: output documents`).toEqual(
      Object.keys(expectedDocuments).sort(),
    );
    for (const name of Object.keys(expectedDocuments).sort()) {
      expect(actual.documents[name], `${caseName} :: ${name}`).toEqual(expectedDocuments[name]);
    }
  });

  it('is documented', () => {
    // A case folder without a README is a golden file, not a readable test.
    const readme = join(caseDir, 'README.md');
    expect(statSync(readme, { throwIfNoEntry: false })?.isFile(), `${caseName} has no README.md`).toBe(
      true,
    );
    // ...and one whose walkthrough was never written is the same thing.
    expect(readFileSync(readme, 'utf8')).toMatch(/## Walkthrough/);
  });
});
