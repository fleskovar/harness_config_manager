/**
 * Finding broken references, and the round trip that repairs them.
 *
 * The interesting half of this is not detection but *restraint*: a bundle's
 * prose is full of filenames that are not references, and a checker that cries
 * wolf about `package.json` is a checker nobody runs. So most of what follows
 * pins down what the scanner deliberately ignores.
 *
 * The rule it ignores them by is in `describe('what counts as a reference')`:
 * a reference has to be *written as one*, either by a syntax that declares its
 * target is a path -- a link, a wikilink, an `@file` mention -- or by an
 * explicit `./` or `../` in front of it. Everything else needs `--all-paths`.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFixFile, refsCheckCommand, refsFixCommand } from '../src/commands/refs.js';
import { configureLogger } from '../src/core/logger.js';
import { applyRefEdits, scanReferences, type ScanOptions, similarity } from '../src/core/refs.js';

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hcm-refs-'));
  configureLogger({ quiet: true });
});

afterEach(async () => {
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

/** Write a file, creating its directories. Paths are POSIX, relative to the workspace. */
async function write(relativePath: string, contents: string): Promise<string> {
  const absolute = path.join(workspace, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, contents, 'utf8');
  return absolute;
}

async function read(relativePath: string): Promise<string> {
  return fs.readFile(path.join(workspace, ...relativePath.split('/')), 'utf8');
}

/** A minimal bundle at `dir`, with whatever files the test needs. */
async function bundle(dir: string, files: Record<string, string>): Promise<void> {
  await write(`${dir}/hcm.yaml`, `name: ${path.basename(dir)}\nversion: 1.0.0\n`);
  for (const [file, contents] of Object.entries(files)) {
    await write(`${dir}/${file}`, contents);
  }
}

const brokenRefs = async (options?: ScanOptions): Promise<string[]> => {
  const result = await scanReferences(workspace, options ?? {});
  return result.broken.map((ref) => ref.ref);
};

/** Every reference the scan looked at, broken or not. */
const allRefs = async (options?: ScanOptions): Promise<string[]> => {
  const result = await scanReferences(workspace, options ?? {});
  return result.refs.map((ref) => ref.ref);
};

// ---------------------------------------------------------------------------

