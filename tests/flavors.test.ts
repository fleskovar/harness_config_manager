/**
 * Installing part of a bundle.
 *
 *   hcm install polyglot-kit --flavor python
 *
 * One kit covers Python and C#; a flavor names the half of it that is only
 * useful in one of them, and everything a flavor does not claim is *common* and
 * installs either way. `tests/fixtures/bundles/polyglot-kit` is that bundle,
 * checked in as files — its README is the answer key for the counts asserted
 * here, and you can work them out yourself before reading either.
 *
 * The two halves of this file are worth reading in order. The first is what a
 * flavor *is*: how a manifest declares it, how a resource joins it, and what a
 * narrowed plan therefore contains. The second is what it costs elsewhere —
 * that the choice is remembered for `hcm update`, that a dependency which has
 * never heard of the flavor still arrives whole, and that naming several
 * bundles at once with one `--flavor` is refused rather than guessed at.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/install.js';
import { registryListCommand } from '../src/commands/registry.js';
import { uninstallCommand } from '../src/commands/uninstall.js';
import { updateCommand } from '../src/commands/update.js';
import { validateCommand } from '../src/commands/validate.js';
import { loadBundle, validateBundle } from '../src/core/bundle.js';
import {
  attachFlavors,
  expandFlavors,
  inFlavors,
  matchesPattern,
  normalizeFlavors,
} from '../src/core/flavors.js';
import { configureLogger } from '../src/core/logger.js';
import { buildPlan } from '../src/core/planner.js';
import { addToRegistry, readRegistry } from '../src/core/registry.js';
import { readState } from '../src/core/state.js';
import type { BundleManifest, InstallationRecord } from '../src/core/types.js';
import { copyFixture, exists, listTree, makeWorkspace, readText } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let kit: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await makeWorkspace('flavors');
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });
  kit = await copyFixture('bundles/polyglot-kit', path.join(workspace, 'polyglot-kit'));

  previousHome = process.env.HCM_HOME;
  process.env.HCM_HOME = path.join(workspace, 'home');
  configureLogger({ quiet: true });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HCM_HOME;
  else process.env.HCM_HOME = previousHome;
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

/** Install the fixture into Claude Code, optionally narrowed. */
const install = (flavors?: string[]): Promise<void> =>
  installCommand(kit, {
    targets: ['claude-code'],
    scope: 'project',
    cwd: projectDir,
    ...(flavors ? { flavors } : {}),
  });

const records = async (): Promise<InstallationRecord[]> =>
  (await readState('project', projectDir)).installations;

/** A manifest object, for the parsing tests that need no files. */
const manifestWith = (flavors: unknown): BundleManifest =>
  ({ name: 'kit', version: '1.0.0', flavors }) as BundleManifest;

// ---------------------------------------------------------------------------
// What a flavor is
// ---------------------------------------------------------------------------

describe('declaring flavors in a manifest', () => {
  it('takes a bare list of names', () => {
    expect(normalizeFlavors(manifestWith(['python', 'csharp']))).toEqual([
      { name: 'python', includes: [] },
      { name: 'csharp', includes: [] },
    ]);
  });

  it('takes a mapping of name to description', () => {
    expect(normalizeFlavors(manifestWith({ python: 'Python tooling' }))).toEqual([
      { name: 'python', description: 'Python tooling', includes: [] },
    ]);
  });

  it('takes a mapping of name to description and patterns', () => {
    const flavors = normalizeFlavors(
      manifestWith({ python: { description: 'Python tooling', includes: ['rules/python.md'] } }),
    );

    expect(flavors).toEqual([
      { name: 'python', description: 'Python tooling', includes: ['rules/python.md'] },
    ]);
  });

  it('takes a name with nothing after it, which YAML hands over as null', () => {
    expect(normalizeFlavors(manifestWith({ python: null }))).toEqual([
      { name: 'python', includes: [] },
    ]);
  });

  it('normalises a pattern written as a directory', () => {
    // `assets/python/` and `./assets/python` are the same folder.
    const flavors = normalizeFlavors(manifestWith({ python: { includes: './assets/python/' } }));
    expect(flavors[0]?.includes).toEqual(['assets/python']);
  });

  it('says so when "flavors" is not a list or a mapping', () => {
    expect(() => normalizeFlavors(manifestWith('python'))).toThrow(
      /must be a list of names or a mapping/,
    );
  });

  it('refuses a name that could not be typed on a command line', () => {
    expect(() => normalizeFlavors(manifestWith(['py thon']))).toThrow(/not a usable flavor name/);
  });

  it('refuses the same flavor twice', () => {
    expect(() => normalizeFlavors(manifestWith({ python: 'a', Python: 'b' }))).toThrow(
      /listed twice/,
    );
  });

  it('reserves "all", which is how a user asks for the whole bundle', () => {
    expect(() => normalizeFlavors(manifestWith(['all']))).toThrow(/cannot be used as a flavor name/);
  });
});

