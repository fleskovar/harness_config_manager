import { describe, expect, it } from 'vitest';
import { describeSource, parseGithubSource } from '../src/core/github.js';

const parse = (input: string) => parseGithubSource(input);

describe('shorthand', () => {
  it('parses owner/repo', () => {
    expect(parse('acme/my-kit')).toEqual({
      type: 'github',
      owner: 'acme',
      repo: 'my-kit',
      ref: 'HEAD',
    });
  });

  it('parses a ref and a subdirectory', () => {
    expect(parse('acme/kits/bundles/my-kit#v1.2.0')).toEqual({
      type: 'github',
      owner: 'acme',
      repo: 'kits',
      ref: 'v1.2.0',
      subdir: 'bundles/my-kit',
    });
  });
});

describe('browser URLs', () => {
  it('parses a repo address-bar URL', () => {
    expect(parse('https://github.com/acme/my-kit')).toEqual({
      type: 'github',
      owner: 'acme',
      repo: 'my-kit',
      ref: 'HEAD',
    });
  });

  it('tolerates a trailing slash, www, and http', () => {
    for (const input of [
      'https://github.com/acme/my-kit/',
      'https://www.github.com/acme/my-kit',
      'http://github.com/acme/my-kit',
    ]) {
      expect(parse(input)).toMatchObject({ owner: 'acme', repo: 'my-kit', ref: 'HEAD' });
    }
  });

  it("strips GitHub's own query string", () => {
    expect(parse('https://github.com/acme/my-kit?tab=readme-ov-file')).toEqual({
      type: 'github',
      owner: 'acme',
      repo: 'my-kit',
      ref: 'HEAD',
    });
  });

  it('ignores UI fragments but honours a real ref', () => {
    expect(parse('https://github.com/acme/my-kit#readme')).toMatchObject({ ref: 'HEAD' });
    expect(parse('https://github.com/acme/my-kit#L42')).toMatchObject({ ref: 'HEAD' });
    expect(parse('https://github.com/acme/my-kit#v1.2.0')).toMatchObject({ ref: 'v1.2.0' });
  });

  it('parses a directory view', () => {
    expect(parse('https://github.com/acme/kits/tree/main/bundles/my-kit')).toEqual({
      type: 'github',
      owner: 'acme',
      repo: 'kits',
      ref: 'main',
      subdir: 'bundles/my-kit',
    });
  });

  it('parses a branch view with no subdirectory', () => {
    expect(parse('https://github.com/acme/my-kit/tree/develop')).toEqual({
      type: 'github',
      owner: 'acme',
      repo: 'my-kit',
      ref: 'develop',
    });
  });

  it('resolves a file view to the directory containing it', () => {
    // Linking straight at the manifest is a natural thing to paste.
    expect(parse('https://github.com/acme/kits/blob/main/bundles/my-kit/hcm.yaml')).toEqual({
      type: 'github',
      owner: 'acme',
      repo: 'kits',
      ref: 'main',
      subdir: 'bundles/my-kit',
    });
  });

  it('drops the filename from a blob URL even when it has no extension', () => {
    // GitHub uses /blob/ only for files, so the last segment is always a
    // filename -- README and LICENSE must not be mistaken for directories.
    expect(parse('https://github.com/acme/kits/blob/main/bundles/my-kit/README')).toMatchObject({
      subdir: 'bundles/my-kit',
    });
    expect(parse('https://github.com/octocat/Hello-World/blob/master/README')).toEqual({
      type: 'github',
      owner: 'octocat',
      repo: 'Hello-World',
      ref: 'master',
    });
  });

  it('falls back to the repo for unrelated GitHub pages', () => {
    expect(parse('https://github.com/acme/my-kit/issues/12')).toEqual({
      type: 'github',
      owner: 'acme',
      repo: 'my-kit',
      ref: 'HEAD',
    });
  });
});

describe('clone URLs', () => {
  it('parses an HTTPS clone URL', () => {
    expect(parse('https://github.com/acme/my-kit.git')).toEqual({
      type: 'github',
      owner: 'acme',
      repo: 'my-kit',
      ref: 'HEAD',
    });
  });

  it('parses an SSH clone URL', () => {
    expect(parse('git@github.com:acme/my-kit.git')).toEqual({
      type: 'github',
      owner: 'acme',
      repo: 'my-kit',
      ref: 'HEAD',
    });
  });

  it('parses an SSH clone URL without the .git suffix', () => {
    expect(parse('git@github.com:acme/my-kit')).toMatchObject({ owner: 'acme', repo: 'my-kit' });
  });

  it('parses the ssh:// protocol form', () => {
    expect(parse('ssh://git@github.com/acme/my-kit.git')).toMatchObject({
      owner: 'acme',
      repo: 'my-kit',
    });
  });

  it('parses the git:// protocol form', () => {
    expect(parse('git://github.com/acme/my-kit.git')).toMatchObject({
      owner: 'acme',
      repo: 'my-kit',
    });
  });
});

describe('non-GitHub input', () => {
  it('rejects local paths so they resolve as directories', () => {
    for (const input of [
      './my-kit',
      '../kits/my-kit',
      'C:/local/my-kit',
      '/home/me/my-kit',
      'my-kit',
      '',
    ]) {
      expect(parse(input)).toBeUndefined();
    }
  });

  it('rejects other hosts', () => {
    expect(parse('https://gitlab.com/acme/my-kit')).toBeUndefined();
    expect(parse('git@gitlab.com:acme/my-kit.git')).toBeUndefined();
  });

  it('rejects a GitHub URL with no repository', () => {
    expect(parse('https://github.com/acme')).toBeUndefined();
  });
});

describe('describeSource', () => {
  it('round-trips into a readable form', () => {
    const source = parse('https://github.com/acme/kits/tree/v2/bundles/my-kit');
    expect(describeSource(source!)).toBe('github:acme/kits/bundles/my-kit#v2');
  });
});