describe('what counts as a reference', () => {
  it('ignores a bare filename in a sentence about creating one', async () => {
    await bundle('kit', {
      'skills/audit/SKILL.md': 'A file will be created named `output.txt`.',
    });

    // The sentence is true and complete on its own. Nothing in it points at a
    // file this bundle ships, and there is no `output.txt` to point at.
    expect(await brokenRefs()).toEqual([]);
    expect(await allRefs()).toEqual([]);
  });

  it('ignores a bare filename even when a file of that name is right there', async () => {
    await bundle('kit', {
      'skills/audit/SKILL.md': 'A file will be created named `output.txt`.',
      'skills/audit/output.txt': '',
    });

    // Nor is it a reference when it happens to resolve: it was never a claim
    // about the tree, so it must not be counted as one in either direction.
    expect(await allRefs()).toEqual([]);
  });

  it('ignores an implicit path in inline code', async () => {
    await bundle('kit', { 'commands/review.md': 'Read `context/nowhere.md` first.' });

    // A separator is not intent. Prose about a project's layout looks exactly
    // like this, and the bundle may not own the tree being described.
    expect(await brokenRefs()).toEqual([]);
  });

  it('checks a path written with an explicit ./', async () => {
    await bundle('kit', {
      'skills/audit/SKILL.md': 'Work through `./checklist.md`, then `./missing.md`.',
      'skills/audit/checklist.md': '- one',
    });

    expect(await brokenRefs()).toEqual(['./missing.md']);
  });

  it('checks a path written with an explicit ../', async () => {
    await bundle('kit', {
      'mcp/formatter.json': '{ "args": ["../assets/run.sh"] }',
      'assets/other.sh': '',
    });

    expect(await brokenRefs()).toEqual(['../assets/run.sh']);
  });

  it('checks a link target whether or not it was written with a ./', async () => {
    await bundle('kit', {
      'commands/review.md': [
        '[with a dot](./context/gone-one.md)',
        '[without one](context/gone-two.md)',
      ].join('\n'),
      'context/conventions.md': '',
    });

    // Markdown has already said the thing in the parentheses is somewhere to
    // go; there is no turn of phrase it could be instead.
    expect((await brokenRefs()).sort()).toEqual(['./context/gone-one.md', 'context/gone-two.md']);
  });

  it('checks every syntax that declares its target is a path', async () => {
    await bundle('kit', {
      'context/notes.md': [
        '[a link](missing-one.md)',
        '![an image](missing-two.png)',
        'and @missing-four.md',
        'and [[missing-six]]',
        '',
        '[def]: missing-five.md',
      ].join('\n'),
    });

    expect((await brokenRefs()).sort()).toEqual([
      'missing-five.md',
      'missing-four.md',
      'missing-one.md',
      'missing-six',
      'missing-two.png',
    ]);
  });

  it('--all-paths brings back the implicit paths and the bare filenames', async () => {
    await bundle('kit', {
      'commands/review.md': 'Read `context/nowhere.md`, then `strategy.md`.',
      'context/strategy-notes.md': '',
    });

    expect(await brokenRefs()).toEqual([]);
    // `strategy.md` is weak -- a bare filename -- and reported because there is
    // something similar in the tree to offer instead.
    expect((await brokenRefs({ allPaths: true })).sort()).toEqual([
      'context/nowhere.md',
      'strategy.md',
    ]);
  });

  it('--strict adds the bare filenames with nothing to suggest', async () => {
    await bundle('kit', { 'context/notes.md': 'Check `whatever.md` before starting.' });

    expect(await brokenRefs()).toEqual([]);
    expect(await brokenRefs({ allPaths: true })).toEqual([]);
    expect(await brokenRefs({ strict: true })).toEqual(['whatever.md']);
  });

  it('ignores a link or a wikilink that inline code is only displaying', async () => {
    await bundle('kit', {
      'README.md': 'Write it as `[the checklist](gone-link.md)` or as `[[gone-wiki]]`.',
    });

    // Documentation about markdown is full of these, and no reader will ever
    // follow one. A backtick span is a display, so its contents count only as
    // the single `code` candidate they visibly are -- and neither
    // `[the checklist](gone-link.md)` nor `[[gone-wiki]]` is a path.
    expect(await brokenRefs({ strict: true })).toEqual([]);
  });

  it('still reads a real link that sits beside inline code', async () => {
    await bundle('kit', {
      'README.md': 'Run `npm test`, then read [the checklist](gone-link.md).',
    });

    expect(await brokenRefs()).toEqual(['gone-link.md']);
  });

  it('records the scope it ran under', async () => {
    await bundle('kit', { 'context/notes.md': 'nothing here' });

    expect((await scanReferences(workspace)).scope).toEqual({
      links: false,
      allPaths: false,
      strict: false,
    });
    expect((await scanReferences(workspace, { links: true })).scope.links).toBe(true);
  });
});

describe('--links', () => {
  it('reads links, images, definitions and wikilinks, and nothing else', async () => {
    await bundle('kit', {
      'context/notes.md': [
        '[a link](gone-link.md)',
        '![an image](gone-image.png)',
        '[def]: gone-definition.md',
        'a wikilink [[gone-wiki]]',
        'inline code `./gone-code.md`',
        'a mention @gone-mention.md',
      ].join('\n'),
      'mcp/server.json': '{ "args": ["../assets/gone-config.sh"] }',
    });

    // The default reads all six of those forms.
    expect((await brokenRefs()).sort()).toEqual([
      '../assets/gone-config.sh',
      './gone-code.md',
      'gone-definition.md',
      'gone-image.png',
      'gone-link.md',
      'gone-mention.md',
      'gone-wiki',
    ]);

    expect((await brokenRefs({ links: true })).sort()).toEqual([
      'gone-definition.md',
      'gone-image.png',
      'gone-link.md',
      'gone-wiki',
    ]);
  });

  it('reads nothing at all out of a config file', async () => {
    await bundle('kit', { 'mcp/server.json': '{ "args": ["../assets/run.sh"] }' });

    expect(await allRefs({ links: true })).toEqual([]);
  });
});

