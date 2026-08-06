import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/core/hash.js';
import {
  appendArrayItems,
  flattenLeaves,
  getAtPointer,
  pruneEmptyAncestors,
  removeArrayItems,
  removeAtPointer,
  setAtPointer,
} from '../src/merge/json-merge.js';

describe('setAtPointer', () => {
  it('creates missing containers', () => {
    const doc: Record<string, unknown> = {};
    const result = setAtPointer(doc, ['mcpServers', 'github'], { command: 'gh' });

    expect(doc).toEqual({ mcpServers: { github: { command: 'gh' } } });
    expect(result.hadPrevious).toBe(false);
  });

  it('records the previous value when overwriting', () => {
    const doc: Record<string, unknown> = { mcpServers: { github: { command: 'old' } } };
    const result = setAtPointer(doc, ['mcpServers', 'github'], { command: 'new' });

    expect(result.hadPrevious).toBe(true);
    expect(result.previous).toEqual({ command: 'old' });
  });
});

describe('removeAtPointer', () => {
  const value = { command: 'gh', args: ['mcp'] };

  it('removes a value that still matches the recorded hash', () => {
    const doc: Record<string, unknown> = { mcpServers: { github: value } };
    const outcome = removeAtPointer(doc, ['mcpServers', 'github'], hashValue(value));

    expect(outcome).toBe('removed');
    expect(doc).toEqual({ mcpServers: {} });
  });

  it('matches regardless of key order in the file', () => {
    // Same data, different key order -- canonical hashing must still match.
    const doc: Record<string, unknown> = {
      mcpServers: { github: { args: ['mcp'], command: 'gh' } },
    };
    expect(removeAtPointer(doc, ['mcpServers', 'github'], hashValue(value))).toBe('removed');
  });

  it('refuses to remove a value edited since install', () => {
    const doc: Record<string, unknown> = {
      mcpServers: { github: { command: 'gh', args: ['mcp', '--verbose'] } },
    };
    const outcome = removeAtPointer(doc, ['mcpServers', 'github'], hashValue(value));

    expect(outcome).toBe('modified');
    expect(getAtPointer(doc, ['mcpServers', 'github'])).toBeDefined();
  });

  it('removes an edited value when forced', () => {
    const doc: Record<string, unknown> = { mcpServers: { github: { command: 'changed' } } };
    const outcome = removeAtPointer(doc, ['mcpServers', 'github'], hashValue(value), {
      force: true,
    });

    expect(outcome).toBe('removed');
  });

  it('restores the value it replaced', () => {
    const doc: Record<string, unknown> = { mcpServers: { github: value } };
    const outcome = removeAtPointer(doc, ['mcpServers', 'github'], hashValue(value), {
      hadPrevious: true,
      restore: { command: 'original' },
    });

    expect(outcome).toBe('restored');
    expect(getAtPointer(doc, ['mcpServers', 'github'])).toEqual({ command: 'original' });
  });

  it('reports missing when the key is already gone', () => {
    expect(removeAtPointer({}, ['mcpServers', 'github'], hashValue(value))).toBe('missing');
  });
});

describe('two bundles sharing one file', () => {
  it('uninstalling one leaves the other untouched', () => {
    const doc: Record<string, unknown> = {};
    const alpha = { command: 'alpha' };
    const beta = { command: 'beta' };

    setAtPointer(doc, ['mcpServers', 'alpha'], alpha);
    setAtPointer(doc, ['mcpServers', 'beta'], beta);

    // Simulate the file being rewritten by another tool: keys reordered.
    const reordered = { mcpServers: { beta, alpha } } as Record<string, unknown>;

    const outcome = removeAtPointer(reordered, ['mcpServers', 'alpha'], hashValue(alpha));
    pruneEmptyAncestors(reordered, ['mcpServers', 'alpha']);

    expect(outcome).toBe('removed');
    expect(reordered).toEqual({ mcpServers: { beta } });
  });

  it('keeps the shared container when another bundle still uses it', () => {
    const doc: Record<string, unknown> = { mcpServers: { beta: { command: 'beta' } } };
    pruneEmptyAncestors(doc, ['mcpServers', 'alpha']);
    expect(doc).toEqual({ mcpServers: { beta: { command: 'beta' } } });
  });

  it('prunes containers left empty by the removal', () => {
    const doc: Record<string, unknown> = { mcpServers: {} };
    pruneEmptyAncestors(doc, ['mcpServers', 'alpha']);
    expect(doc).toEqual({});
  });

  it('prunes nested empties all the way up', () => {
    const doc: Record<string, unknown> = { permissions: { allow: [] } };
    pruneEmptyAncestors(doc, ['permissions', 'allow']);
    expect(doc).toEqual({});
  });
});

describe('array items', () => {
  it('appends only values that are not already present', () => {
    const doc: Record<string, unknown> = { permissions: { allow: ['Read(**)'] } };
    const result = appendArrayItems(doc, ['permissions', 'allow'], ['Read(**)', 'Bash(git:*)']);

    expect(result.appended).toEqual(['Bash(git:*)']);
    expect(doc.permissions).toEqual({ allow: ['Read(**)', 'Bash(git:*)'] });
  });

  it('removes items by value hash, ignoring position', () => {
    const doc: Record<string, unknown> = {
      permissions: { allow: ['Bash(git:*)', 'Read(**)', 'Write(**)'] },
    };
    const { removed, missing } = removeArrayItems(doc, ['permissions', 'allow'], [
      hashValue('Read(**)'),
    ]);

    expect({ removed, missing }).toEqual({ removed: 1, missing: 0 });
    expect(doc.permissions).toEqual({ allow: ['Bash(git:*)', 'Write(**)'] });
  });

  it('reports items that were already removed by hand', () => {
    const doc: Record<string, unknown> = { permissions: { allow: ['Read(**)'] } };
    const { removed, missing } = removeArrayItems(doc, ['permissions', 'allow'], [
      hashValue('Read(**)'),
      hashValue('Bash(git:*)'),
    ]);

    expect({ removed, missing }).toEqual({ removed: 1, missing: 1 });
  });
});

describe('flattenLeaves', () => {
  it('produces one pointer per leaf so each is independently revocable', () => {
    const leaves = flattenLeaves({
      permissions: { allow: ['Read(**)'], defaultMode: 'acceptEdits' },
      model: 'opus',
    });

    expect(leaves).toEqual([
      { pointer: ['permissions', 'allow'], value: ['Read(**)'] },
      { pointer: ['permissions', 'defaultMode'], value: 'acceptEdits' },
      { pointer: ['model'], value: 'opus' },
    ]);
  });
});