// ---------------------------------------------------------------------------

describe('matching resources to flavors by path', () => {
  it('matches a file exactly', () => {
    expect(matchesPattern('rules/python.md', 'rules/python.md')).toBe(true);
    expect(matchesPattern('rules/csharp.md', 'rules/python.md')).toBe(false);
  });

  it('takes everything under a directory it names', () => {
    expect(matchesPattern('assets/python/lint.sh', 'assets/python')).toBe(true);
    expect(matchesPattern('assets/python/tools/fmt.sh', 'assets/python')).toBe(true);
    expect(matchesPattern('assets/csharp/lint.sh', 'assets/python')).toBe(false);
  });

  it('keeps * inside one path segment and ** across them', () => {
    expect(matchesPattern('skills/pytest-runner', 'skills/pytest-*')).toBe(true);
    expect(matchesPattern('skills/pytest-runner/SKILL.md', 'skills/pytest-*')).toBe(true);
    expect(matchesPattern('rules/python.md', '*.md')).toBe(false);
    expect(matchesPattern('rules/python.md', '**/*.md')).toBe(true);
    // `**/` also matches no directory at all.
    expect(matchesPattern('python.md', '**/*.md')).toBe(true);
  });

  it('matches ? against one character', () => {
    expect(matchesPattern('rules/py.md', 'rules/p?.md')).toBe(true);
    expect(matchesPattern('rules/pyx.md', 'rules/p?.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('reading the flavors off a bundle', () => {
  it('finds both, with what each is for', async () => {
    const bundle = await loadBundle(kit);

    expect(bundle.flavors.map((flavor) => flavor.name)).toEqual(['python', 'csharp']);
    expect(bundle.flavors[0]?.description).toBe('Python typing, linting and test tooling');
  });

  it('tags a resource from its own frontmatter and from the manifest alike', async () => {
    const bundle = await loadBundle(kit);
    const flavorsOf = (bundlePath: string): string[] =>
      bundle.resources.find((resource) => resource.bundlePath === bundlePath)?.flavors ?? [];

    // Said in the file itself...
    expect(flavorsOf('subagents/python-typer.md')).toEqual(['python']);
    expect(flavorsOf('skills/pytest-runner')).toEqual(['python']);
    // ...and said for it by the manifest, which is the only way for these three.
    expect(flavorsOf('rules/python.md')).toEqual(['python']);
    expect(flavorsOf('mcp/pyright.json')).toEqual(['python']);
    expect(flavorsOf('assets/python/lint.sh')).toEqual(['python']);
    // Everything else is common.
    expect(flavorsOf('subagents/code-reviewer.md')).toEqual([]);
    expect(flavorsOf('settings/settings.json')).toEqual([]);
  });

  it('takes "flavors" back out of the frontmatter, so no installed file carries it', async () => {
    const bundle = await loadBundle(kit);
    const typer = bundle.resources.find(
      (resource) => resource.bundlePath === 'subagents/python-typer.md',
    );

    expect(typer?.flavors).toEqual(['python']);
    expect(typer?.frontmatter).not.toHaveProperty('flavors');
    // The rest of the frontmatter is untouched.
    expect(typer?.frontmatter.tools).toEqual(['Read', 'Edit', 'Bash']);
  });

  it('lets the resources define the flavors when the manifest declares none', () => {
    const resources = [
      { bundlePath: 'subagents/a.md', frontmatter: { flavors: ['python'] }, flavors: [] },
      { bundlePath: 'subagents/b.md', frontmatter: { flavor: 'csharp' }, flavors: [] },
      { bundlePath: 'subagents/c.md', frontmatter: {}, flavors: [] },
    ] as never as Parameters<typeof attachFlavors>[0];

    // The shortest way to write an all-markdown kit: no manifest entry at all.
    expect(attachFlavors(resources, []).map((flavor) => flavor.name)).toEqual(['csharp', 'python']);
    expect(resources[0]?.flavors).toEqual(['python']);
    expect(resources[1]?.flavors).toEqual(['csharp']);
    expect(resources[2]?.flavors).toEqual([]);
  });

  it('gives a bundle with no flavors at all an empty list rather than a special case', async () => {
    const plain = await copyFixture('bundles/review-kit', path.join(workspace, 'review-kit'));
    const bundle = await loadBundle(plain);

    expect(bundle.flavors).toEqual([]);
    expect(bundle.resources.every((resource) => resource.flavors.length === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('deciding what an install contains', () => {
  const resource = (flavors: string[]): Parameters<typeof inFlavors>[0] =>
    ({ flavors }) as never;

  it('installs a common resource whatever was asked for', () => {
    expect(inFlavors(resource([]), [])).toBe(true);
    expect(inFlavors(resource([]), ['python'])).toBe(true);
  });

  it('installs a flavored resource only when its flavor was asked for', () => {
    expect(inFlavors(resource(['python']), ['python'])).toBe(true);
    expect(inFlavors(resource(['python']), ['csharp'])).toBe(false);
    expect(inFlavors(resource(['python', 'csharp']), ['csharp'])).toBe(true);
  });

  it('treats asking for no flavor as asking for all of them', () => {
    expect(inFlavors(resource(['python']), [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('what the command line means', () => {
  it('trims, keeps the order typed, and says each flavor once', () => {
    expect(expandFlavors([' python ', 'csharp', 'PYTHON'])).toEqual(['python', 'csharp']);
  });

  it('reads a missing flag and "all" alike, as no narrowing', () => {
    expect(expandFlavors(undefined)).toBeUndefined();
    expect(expandFlavors([])).toBeUndefined();
    expect(expandFlavors(['all'])).toBeUndefined();
    // Contradictory, and the wider reading is the safe one.
    expect(expandFlavors(['python', 'all'])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Installing part of a bundle
// ---------------------------------------------------------------------------

describe('a narrowed install', () => {
  /** Common, and nothing else. */
  const COMMON_FILES = [
    '.claude/agents/code-reviewer.md', // subagents/code-reviewer.md
    '.claude/commands/review-pr.md', // commands/review-pr.md
    '.claude/settings.json', // settings/settings.json
    '.claude/skills/pr-checklist/SKILL.md', // skills/pr-checklist/
    'CLAUDE.md', // context/10-conventions.md
  ];

  it('writes the common part plus the flavor asked for', async () => {
    await install(['python']);

    expect(await listTree(projectDir)).toEqual(
      [
        ...COMMON_FILES,
        '.claude/agents/python-typer.md', // subagents/python-typer.md
        '.claude/python/lint.sh', // assets/python/lint.sh
        '.claude/rules/python.md', // rules/python.md
        '.claude/skills/pytest-runner/SKILL.md', // skills/pytest-runner/
        '.claude/skills/pytest-runner/failure-modes.md',
        '.mcp.json', // mcp/pyright.json
      ].sort(),
    );
  });

  it('leaves out the other flavor entirely', async () => {
    await install(['python']);

    expect(await exists(projectDir, '.claude/agents/csharp-analyzer.md')).toBe(false);
    expect(await exists(projectDir, '.claude/rules/csharp.md')).toBe(false);
  });

  it('installs everything when no flavor is named', async () => {
    await install();

    expect(await exists(projectDir, '.claude/agents/python-typer.md')).toBe(true);
    expect(await exists(projectDir, '.claude/agents/csharp-analyzer.md')).toBe(true);
    expect(await exists(projectDir, '.claude/rules/python.md')).toBe(true);
    expect(await exists(projectDir, '.claude/rules/csharp.md')).toBe(true);
  });

  it('takes several flavors at once', async () => {
    await install(['python', 'csharp']);

    // Both languages, which for this bundle is everything.
    expect(await listTree(projectDir)).toEqual(await listTreeOfFullInstall());
  });

  it('narrows the smaller flavor just as well', async () => {
    await install(['csharp']);

    expect(await listTree(projectDir)).toEqual(
      [
        ...COMMON_FILES,
        '.claude/agents/csharp-analyzer.md',
        '.claude/rules/csharp.md',
      ].sort(),
    );
    // The MCP server belongs to the Python flavor, so there is no .mcp.json at all.
    expect(await exists(projectDir, '.mcp.json')).toBe(false);
  });

  it('claims only what it wrote, so uninstall leaves nothing behind', async () => {
    await install(['python']);
    const [record] = await records();
    expect(record?.receipts).toHaveLength(11);

    await uninstallCommand('polyglot-kit', {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
    });

    expect(await listTree(projectDir)).toEqual([]);
  });

  it('writes no "flavors" key into the files it installs', async () => {
    await install(['python']);

    // The tag is hcm's bookkeeping; a harness reading the frontmatter must not
    // find a key it has never heard of.
    expect(await readText(projectDir, '.claude/agents/python-typer.md')).not.toMatch(/flavors/);
    expect(await readText(projectDir, '.claude/skills/pytest-runner/SKILL.md')).not.toMatch(
      /flavors/,
    );
  });

  it('remembers the choice, so nothing has to be told again', async () => {
    await install(['python']);

    expect((await records())[0]?.flavors).toEqual(['python']);
  });

  it('records nothing when the whole bundle was installed', async () => {
    await install();

    // Absent, not empty: that is what every record written before flavors
    // existed says, and it has to keep meaning "all of it".
    expect((await records())[0]).not.toHaveProperty('flavors');
  });

  /** The file list a full install produces, for comparing a widened one against. */
  async function listTreeOfFullInstall(): Promise<string[]> {
    const elsewhere = path.join(workspace, 'full');
    await fs.mkdir(elsewhere, { recursive: true });
    await installCommand(kit, { targets: ['claude-code'], scope: 'project', cwd: elsewhere });
    return listTree(elsewhere);
  }
});

// ---------------------------------------------------------------------------

describe('planning, one target at a time', () => {
  it('reports what the flavor left out rather than dropping it silently', async () => {
    const bundle = await loadBundle(kit);
    const plan = await buildPlan(bundle, 'claude-code', 'project', projectDir, {}, ['python']);

    const skipped = plan.skipped.map((entry) => entry.resource.bundlePath).sort();
    expect(skipped).toEqual(['rules/csharp.md', 'subagents/csharp-analyzer.md']);
    expect(plan.skipped[0]?.reason).toMatch(/not in the flavor\(s\) asked for: python/);
    expect(plan.flavors).toEqual(['python']);
  });

  it('plans the whole bundle when nothing was asked for', async () => {
    const bundle = await loadBundle(kit);
    const plan = await buildPlan(bundle, 'claude-code', 'project', projectDir);

    expect(plan.skipped).toEqual([]);
    expect(plan.flavors).toEqual([]);
  });

  it('reports a common file pointing at one the flavor left out', async () => {
    // The trap an author falls into: a command everyone gets, referring to a
    // skill only one flavor installs. The remapper already knows the file is
    // shipped but not installed, and says so -- the same warning it gives for a
    // resource a harness has no mapping for.
    await fs.appendFile(
      path.join(kit, 'commands', 'review-pr.md'),
      '\nWhen the change is Python, use `skills/pytest-runner/SKILL.md`.\n',
    );

    const bundle = await loadBundle(kit);
    const plan = await buildPlan(bundle, 'claude-code', 'project', projectDir, {}, ['csharp']);

    expect(plan.references?.dropped).toEqual([
      {
        path: '.claude/commands/review-pr.md',
        ref: 'skills/pytest-runner/SKILL.md',
        reason: 'the file it names is not installed into this harness',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('a flavor the bundle does not have', () => {
  it('is refused, and the ones it does have are named', async () => {
    await expect(install(['rust'])).rejects.toThrow(/"polyglot-kit" has no flavor "rust"/);
    // The alternatives are in the hint, which is where hcm puts what to do next.
    expect(await hintFrom(install(['rust']))).toMatch(/It offers: python, csharp/);

    // Refused before anything is planned, so the common part is not written
    // either -- which is what the mistake would otherwise look like.
    expect(await listTree(projectDir)).toEqual([]);
  });

  it('is refused for a bundle that has no flavors at all', async () => {
    const plain = await copyFixture('bundles/review-kit', path.join(workspace, 'review-kit'));
    const attempt = installCommand(plain, {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      flavors: ['python'],
    });

    await expect(attempt).rejects.toThrow(/"review-kit" has no flavor "python"/);
  });

  it('is matched however it was capitalised', async () => {
    await install(['PYTHON']);

    expect(await exists(projectDir, '.claude/agents/python-typer.md')).toBe(true);
    expect(await exists(projectDir, '.claude/agents/csharp-analyzer.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('several bundles and one --flavor', () => {
  /** A second kit with the same two flavors, so a shared narrowing is legal. */
  const makeKit = async (name: string, flavors: string[]): Promise<string> => {
    const dir = path.join(workspace, 'kits', name);
    await fs.mkdir(path.join(dir, 'subagents'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'hcm.yaml'),
      `name: ${name}\nversion: 1.0.0\nflavors: [${flavors.join(', ')}]\n`,
    );
    await fs.writeFile(
      path.join(dir, 'subagents', `${name}-common.md`),
      `---\ndescription: Common to ${name}\n---\n\nWork.\n`,
    );
    for (const flavor of flavors) {
      await fs.writeFile(
        path.join(dir, 'subagents', `${name}-${flavor}.md`),
        `---\ndescription: ${flavor} work for ${name}\nflavors: [${flavor}]\n---\n\nWork.\n`,
      );
    }
    return dir;
  };

  it('narrows both when both define the flavor', async () => {
    const kits = [
      await makeKit('alpha', ['python', 'csharp']),
      await makeKit('beta', ['python', 'csharp']),
    ];

    await installCommand(kits, {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      flavors: ['python'],
    });

    expect(await listTree(projectDir)).toEqual([
      '.claude/agents/alpha-common.md',
      '.claude/agents/alpha-python.md',
      '.claude/agents/beta-common.md',
      '.claude/agents/beta-python.md',
    ]);
  });

  it('is refused when one of them has never heard of it', async () => {
    const kits = [
      await makeKit('alpha', ['python', 'csharp']),
      await makeKit('beta', ['rust']),
    ];

    // One --flavor cannot mean the Python part of one and the whole of the
    // other, and picking either reading for the user would be a guess.
    await expect(
      installCommand(kits, {
        targets: ['claude-code'],
        scope: 'project',
        cwd: projectDir,
        flavors: ['python'],
      }),
    ).rejects.toThrow(/--flavor python does not apply to "beta"/);

    expect(await listTree(projectDir)).toEqual([]);
  });

  it('installs both in full when no flavor is named', async () => {
    const kits = [await makeKit('alpha', ['python']), await makeKit('beta', ['rust'])];

    await installCommand(kits, {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
    });

    expect(await listTree(projectDir)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------

describe('a dependency of a narrowed bundle', () => {
  const makeKit = async (
    name: string,
    body: { flavors?: string; dependencies?: string; tagged?: string[] },
  ): Promise<string> => {
    const dir = path.join(workspace, 'kits', name);
    await fs.mkdir(path.join(dir, 'subagents'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'hcm.yaml'),
      [
        `name: ${name}`,
        'version: 1.0.0',
        ...(body.flavors ? [`flavors: [${body.flavors}]`] : []),
        ...(body.dependencies ? [`dependencies:\n  - ${body.dependencies}`] : []),
        '',
      ].join('\n'),
    );
    await fs.writeFile(
      path.join(dir, 'subagents', `${name}-common.md`),
      `---\ndescription: Common to ${name}\n---\n\nWork.\n`,
    );
    for (const flavor of body.tagged ?? []) {
      await fs.writeFile(
        path.join(dir, 'subagents', `${name}-${flavor}.md`),
        `---\ndescription: ${flavor} work\nflavors: [${flavor}]\n---\n\nWork.\n`,
      );
    }
    return dir;
  };

  it('arrives whole when it has no such flavor, being all common part', async () => {
    // The rule needs no exception for dependencies: a bundle with no flavors is
    // entirely common, so every flavor selection takes all of it.
    await addToRegistry(await makeKit('shared', {}), workspace);
    const dependent = await makeKit('coding-kit', {
      flavors: 'python, csharp',
      dependencies: 'shared',
      tagged: ['python', 'csharp'],
    });

    await installCommand(dependent, {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      flavors: ['python'],
    });

    expect(await listTree(projectDir)).toEqual([
      '.claude/agents/coding-kit-common.md',
      '.claude/agents/coding-kit-python.md',
      '.claude/agents/shared-common.md',
    ]);
  });

  it('is narrowed too when it happens to share the flavor', async () => {
    await addToRegistry(
      await makeKit('shared', { flavors: 'python, csharp', tagged: ['python', 'csharp'] }),
      workspace,
    );
    const dependent = await makeKit('coding-kit', {
      flavors: 'python, csharp',
      dependencies: 'shared',
      tagged: ['python', 'csharp'],
    });

    await installCommand(dependent, {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      flavors: ['python'],
    });

    // The C# half of the dependency is no more wanted than the C# half of the
    // bundle that required it.
    expect(await listTree(projectDir)).toEqual([
      '.claude/agents/coding-kit-common.md',
      '.claude/agents/coding-kit-python.md',
      '.claude/agents/shared-common.md',
      '.claude/agents/shared-python.md',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Living with a narrowed install
// ---------------------------------------------------------------------------

describe('updating a bundle installed as part of itself', () => {
  const register = async (): Promise<void> => {
    await addToRegistry(kit, workspace);
  };

  it('reinstalls the same subset without being told again', async () => {
    await register();
    await installCommand('polyglot-kit', {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      flavors: ['python'],
    });

    await updateCommand([], { targets: ['claude-code'], cwd: projectDir });

    expect(await exists(projectDir, '.claude/agents/python-typer.md')).toBe(true);
    expect(await exists(projectDir, '.claude/agents/csharp-analyzer.md')).toBe(false);
    expect((await records())[0]?.flavors).toEqual(['python']);
  });

  it('switches flavor when told to, taking the old one away', async () => {
    await register();
    await installCommand('polyglot-kit', {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      flavors: ['python'],
    });

    await updateCommand(['polyglot-kit'], {
      targets: ['claude-code'],
      cwd: projectDir,
      flavors: ['csharp'],
    });

    // An update is rollback-then-install, so the Python half goes rather than
    // being left behind beside the C# half.
    expect(await exists(projectDir, '.claude/agents/python-typer.md')).toBe(false);
    expect(await exists(projectDir, '.claude/agents/csharp-analyzer.md')).toBe(true);
    expect((await records())[0]?.flavors).toEqual(['csharp']);
  });

  it('widens back to the whole bundle with --flavor all', async () => {
    await register();
    await installCommand('polyglot-kit', {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      flavors: ['python'],
    });

    // Omitting the flag would reinstall the recorded subset, so "all of it"
    // needs something to say.
    await updateCommand(['polyglot-kit'], {
      targets: ['claude-code'],
      cwd: projectDir,
      flavors: ['all'],
    });

    expect(await exists(projectDir, '.claude/agents/python-typer.md')).toBe(true);
    expect(await exists(projectDir, '.claude/agents/csharp-analyzer.md')).toBe(true);
    expect((await records())[0]).not.toHaveProperty('flavors');
  });

  it('refuses a flavor the refreshed bundle does not have', async () => {
    await register();
    await installCommand('polyglot-kit', {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
    });

    await expect(
      updateCommand(['polyglot-kit'], {
        targets: ['claude-code'],
        cwd: projectDir,
        flavors: ['rust'],
      }),
    ).rejects.toThrow(/has no flavor "rust"/);
  });
});

// ---------------------------------------------------------------------------

describe('saying which parts exist', () => {
  it('records them on the registry entry, so a listing need not read the bundle', async () => {
    await addToRegistry(kit, workspace);
    const registry = await readRegistry();

    expect(registry.entries[0]?.flavors).toEqual([
      { name: 'python', description: 'Python typing, linting and test tooling' },
      { name: 'csharp', description: 'C# analyzers and conventions' },
    ]);
  });

  it('prints them in "hcm registry list"', async () => {
    await addToRegistry(kit, workspace);

    expect(await capture(() => registryListCommand({}))).toMatch(/flavors: python, csharp/);
  });

  it('leaves the entry alone for a bundle that has none', async () => {
    const plain = await copyFixture('bundles/review-kit', path.join(workspace, 'review-kit'));
    await addToRegistry(plain, workspace);

    const registry = await readRegistry();
    expect(registry.entries[0]).not.toHaveProperty('flavors');
  });
});

// ---------------------------------------------------------------------------

describe('what hcm validate has to say', () => {
  it('finds nothing wrong with the fixture', async () => {
    expect(await validateCommand(kit, { cwd: workspace })).toBe(true);
  });

  it('reports a resource claiming a flavor the manifest never declared', async () => {
    await fs.writeFile(
      path.join(kit, 'subagents', 'rust-clippy.md'),
      '---\ndescription: Reads clippy output\nflavors: [rust]\n---\n\nWork.\n',
    );

    const problems = validateBundle(await loadBundle(kit));
    expect(problems).toContainEqual(
      expect.stringMatching(/rust-clippy\.md: flavor "rust" is not declared in the manifest/),
    );
  });

  it('reports a pattern that matches nothing, which is how a rename goes unnoticed', async () => {
    await fs.writeFile(
      path.join(kit, 'hcm.yaml'),
      'name: polyglot-kit\nversion: 1.0.0\nflavors:\n  python:\n    includes: [rules/pythn.md]\n',
    );

    const problems = validateBundle(await loadBundle(kit));
    expect(problems).toContainEqual(
      expect.stringMatching(/"rules\/pythn\.md" matches nothing in the bundle/),
    );
  });

  it('reports a flavor nothing belongs to', async () => {
    await fs.writeFile(
      path.join(kit, 'hcm.yaml'),
      'name: polyglot-kit\nversion: 1.0.0\nflavors: [python, csharp, rust]\n',
    );

    const problems = validateBundle(await loadBundle(kit));
    expect(problems).toContainEqual(
      expect.stringMatching(/Flavor "rust" has no resources/),
    );
  });
});

/** The hint an HcmError carried -- what to do next, which is not in `message`. */
async function hintFrom(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (error) {
    return (error as { hint?: string }).hint ?? '';
  }
  throw new Error('expected the call to fail');
}

/** Run something that logs, and hand back everything it printed. */
async function capture(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  configureLogger({});

  try {
    await run();
  } finally {
    console.log = original;
    configureLogger({ quiet: true });
  }

  return lines.join('\n');
}