describe('wikilinks', () => {
  it('resolves by name, wherever the file sits in the bundle', async () => {
    await bundle('kit', {
      'skills/audit/SKILL.md': 'The long form is [[release-checklist]].',
      'context/release-checklist.md': '- one',
    });

    const result = await scanReferences(workspace);
    expect(result.broken).toEqual([]);
    expect(result.refs[0]?.via).toBe('name');
  });

  it('resolves a sibling by name before it looks anywhere else', async () => {
    await bundle('kit', {
      'skills/audit/SKILL.md': 'See [[checklist]].',
      'skills/audit/checklist.md': '- one',
    });

    expect((await scanReferences(workspace)).refs[0]?.via).toBe('file');
  });

  it('takes a path or an extension when it is given one', async () => {
    await bundle('kit', {
      'commands/review.md': 'See [[skills/audit/checklist]] and [[notes.md]].',
      'skills/audit/checklist.md': '',
      'commands/notes.md': '',
    });

    expect(await brokenRefs()).toEqual([]);
  });

  it('ignores the alias and the heading, which are not part of the path', async () => {
    await bundle('kit', {
      'commands/review.md': 'See [[checklist|the checklist]] and [[notes#step-two]].',
      'commands/checklist.md': '',
      'commands/notes.md': '',
    });

    expect(await brokenRefs()).toEqual([]);
  });

  it('will not reach into another bundle to make itself resolve', async () => {
    await bundle('kit-a', { 'commands/review.md': 'See [[glossary]].' });
    await bundle('kit-b', { 'context/glossary.md': '' });

    // A wikilink is a name, and refmap.ts cannot rewrite a name into a path
    // without destroying it -- so a cross-bundle one would not survive install.
    expect(await brokenRefs()).toEqual(['glossary']);
  });

  it('suggests a replacement written as a wikilink, not as a path', async () => {
    await bundle('kit', {
      'commands/review.md': 'See [[conventions]].',
      'context/10-conventions.md': '',
    });

    const [broken] = (await scanReferences(workspace)).broken;
    expect(broken?.syntax).toBe('wikilink');
    expect(broken?.suggestions[0]?.ref).toBe('10-conventions');
  });

  it('rewrites only the target, leaving the alias alone', async () => {
    await bundle('kit', {
      'commands/review.md': 'See [[conventions|the house style]].',
      'context/10-conventions.md': '',
    });

    const ok = await refsFixCommand({
      path: workspace,
      cwd: workspace,
      edit: async () => {},
    });

    expect(ok).toBe(true);
    expect(await read('kit/commands/review.md')).toBe(
      'See [[10-conventions|the house style]].',
    );
  });
});

