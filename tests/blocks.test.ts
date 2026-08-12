import { describe, expect, it } from 'vitest';
import {
  extractBlocks,
  hasBlock,
  keepOnlyBlocks,
  listBlockIds,
  removeBlock,
  upsertBlock,
} from '../src/merge/blocks.js';

describe('markdown blocks', () => {
  it('appends a block without disturbing existing content', () => {
    const original = '# My project\n\nHand-written notes.\n';
    const result = upsertBlock(original, 'markdown', 'alpha/context', 'Alpha instructions.');

    expect(result).toContain('# My project');
    expect(result).toContain('Hand-written notes.');
    expect(result).toContain('<!-- hcm:begin alpha/context -->');
    expect(result).toContain('<!-- hcm:end alpha/context -->');
  });

  it('removes only its own block when several bundles share the file', () => {
    let content = '# My project\n\nHand-written notes.\n';
    content = upsertBlock(content, 'markdown', 'alpha/context', 'Alpha instructions.');
    content = upsertBlock(content, 'markdown', 'beta/context', 'Beta instructions.');

    const removed = removeBlock(content, 'markdown', 'alpha/context');

    expect(removed).toBeDefined();
    expect(removed).not.toContain('Alpha instructions.');
    expect(removed).toContain('Beta instructions.');
    expect(removed).toContain('Hand-written notes.');
  });

  it('survives content being added around the block', () => {
    let content = upsertBlock('', 'markdown', 'alpha/context', 'Alpha instructions.');
    // Someone edits the file afterwards, above and below our block.
    content = `# Added later\n\n${content}\n## Also added later\n`;

    const removed = removeBlock(content, 'markdown', 'alpha/context');

    expect(removed).toContain('# Added later');
    expect(removed).toContain('## Also added later');
    expect(removed).not.toContain('Alpha instructions.');
  });

  it('replaces the block in place on reinstall', () => {
    const first = upsertBlock('intro\n', 'markdown', 'alpha/context', 'v1');
    const second = upsertBlock(first, 'markdown', 'alpha/context', 'v2');

    expect(second).toContain('v2');
    expect(second).not.toContain('v1');
    expect(second.match(/hcm:begin alpha\/context/g)).toHaveLength(1);
  });

  it('returns undefined when the block is not present', () => {
    expect(removeBlock('nothing here', 'markdown', 'alpha/context')).toBeUndefined();
  });
});

describe('toml blocks', () => {
  it('uses comment markers and preserves surrounding config', () => {
    const original = '# my settings\n[permissions]\nallow = ["Bash(ls)"]\n';
    const content = upsertBlock(
      original,
      'toml',
      'alpha/plugins/github',
      '[[plugins]]\nname = "github"\ncommand = "gh"',
    );

    expect(content).toContain('# hcm:begin alpha/plugins/github');
    expect(content).toContain('# hcm:end alpha/plugins/github');
    expect(content).toContain('[permissions]');

    const removed = removeBlock(content, 'toml', 'alpha/plugins/github');
    expect(removed).toContain('# my settings');
    expect(removed).toContain('[permissions]');
    expect(removed).not.toContain('[[plugins]]');
  });
});

describe('listBlockIds', () => {
  it('reports the blocks present in a file', () => {
    let content = upsertBlock('', 'markdown', 'alpha/context', 'a');
    content = upsertBlock(content, 'markdown', 'beta/context', 'b');

    expect(listBlockIds(content, 'markdown')).toEqual(['alpha/context', 'beta/context']);
    expect(hasBlock(content, 'markdown', 'beta/context')).toBe(true);
  });
});

describe('extractBlocks', () => {
  it('returns each block whole, in order', () => {
    let content = upsertBlock('# Notes\n', 'markdown', 'alpha/context', 'Alpha.');
    content = upsertBlock(content, 'markdown', 'beta/context', 'Beta.');

    const blocks = extractBlocks(content, 'markdown');
    expect(blocks.map((block) => block.id)).toEqual(['alpha/context', 'beta/context']);
    expect(blocks[0]?.text).toBe(
      '<!-- hcm:begin alpha/context -->\nAlpha.\n<!-- hcm:end alpha/context -->',
    );
  });

  it('ignores a begin marker whose end has been deleted', () => {
    // The text after it is no longer ours to move or throw away.
    const content = '<!-- hcm:begin alpha/context -->\nAlpha.\n\nSomething else.\n';
    expect(extractBlocks(content, 'markdown')).toEqual([]);
  });

  it('finds toml blocks too', () => {
    const content = upsertBlock('model = "x"\n', 'toml', 'alpha/plugins/gh', '[[plugins]]');
    expect(extractBlocks(content, 'toml').map((block) => block.id)).toEqual(['alpha/plugins/gh']);
  });
});

describe('keepOnlyBlocks', () => {
  it('drops everything hcm did not write, and counts it', () => {
    let content = '# Written by an agent\n\nStale detail.\n';
    content = upsertBlock(content, 'markdown', 'alpha/context', 'Alpha.');
    content = upsertBlock(content, 'markdown', 'beta/context', 'Beta.');

    const result = keepOnlyBlocks(content, 'markdown');

    expect(result.content).not.toContain('Stale detail.');
    expect(result.content).toContain('Alpha.');
    expect(result.content).toContain('Beta.');
    expect(result.blocks).toHaveLength(2);
    // "# Written by an agent" and "Stale detail." -- blank lines do not count.
    expect(result.discardedLines).toBe(2);
  });

  it('leaves a file that is nothing but blocks unchanged', () => {
    const content = upsertBlock('', 'markdown', 'alpha/context', 'Alpha.');
    const result = keepOnlyBlocks(content, 'markdown');

    expect(result.content).toBe(content);
    expect(result.discardedLines).toBe(0);
  });
});
