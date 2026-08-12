/**
 * Finding broken references, and the round trip that repairs them.
 *
 * The interesting half of this is not detection but *restraint*: a bundle's
 * prose is full of filenames that are not references, and a checker that cries
 * wolf about `package.json` is a checker nobody runs. So most of what follows
 * pins down what the scanner deliberately ignores.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFixFile, refsCheckCommand, refsFixCommand } from '../src/commands/refs.js';
import { configureLogger } from '../src/core/logger.js';
import { applyRefEdits, scanReferences, similarity } from '../src/core/refs.js';

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

const brokenRefs = async (options?: { strict?: boolean }): Promise<string[]> => {
  const result = await scanReferences(workspace, options ?? {});
  return result.broken.map((ref) => ref.ref);
};

// ---------------------------------------------------------------------------

describe('scanReferences', () => {
  it('resolves a reference relative to the file that makes it', async () => {
    await bundle('kit', {
      'skills/audit/SKILL.md': 'Work through `checklist.md`.',
      'skills/audit/checklist.md': '- one',
    });

    const result = await scanReferences(workspace);
    expect(result.broken).toEqual([]);
    expect(result.refs.find((ref) => ref.ref === 'checklist.md')?.via).toBe('file');
  });

  it('resolves a reference relative to the bundle root', async () => {
    await bundle('kit', {
      'commands/review.md': 'Follow `skills/audit/checklist.md`.',
      'skills/audit/checklist.md': '- one',
    });

    const result = await scanReferences(workspace);
    expect(result.broken).toEqual([]);
    expect(result.refs[0]?.via).toBe('bundle');
  });

  it('reports a reference to a file that is not there', async () => {
    await bundle('kit', {
      'commands/review.md': 'Follow `skills/audit/checklist.md`.',
      'skills/audit/steps.md': '- one',
    });

    expect(await brokenRefs()).toEqual(['skills/audit/checklist.md']);
  });

  it('finds references in every markdown form', async () => {
    await bundle('kit', {
      'context/notes.md': [
        '[a link](missing-one.md)',
        '![an image](missing-two.png)',
        'and `missing-three.md`',
        'and @missing-four.md',
        '',
        '[def]: missing-five.md',
      ].join('\n'),
      // Something similar for each, so the weak ones are reported too.
      'context/present-one.md': '',
      'context/present-two.png': '',
      'context/present-three.md': '',
      'context/present-four.md': '',
      'context/present-five.md': '',
    });

    expect((await brokenRefs()).sort()).toEqual([
      'missing-five.md',
      'missing-four.md',
      'missing-one.md',
      'missing-three.md',
      'missing-two.png',
    ]);
  });

  it('finds references in configs', async () => {
    await bundle('kit', {
      'mcp/server.json': '{ "command": "node", "args": ["assets/run.js"] }',
      'assets/other.js': '',
    });

    expect(await brokenRefs()).toEqual(['assets/run.js']);
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
      'README.md': ['```bash', 'cat some/made/up/path.md', '```'].join('\n'),
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
      'README.md': '| context | `.claude/skills/x/SKILL.md`, `.vscode/mcp.json` |',
    });

    expect(await brokenRefs({ strict: true })).toEqual([]);
  });

  it('stays quiet about a bare filename with nothing like it in the tree', async () => {
    await bundle('kit', { 'context/notes.md': 'Check `whatever.md` before starting.' });

    // Nothing similar exists: this is prose about a file the bundle does not
    // ship, and there would be no fix to offer even if it were not.
    expect(await brokenRefs()).toEqual([]);
    // Unless asked for outright.
    expect(await brokenRefs({ strict: true })).toEqual(['whatever.md']);
  });

  it('reports a bare filename when something similar exists to point at', async () => {
    await bundle('kit', {
      'skills/audit/SKILL.md': 'Work through `checklist.md`.',
      'skills/audit/audit-checklist.md': '- one',
    });

    const result = await scanReferences(workspace);
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
      'commands/review.md': 'See `context/conventions.md`.',
      'context/10-conventions.md': '',
    });

    const [broken] = (await scanReferences(workspace)).broken;
    expect(broken?.suggestions.map((suggestion) => suggestion.ref)).toEqual([
      'context/10-conventions.md',
    ]);
    expect(broken?.suggestions[0]?.crossBundle).toBe(false);
  });

  it('ranks a file in this bundle above the same name in another', async () => {
    await bundle('kit-a', {
      'commands/review.md': 'See `context/conventions.md`.',
      'context/team-conventions.md': '',
    });
    await bundle('kit-b', { 'context/conventions.md': '' });

    const [broken] = (await scanReferences(workspace)).broken;
    expect(broken?.suggestions[0]?.crossBundle).toBe(false);
    expect(broken?.suggestions[0]?.ref).toBe('context/team-conventions.md');
  });

  it('will still reach into a sibling bundle when nothing local fits', async () => {
    await bundle('kit-a', { 'commands/review.md': 'See `shared/glossary.md`.' });
    await bundle('kit-b', { 'shared/glossary.md': '' });

    const [broken] = (await scanReferences(workspace)).broken;
    expect(broken?.suggestions[0]?.crossBundle).toBe(true);
    expect(broken?.suggestions[0]?.ref).toContain('kit-b');
  });

  it('offers no more than three, best first', async () => {
    await bundle('kit', {
      'commands/review.md': 'See `notes.md`.',
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
      'commands/review.md': 'See `context/conventions.md` and `context/pull-requests.md`.',
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
      'commands/review.md': 'See `context/conventions.md`.',
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
    expect(await read('kit/commands/review.md')).toBe('See `context/10-conventions.md`.');
  });

  it('leaves an entry alone when more than one candidate is left in it', async () => {
    await bundle('kit', {
      'commands/review.md': 'See `context/conventions.md`.',
      'context/10-conventions.md': '',
      'context/notes-conventions.md': '',
    });

    // The editor changes nothing: both candidates are still there.
    const ok = await refsFixCommand({ path: workspace, cwd: workspace, edit: async () => {} });

    expect(ok).toBe(false);
    expect(await read('kit/commands/review.md')).toBe('See `context/conventions.md`.');
  });

  it('--write saves the file in the working directory and stops', async () => {
    await bundle('kit', {
      'commands/review.md': 'See `context/conventions.md`.',
      'context/10-conventions.md': '',
    });

    const ok = await refsFixCommand({ path: workspace, cwd: workspace, write: true });

    expect(ok).toBe(true);
    const written = JSON.parse(await read('hcm-refs.json')) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(['kit/commands/review.md']);
    // Nothing applied yet -- that is what --file is for.
    expect(await read('kit/commands/review.md')).toBe('See `context/conventions.md`.');
  });

  it('--write takes a filename of its own', async () => {
    await bundle('kit', {
      'commands/review.md': 'See `context/conventions.md`.',
      'context/10-conventions.md': '',
    });

    await refsFixCommand({ path: workspace, cwd: workspace, write: 'my-fixes.json' });

    expect(JSON.parse(await read('my-fixes.json'))).toHaveProperty('kit/commands/review.md');
  });

  it('--file applies an edited file from anywhere', async () => {
    await bundle('kit', {
      'commands/review.md': 'See `context/conventions.md`.',
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
    expect(await read('kit/commands/review.md')).toBe('See `context/10-conventions.md`.');
  });

  it('--dry-run reports without writing', async () => {
    await bundle('kit', {
      'commands/review.md': 'See `context/conventions.md`.',
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

    expect(await read('kit/commands/review.md')).toBe('See `context/conventions.md`.');
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
      'commands/review.md': 'See `context/conventions.md`.',
      'context/conventions.md': '',
    });

    expect(await refsFixCommand({ path: workspace, cwd: workspace })).toBe(true);
  });
});

describe('refs check', () => {
  it('reports success when everything resolves', async () => {
    await bundle('kit', {
      'skills/audit/SKILL.md': 'Work through `checklist.md`.',
      'skills/audit/checklist.md': '',
    });

    expect(await refsCheckCommand({ path: workspace, cwd: workspace })).toBe(true);
  });

  it('fails when something does not', async () => {
    await bundle('kit', { 'skills/audit/SKILL.md': 'Work through `steps/checklist.md`.' });

    expect(await refsCheckCommand({ path: workspace, cwd: workspace })).toBe(false);
  });

  it('refuses a path that is not there', async () => {
    await expect(
      refsCheckCommand({ path: 'nowhere-at-all', cwd: workspace }),
    ).rejects.toThrow(/No such path/);
  });
});