describe('scanReferences', () => {
  it('resolves a reference relative to the file that makes it', async () => {
    await bundle('kit', {
      'skills/audit/SKILL.md': 'Work through `./checklist.md`.',
      'skills/audit/checklist.md': '- one',
    });

    const result = await scanReferences(workspace);
    expect(result.broken).toEqual([]);
    expect(result.refs.find((ref) => ref.ref === './checklist.md')?.via).toBe('file');
  });

  it('resolves a reference relative to the bundle root', async () => {
    await bundle('kit', {
      'commands/review.md': '[the checklist](skills/audit/checklist.md)',
      'skills/audit/checklist.md': '- one',
    });

    const result = await scanReferences(workspace);
    expect(result.broken).toEqual([]);
    expect(result.refs[0]?.via).toBe('bundle');
  });

  it('reports a reference to a file that is not there', async () => {
    await bundle('kit', {
      'commands/review.md': '[the checklist](skills/audit/checklist.md)',
      'skills/audit/steps.md': '- one',
    });

    expect(await brokenRefs()).toEqual(['skills/audit/checklist.md']);
  });

  it('finds references in configs', async () => {
    await bundle('kit', {
      'mcp/server.json': '{ "command": "node", "args": ["./assets/run.js"] }',
      'assets/other.js': '',
    });

    expect(await brokenRefs()).toEqual(['./assets/run.js']);
  });

  it('ignores URLs, anchors and absolute paths', async () => {
    await bundle('kit', {
      'context/notes.md': [
        '[web](https://example.com/thing.md)',
        '[anchor](#a-heading)',
        '[absolute](/etc/hosts.md)',
        '[home](~/notes.md)',
        '[templated](${HOME}/notes.md)',
      ].join('\n'),
    });

    expect(await brokenRefs({ strict: true })).toEqual([]);
  });

  it('ignores paths inside fenced code blocks', async () => {
    await bundle('kit', {
      'README.md': ['```bash', 'cat ./some/made/up/path.md', '```'].join('\n'),
    });

    expect(await brokenRefs({ strict: true })).toEqual([]);
  });

  it('ignores filenames prose mentions but does not ship', async () => {
    await bundle('kit', {
      'skills/audit/SKILL.md': [
        'Identify the manifest (`package.json` + `package-lock.json`, `pnpm-lock.yaml`).',
        "Run the audit command, e.g. `npm audit --json`, and read `tsconfig.json`.",
      ].join('\n'),
    });

    expect(await brokenRefs({ strict: true })).toEqual([]);
  });

  it('ignores install paths a README describes, which start at a hidden directory', async () => {
    await bundle('kit', {
      'README.md': '| context | [skill](.claude/skills/x/SKILL.md), [mcp](.vscode/mcp.json) |',
    });

    expect(await brokenRefs({ strict: true })).toEqual([]);
  });

  it('reports a bare filename under --all-paths when something similar exists', async () => {
    await bundle('kit', {
      'skills/audit/SKILL.md': 'Work through `checklist.md`.',
      'skills/audit/audit-checklist.md': '- one',
    });

    const result = await scanReferences(workspace, { allPaths: true });
    expect(result.broken.map((ref) => ref.ref)).toEqual(['checklist.md']);
    expect(result.broken[0]?.suggestions[0]?.ref).toBe('skills/audit/audit-checklist.md');
  });

  it('records the line and offsets of each reference', async () => {
    await bundle('kit', {
      'context/notes.md': 'first line\nsecond mentions [x](gone/thing.md) here\n',
    });

    const [broken] = (await scanReferences(workspace)).broken;
    expect(broken?.line).toBe(2);
    const text = await read('kit/context/notes.md');
    expect(text.slice(broken?.start, broken?.end)).toBe('gone/thing.md');
  });
});

describe('suggestions', () => {
  it('offers the renamed file, expressed relative to the bundle root', async () => {
    await bundle('kit', {
      'commands/review.md': '[the conventions](context/conventions.md)',
      'context/10-conventions.md': '',
    });

    const [broken] = (await scanReferences(workspace)).broken;
    expect(broken?.suggestions.map((suggestion) => suggestion.ref)).toEqual([
      'context/10-conventions.md',
    ]);
    expect(broken?.suggestions[0]?.crossBundle).toBe(false);
  });

  it('keeps the ./ a reference was written with', async () => {
    await bundle('kit', {
      'skills/audit/SKILL.md': 'Work through `./conventions.md`.',
      'skills/audit/10-conventions.md': '',
    });

    // Dropping the prefix would repair the reference and silently drop it out
    // of every later check, since a bare path is not in scope.
    const [broken] = (await scanReferences(workspace)).broken;
    expect(broken?.suggestions[0]?.ref).toBe('./10-conventions.md');
  });

  it('ranks a file in this bundle above the same name in another', async () => {
    await bundle('kit-a', {
      'commands/review.md': '[the conventions](context/conventions.md)',
      'context/team-conventions.md': '',
    });
    await bundle('kit-b', { 'context/conventions.md': '' });

    const [broken] = (await scanReferences(workspace)).broken;
    expect(broken?.suggestions[0]?.crossBundle).toBe(false);
    expect(broken?.suggestions[0]?.ref).toBe('context/team-conventions.md');
  });

  it('will still reach into a sibling bundle when nothing local fits', async () => {
    await bundle('kit-a', { 'commands/review.md': '[the glossary](shared/glossary.md)' });
    await bundle('kit-b', { 'shared/glossary.md': '' });

    const [broken] = (await scanReferences(workspace)).broken;
    expect(broken?.suggestions[0]?.crossBundle).toBe(true);
    expect(broken?.suggestions[0]?.ref).toContain('kit-b');
  });

  it('offers no more than three, best first', async () => {
    await bundle('kit', {
      'commands/review.md': '[notes](notes.md)',
      'context/notes-one.md': '',
      'context/notes-two.md': '',
      'context/notes-three.md': '',
      'context/notes-four.md': '',
    });

    const [broken] = (await scanReferences(workspace)).broken;
    expect(broken?.suggestions).toHaveLength(3);
    const scores = broken?.suggestions.map((suggestion) => suggestion.score) ?? [];
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe('similarity', () => {
  it('scores a renamed file above an unrelated one', () => {
    expect(similarity('checklist', 'audit-checklist')).toBeGreaterThan(
      similarity('checklist', 'settings'),
    );
  });

  it('scores a typo highly', () => {
    expect(similarity('conventions', 'convetions')).toBeGreaterThan(0.8);
  });

  it('scores an identical name at 1', () => {
    expect(similarity('notes', 'notes')).toBe(1);
  });
});

describe('applyRefEdits', () => {
  it('rewrites the exact occurrence the offsets point at', async () => {
    const file = await write('notes.md', 'see `a.md` and `a.md` again');

    await applyRefEdits([
      { file, original: 'a.md', replacement: 'b.md', start: 16, end: 20 },
    ]);

    expect(await read('notes.md')).toBe('see `a.md` and `b.md` again');
  });

  it('refuses to guess when the same reference appears twice and the offsets moved', async () => {
    const file = await write('notes.md', 'see `a.md` and `a.md` again');

    const [outcome] = await applyRefEdits([{ file, original: 'a.md', replacement: 'b.md' }]);

    expect(outcome?.applied).toBe(false);
    expect(await read('notes.md')).toBe('see `a.md` and `a.md` again');
  });

  it('falls back to a unique occurrence when the offsets no longer line up', async () => {
    const file = await write('notes.md', 'a line was added\nsee `a.md`');

    // Offsets from before the extra line: they no longer match.
    await applyRefEdits([{ file, original: 'a.md', replacement: 'b.md', start: 5, end: 9 }]);

    expect(await read('notes.md')).toBe('a line was added\nsee `b.md`');
  });

  it('applies several edits to one file without disturbing each other', async () => {
    const file = await write('notes.md', 'see `a.md`, then `c.md`, then `e.md`');

    await applyRefEdits([
      { file, original: 'a.md', replacement: 'bb.md', start: 5, end: 9 },
      { file, original: 'c.md', replacement: 'dddd.md', start: 18, end: 22 },
      { file, original: 'e.md', replacement: 'f.md', start: 31, end: 35 },
    ]);

    expect(await read('notes.md')).toBe('see `bb.md`, then `dddd.md`, then `f.md`');
  });

  it('changes nothing on a dry run', async () => {
    const file = await write('notes.md', 'see `a.md`');

    const [outcome] = await applyRefEdits(
      [{ file, original: 'a.md', replacement: 'b.md', start: 5, end: 9 }],
      { dryRun: true },
    );

    expect(outcome?.applied).toBe(true);
    expect(await read('notes.md')).toBe('see `a.md`');
  });
});

describe('the fix file', () => {
  it('is keyed by file, with a suffix when one file broke several references', async () => {
    await bundle('kit', {
      'commands/review.md':
        '[conventions](context/conventions.md) and [PRs](context/pull-requests.md).',
      'context/10-conventions.md': '',
      'context/20-pull-requests.md': '',
    });

    const fixes = buildFixFile(await scanReferences(workspace));

    expect(Object.keys(fixes)).toEqual(['kit/commands/review.md', 'kit/commands/review.md#2']);
    expect(fixes['kit/commands/review.md']).toEqual({
      original_ref: 'context/conventions.md',
      new: ['context/10-conventions.md'],
    });
    expect(fixes['kit/commands/review.md#2']?.original_ref).toBe('context/pull-requests.md');
  });
});

describe('refs fix', () => {
  it('writes the file, waits for the edit, then applies what is left', async () => {
    await bundle('kit', {
      'commands/review.md': '[the conventions](context/conventions.md)',
      'context/10-conventions.md': '',
      'context/notes-conventions.md': '',
    });

    let edited: string | undefined;

    const ok = await refsFixCommand({
      path: workspace,
      cwd: workspace,
      // Stands in for the user: keep one candidate, drop the rest.
      edit: async (file) => {
        edited = file;
        const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Record<
          string,
          { new: string[] }
        >;
        const entry = parsed['kit/commands/review.md'] as { new: string[] };
        expect(entry.new.length).toBeGreaterThan(1);
        entry.new = ['context/10-conventions.md'];
        await fs.writeFile(file, JSON.stringify(parsed, null, 2), 'utf8');
      },
    });

    expect(ok).toBe(true);
    expect(edited).toBeDefined();
    expect(await read('kit/commands/review.md')).toBe(
      '[the conventions](context/10-conventions.md)',
    );
  });

  it('leaves an entry alone when more than one candidate is left in it', async () => {
    await bundle('kit', {
      'commands/review.md': '[the conventions](context/conventions.md)',
      'context/10-conventions.md': '',
      'context/notes-conventions.md': '',
    });

    // The editor changes nothing: both candidates are still there.
    const ok = await refsFixCommand({ path: workspace, cwd: workspace, edit: async () => {} });

    expect(ok).toBe(false);
    expect(await read('kit/commands/review.md')).toBe('[the conventions](context/conventions.md)');
  });

  it('--write saves the file in the working directory and stops', async () => {
    await bundle('kit', {
      'commands/review.md': '[the conventions](context/conventions.md)',
      'context/10-conventions.md': '',
    });

    const ok = await refsFixCommand({ path: workspace, cwd: workspace, write: true });

    expect(ok).toBe(true);
    const written = JSON.parse(await read('hcm-refs.json')) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(['kit/commands/review.md']);
    // Nothing applied yet -- that is what --file is for.
    expect(await read('kit/commands/review.md')).toBe('[the conventions](context/conventions.md)');
  });

  it('--write takes a filename of its own', async () => {
    await bundle('kit', {
      'commands/review.md': '[the conventions](context/conventions.md)',
      'context/10-conventions.md': '',
    });

    await refsFixCommand({ path: workspace, cwd: workspace, write: 'my-fixes.json' });

    expect(JSON.parse(await read('my-fixes.json'))).toHaveProperty('kit/commands/review.md');
  });

  it('--file applies an edited file from anywhere', async () => {
    await bundle('kit', {
      'commands/review.md': '[the conventions](context/conventions.md)',
      'context/10-conventions.md': '',
    });

    await write(
      'elsewhere/fixes.json',
      JSON.stringify({
        'kit/commands/review.md': {
          original_ref: 'context/conventions.md',
          new: ['context/10-conventions.md'],
        },
      }),
    );

    const ok = await refsFixCommand({
      path: workspace,
      cwd: workspace,
      file: 'elsewhere/fixes.json',
    });

    expect(ok).toBe(true);
    expect(await read('kit/commands/review.md')).toBe(
      '[the conventions](context/10-conventions.md)',
    );
  });

  it('applies under the same scope it was written under', async () => {
    await bundle('kit', {
      'commands/review.md': 'Read `context/conventions.md`.',
      'context/10-conventions.md': '',
    });

    await write(
      'fixes.json',
      JSON.stringify({
        'kit/commands/review.md': {
          original_ref: 'context/conventions.md',
          new: ['context/10-conventions.md'],
        },
      }),
    );

    // Without --all-paths the re-scan does not see an implicit path in inline
    // code, so it has no offsets for it -- but the reference occurs once, and
    // the unique-occurrence fallback still pins it down.
    const ok = await refsFixCommand({
      path: workspace,
      cwd: workspace,
      file: 'fixes.json',
      allPaths: true,
    });

    expect(ok).toBe(true);
    expect(await read('kit/commands/review.md')).toBe('Read `context/10-conventions.md`.');
  });

  it('--dry-run reports without writing', async () => {
    await bundle('kit', {
      'commands/review.md': '[the conventions](context/conventions.md)',
      'context/10-conventions.md': '',
    });

    await write(
      'fixes.json',
      JSON.stringify({
        'kit/commands/review.md': {
          original_ref: 'context/conventions.md',
          new: ['context/10-conventions.md'],
        },
      }),
    );

    await refsFixCommand({ path: workspace, cwd: workspace, file: 'fixes.json', dryRun: true });

    expect(await read('kit/commands/review.md')).toBe('[the conventions](context/conventions.md)');
  });

  it('rejects a fix file that is not the shape it should be', async () => {
    await bundle('kit', { 'commands/review.md': 'nothing broken here' });
    await write('fixes.json', JSON.stringify({ 'kit/commands/review.md': { newish: [] } }));

    await expect(
      refsFixCommand({ path: workspace, cwd: workspace, file: 'fixes.json' }),
    ).rejects.toThrow(/malformed/i);
  });

  it('says there is nothing to do when nothing is broken', async () => {
    await bundle('kit', {
      'commands/review.md': '[the conventions](context/conventions.md)',
      'context/conventions.md': '',
    });

    expect(await refsFixCommand({ path: workspace, cwd: workspace })).toBe(true);
  });
});

describe('refs check', () => {
  it('reports success when everything resolves', async () => {
    await bundle('kit', {
      'skills/audit/SKILL.md': 'Work through `./checklist.md`.',
      'skills/audit/checklist.md': '',
    });

    expect(await refsCheckCommand({ path: workspace, cwd: workspace })).toBe(true);
  });

  it('fails when something does not', async () => {
    await bundle('kit', { 'skills/audit/SKILL.md': 'Work through `./steps/checklist.md`.' });

    expect(await refsCheckCommand({ path: workspace, cwd: workspace })).toBe(false);
  });

  it('passes on prose that the old scope would have failed on', async () => {
    await bundle('kit', {
      'skills/audit/SKILL.md': 'A file will be created named `report.txt`.',
      'skills/audit/report-template.txt': '',
    });

    expect(await refsCheckCommand({ path: workspace, cwd: workspace })).toBe(true);
    expect(await refsCheckCommand({ path: workspace, cwd: workspace, allPaths: true })).toBe(false);
  });

  it('refuses a path that is not there', async () => {
    await expect(
      refsCheckCommand({ path: 'nowhere-at-all', cwd: workspace }),
    ).rejects.toThrow(/No such path/);
  });
});
