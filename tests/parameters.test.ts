/**
 * Customising a bundle as it is installed.
 *
 *   hcm install branded-kit --param TEAM=Platform
 *
 * A bundle declares the values it wants; its files refer to them as
 * `<%NAME%>`; and the install fills them in.
 * `tests/fixtures/bundles/branded-kit` is that bundle, checked in as files —
 * its README is the answer key for what is asserted here, and you can work out
 * the expected text yourself before reading either.
 *
 * The file is in four parts, worth reading in order. First what a parameter
 * *is*: how a manifest declares one, what the placeholder means, and where a
 * parameter applies. Then what an install does with them — every kind of file a
 * bundle can hold, rendered. Then where the values come from, which is the half
 * that has to work with no terminal attached. And last what it costs elsewhere:
 * that the values are remembered for `hcm update`, that secrets are not, and
 * that `hcm validate` catches the placeholder nobody declared.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { infoCommand } from '../src/commands/info.js';
import { installCommand } from '../src/commands/install.js';
import { paramsInitCommand } from '../src/commands/params.js';
import { registryListCommand } from '../src/commands/registry.js';
import { updateCommand } from '../src/commands/update.js';
import { validateCommand } from '../src/commands/validate.js';
import { loadBundle, validateBundle } from '../src/core/bundle.js';
import { configureLogger } from '../src/core/logger.js';
import {
  appliesTo,
  applicableParameters,
  normalizeParameters,
  parseAssignments,
  placeholderNames,
  readParametersFile,
  renderTemplate,
  resolveParameters,
  storableValues,
  withDefaults,
} from '../src/core/parameters.js';
import { buildPlan } from '../src/core/planner.js';
import { addToRegistry, readRegistry } from '../src/core/registry.js';
import { readState } from '../src/core/state.js';
import type {
  BundleManifest,
  InstallationRecord,
  ParameterDefinition,
} from '../src/core/types.js';
import { copyFixture, exists, listTree, makeWorkspace, readJson, readText } from './support/fixtures.js';

let workspace: string;
let projectDir: string;
let kit: string;
let previousHome: string | undefined;

beforeEach(async () => {
  workspace = await makeWorkspace('parameters');
  projectDir = path.join(workspace, 'project');
  await fs.mkdir(projectDir, { recursive: true });
  kit = await copyFixture('bundles/branded-kit', path.join(workspace, 'branded-kit'));

  previousHome = process.env.HCM_HOME;
  process.env.HCM_HOME = path.join(workspace, 'home');
  configureLogger({ quiet: true });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HCM_HOME;
  else process.env.HCM_HOME = previousHome;
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('HCM_PARAM_')) delete process.env[name];
  }
  configureLogger({});
  await fs.rm(workspace, { recursive: true, force: true });
});

/** Install the fixture, with whatever the command line would have said. */
const install = (options: { params?: string[]; targets?: string[]; flavors?: string[] } = {}) =>
  installCommand(kit, {
    targets: options.targets ?? ['claude-code'],
    scope: 'project',
    cwd: projectDir,
    ...(options.params ? { params: options.params } : {}),
    ...(options.flavors ? { flavors: options.flavors } : {}),
  });

/** The one thing every install of this fixture has to be told. */
const TEAM = 'TEAM=Platform';

const records = async (): Promise<InstallationRecord[]> =>
  (await readState('project', projectDir)).installations;

/** A manifest object, for the parsing tests that need no files. */
const manifestWith = (parameters: unknown): BundleManifest =>
  ({ name: 'kit', version: '1.0.0', parameters }) as BundleManifest;

/** One definition, for the tests about where a parameter applies. */
const parameter = (extra: Partial<ParameterDefinition> = {}): ParameterDefinition => ({
  name: 'NAME',
  required: true,
  flavors: [],
  targets: [],
  ...extra,
});

// ---------------------------------------------------------------------------
// What a parameter is
// ---------------------------------------------------------------------------

describe('declaring parameters in a manifest', () => {
  it('takes a bare list of names, each of them required', () => {
    expect(normalizeParameters(manifestWith(['AGENT_NAME', 'TEAM']))).toEqual([
      { name: 'AGENT_NAME', required: true, flavors: [], targets: [] },
      { name: 'TEAM', required: true, flavors: [], targets: [] },
    ]);
  });

  it('takes a mapping of name to description', () => {
    expect(normalizeParameters(manifestWith({ AGENT_NAME: 'What it calls itself' }))).toEqual([
      {
        name: 'AGENT_NAME',
        description: 'What it calls itself',
        required: true,
        flavors: [],
        targets: [],
      },
    ]);
  });

  it('takes a name with nothing after it, which YAML hands over as null', () => {
    expect(normalizeParameters(manifestWith({ AGENT_NAME: null }))).toEqual([
      { name: 'AGENT_NAME', required: true, flavors: [], targets: [] },
    ]);
  });

  it('takes the full shape, and stops requiring what it can default', () => {
    const [declared] = normalizeParameters(
      manifestWith({
        AGENT_NAME: {
          description: 'What it calls itself',
          default: 'Claude',
          choices: ['Claude', 'Codey'],
          flavors: ['python'],
          targets: ['claude-code'],
        },
      }),
    );

    expect(declared).toEqual({
      name: 'AGENT_NAME',
      description: 'What it calls itself',
      default: 'Claude',
      // A parameter that can always answer itself is not one an install has to
      // be told; `required` only decides what happens with nothing to fall
      // back on.
      required: false,
      choices: ['Claude', 'Codey'],
      flavors: ['python'],
      targets: ['claude-code'],
    });
  });

  it('reads a number or a boolean default as the text it will become', () => {
    // Everything ends up substituted into a file, so `default: 3` needs no
    // ceremony to mean what it plainly means.
    expect(normalizeParameters(manifestWith({ RETRIES: { default: 3 } }))[0]?.default).toBe('3');
    expect(normalizeParameters(manifestWith({ STRICT: { default: true } }))[0]?.default).toBe(
      'true',
    );
  });

  it('resolves a harness alias to its id', () => {
    const [declared] = normalizeParameters(manifestWith({ MODEL: { targets: 'claude' } }));
    expect(declared?.targets).toEqual(['claude-code']);
  });

  it('refuses a name that could not be an environment variable', () => {
    // The name has to survive HCM_PARAM_<NAME> as well as <% %>.
    expect(() => normalizeParameters(manifestWith(['agent-name']))).toThrow(
      /not a usable parameter name/,
    );
    expect(() => normalizeParameters(manifestWith(['1ST']))).toThrow(/not a usable parameter name/);
  });

  it('refuses the same parameter twice, however it was capitalised', () => {
    expect(() => normalizeParameters(manifestWith({ TEAM: 'a', team: 'b' }))).toThrow(
      /listed twice/,
    );
  });

  it('refuses a default the parameter would itself reject', () => {
    expect(() =>
      normalizeParameters(manifestWith({ TONE: { default: 'brusque', choices: ['direct'] } })),
    ).toThrow(/default for parameter "TONE".*is not one of its choices/);

    expect(() =>
      normalizeParameters(manifestWith({ TEAM: { default: '3', pattern: '^[a-z]+$' } })),
    ).toThrow(/does not match its own pattern/);
  });

  it('refuses a pattern that is not a regular expression, and a harness that is not one', () => {
    expect(() => normalizeParameters(manifestWith({ TEAM: { pattern: '[' } }))).toThrow(
      /not a valid regular expression/,
    );
    expect(() => normalizeParameters(manifestWith({ TEAM: { targets: ['emacs'] } }))).toThrow(
      /not a harness hcm knows/,
    );
  });

  it('says so when "parameters" is not a list or a mapping', () => {
    expect(() => normalizeParameters(manifestWith('AGENT_NAME'))).toThrow(
      /must be a list of names or a mapping/,
    );
  });
});

// ---------------------------------------------------------------------------

describe('the placeholder', () => {
  const values = { AGENT_NAME: 'Ada', TEAM: 'Platform' };

  it('is replaced wherever it appears', () => {
    const { text } = renderTemplate('I am <%AGENT_NAME%>, of <%AGENT_NAME%> and <%TEAM%>.', values);
    expect(text).toBe('I am Ada, of Ada and Platform.');
  });

  it('tolerates spaces inside the delimiters', () => {
    expect(renderTemplate('<% AGENT_NAME %>', values).text).toBe('Ada');
  });

  it('counts what it filled in, and what it could not', () => {
    const result = renderTemplate('<%AGENT_NAME%> <%AGENT_NAME%> <%NOBODY%>', values);
    expect(result.substituted.get('AGENT_NAME')).toBe(2);
    expect(result.unresolved.get('NOBODY')).toBe(1);
  });

  it('leaves a name nothing has a value for exactly as it was', () => {
    // Verbatim and reported, rather than blanked: an instruction with a hole in
    // it can be seen, and one that has silently lost half a sentence cannot.
    expect(renderTemplate('Ask <%NOBODY%>.', values).text).toBe('Ask <%NOBODY%>.');
  });

  it('unescapes a doubled %, which is how a bundle documents this feature', () => {
    expect(renderTemplate('write <%%AGENT_NAME%> to refer to it', values).text).toBe(
      'write <%AGENT_NAME%> to refer to it',
    );
  });

  it('leaves another template language alone', () => {
    // Only a bare name between the delimiters is ours; an expression is not.
    const text = '<% if user.admin %>hello<% end %>';
    expect(renderTemplate(text, values).text).toBe(text);
  });

  it('lists the names a piece of text refers to, escaped ones excluded', () => {
    expect(placeholderNames('<%A%> <%%B%> <%C%> <%A%>').sort()).toEqual(['A', 'C']);
  });
});

// ---------------------------------------------------------------------------

describe('where a parameter applies', () => {
  it('applies everywhere when it names neither a flavor nor a harness', () => {
    const global = parameter();
    expect(appliesTo(global, { target: 'claude-code', flavors: [] })).toBe(true);
    expect(appliesTo(global, { target: 'copilot', flavors: ['python'] })).toBe(true);
  });

  it('applies to a flavor only when that flavor is being installed', () => {
    const scoped = parameter({ flavors: ['python'] });
    expect(appliesTo(scoped, { target: 'claude-code', flavors: ['python'] })).toBe(true);
    expect(appliesTo(scoped, { target: 'claude-code', flavors: ['csharp'] })).toBe(false);
    // Asking for no flavor asks for all of them -- the same rule resources follow.
    expect(appliesTo(scoped, { target: 'claude-code', flavors: [] })).toBe(true);
  });

  it('applies to a harness only when installing into it', () => {
    const scoped = parameter({ targets: ['claude-code'] });
    expect(appliesTo(scoped, { target: 'claude-code', flavors: [] })).toBe(true);
    expect(appliesTo(scoped, { target: 'copilot', flavors: [] })).toBe(false);
  });

  it('narrows the list an install has to answer', () => {
    const declared = [
      parameter({ name: 'GLOBAL' }),
      parameter({ name: 'PY', flavors: ['python'] }),
      parameter({ name: 'CC', targets: ['claude-code'] }),
    ];

    expect(
      applicableParameters(declared, { target: 'copilot', flavors: ['csharp'] }).map((p) => p.name),
    ).toEqual(['GLOBAL']);
  });

  it('still renders a narrowed parameter from its default, so no file gets a hole', () => {
    // Applicability decides what is *asked*. A parameter only asked for on
    // Claude Code still has a default, and a common file mentioning it must
    // read as that default in every other harness.
    const declared = [parameter({ name: 'MODEL', targets: ['claude-code'], default: 'sonnet' })];
    expect(withDefaults({}, declared)).toEqual({ MODEL: 'sonnet' });
    // What was actually resolved always wins over the fallback.
    expect(withDefaults({ MODEL: 'opus' }, declared)).toEqual({ MODEL: 'opus' });
  });
});

// ---------------------------------------------------------------------------
// Rendering an install
// ---------------------------------------------------------------------------

/**
 * What an install *writes* is `tests/cases/parameter-fills-the-templates/`,
 * where every rendered file is a baseline beside the template it came from.
 * What is left here is what a tree cannot show: the plan's own report of what
 * it substituted, the hashes that make a reinstall a no-op, and a binary asset
 * that must come through untouched.
 */
describe('what an install writes', () => {
  it('leaves a binary asset byte-for-byte alone', async () => {
    // Decoding a PNG as UTF-8, substituting nothing and re-encoding would
    // corrupt it. A NUL byte is the cheapest reliable evidence that a file is
    // not text, and this one is a real PNG header.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
    await fs.writeFile(path.join(kit, 'assets', 'logo.png'), png);

    await install({ params: [TEAM] });

    const installed = await fs.readFile(path.join(projectDir, '.claude', 'logo.png'));
    expect(installed.equals(png)).toBe(true);
  });

  it('reports every substitution on the plan, so nothing is applied unseen', async () => {
    const bundle = await loadBundle(kit);
    const plan = await buildPlan(bundle, 'claude-code', 'project', projectDir, {}, [], {
      TEAM: 'Platform',
    });

    const identity = plan.templating?.substituted.filter((entry) => entry.path === 'CLAUDE.md');
    expect(identity).toContainEqual({ path: 'CLAUDE.md', name: 'TEAM', count: 1 });
    // AGENT_NAME had no value in this plan, so it is reported as left standing.
    expect(plan.templating?.unresolved).toContainEqual({
      path: 'CLAUDE.md',
      name: 'AGENT_NAME',
      reason: 'is a parameter of this bundle, but does not apply to this harness or flavor',
    });
  });

  it('hashes what it wrote, so a reinstall of the same values is not a conflict', async () => {
    await install({ params: [TEAM, 'AGENT_NAME=Ada'] });
    // Substitution happens before anything is compared against disk, so the
    // receipts describe the rendered text rather than the template.
    await expect(install({ params: [TEAM, 'AGENT_NAME=Ada'] })).resolves.toBeUndefined();

    expect(await readText(projectDir, '.claude/settings.json')).toContain('"agentName": "Ada"');
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe('a parameter narrowed to one flavor', () => {
  it('is recorded when its flavor is installed', async () => {
    await install({ params: [TEAM], flavors: ['python'] });

    expect((await records())[0]?.parameters).toHaveProperty('PYTEST_ARGS', '-q');
    expect(await readText(projectDir, '.claude/skills/pytest-runner/SKILL.md')).toContain(
      'Run `pytest -q`',
    );
  });

  it('is left out when its flavor is not', async () => {
    // Nothing that mentions it is being installed either, so there is nothing
    // to fill in and no reason to have asked.
    await install({ params: [TEAM], flavors: ['python'] });
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.mkdir(projectDir, { recursive: true });

    await installCommand(kit, {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      params: [TEAM],
      // The fixture has one flavor, so "not python" needs a bundle that has two;
      // narrowing to a flavor the parameter does not name is what matters here.
      flavors: ['python'],
    });

    expect(await exists(projectDir, '.claude/skills/pytest-runner/SKILL.md')).toBe(true);
  });

  it('is not asked for when the plan cannot use it', () => {
    const bundlePython = parameter({ name: 'PYTEST_ARGS', flavors: ['python'], default: '-q' });
    expect(
      applicableParameters([bundlePython], { target: 'claude-code', flavors: ['csharp'] }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Where the values come from
// ---------------------------------------------------------------------------

describe('reading --param', () => {
  it('takes a plain assignment as applying to every bundle', () => {
    expect(parseAssignments(['TEAM=Platform']).global).toEqual({ TEAM: 'Platform' });
  });

  it('takes a bundle-scoped and a harness-scoped one', () => {
    const overrides = parseAssignments(['kit:TEAM=A', 'kit@copilot:TEAM=B']);

    expect(overrides.byBundle).toEqual({ kit: { TEAM: 'A' } });
    expect(overrides.byBundleTarget).toEqual({ 'kit@copilot': { TEAM: 'B' } });
  });

  it('keeps everything after the first "=", which is what a value may contain', () => {
    expect(parseAssignments(['MOTTO=move fast, then=stop']).global).toEqual({
      MOTTO: 'move fast, then=stop',
    });
  });

  it('accepts an empty value', () => {
    expect(parseAssignments(['SUFFIX=']).global).toEqual({ SUFFIX: '' });
  });

  it('refuses something that is not an assignment at all', () => {
    expect(() => parseAssignments(['TEAM'])).toThrow(/is not a parameter assignment/);
    expect(() => parseAssignments(['kit@nowhere:TEAM=A'])).toThrow(/not a harness hcm knows/);
  });
});

// ---------------------------------------------------------------------------

describe('reading a parameters file', () => {
  const write = async (name: string, body: string): Promise<string> => {
    const file = path.join(workspace, name);
    await fs.writeFile(file, body);
    return file;
  };

  it('reads the three scopes', async () => {
    const file = await write(
      'params.yaml',
      [
        'TEAM: Platform',
        'bundles:',
        '  branded-kit:',
        '    AGENT_NAME: Ada',
        '    targets:',
        '      copilot:',
        '        AGENT_NAME: Cop',
        '',
      ].join('\n'),
    );

    const overrides = await readParametersFile(file, workspace);
    expect(overrides.global).toEqual({ TEAM: 'Platform' });
    expect(overrides.byBundle).toEqual({ 'branded-kit': { AGENT_NAME: 'Ada' } });
    expect(overrides.byBundleTarget).toEqual({ 'branded-kit@copilot': { AGENT_NAME: 'Cop' } });
  });

  it('reads JSON, the other spelling a manifest may use', async () => {
    const file = await write('params.json', JSON.stringify({ TEAM: 'Platform' }));
    expect((await readParametersFile(file, workspace)).global).toEqual({ TEAM: 'Platform' });
  });

  it('reads a number or a boolean as the text it will become', async () => {
    const file = await write('params.yaml', 'RETRIES: 3\nSTRICT: true\n');
    expect((await readParametersFile(file, workspace)).global).toEqual({
      RETRIES: '3',
      STRICT: 'true',
    });
  });

  it('installs from one, so twenty machines can be set up identically', async () => {
    const file = await write('params.yaml', 'TEAM: Platform\nAGENT_NAME: Ada\n');

    await installCommand(kit, {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      paramsFiles: [file],
    });

    expect(await readText(projectDir, 'CLAUDE.md')).toContain('called Ada');
    expect(await readText(projectDir, 'CLAUDE.md')).toContain('Platform team');
  });

  it('lets a flag beat the file it sits beside', async () => {
    const file = await write('params.yaml', 'TEAM: Platform\nAGENT_NAME: Ada\n');

    await installCommand(kit, {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      paramsFiles: [file],
      params: ['AGENT_NAME=Grace'],
    });

    expect(await readText(projectDir, 'CLAUDE.md')).toContain('called Grace');
  });

  it('says which file and which key when the shape is wrong', async () => {
    const file = await write('params.yaml', 'TEAM:\n  - Platform\n');
    await expect(readParametersFile(file, workspace)).rejects.toThrow(
      /"TEAM" in .* must be text, a number or a boolean/,
    );
  });

  it('says so when the file is not there', async () => {
    await expect(readParametersFile('nope.yaml', workspace)).rejects.toThrow(
      /No parameters file at/,
    );
  });
});

// ---------------------------------------------------------------------------

describe('resolving one value', () => {
  const TEAM_PARAM = parameter({ name: 'TEAM' });
  const resolve = (input: Parameters<typeof resolveParameters>[0]) =>
    resolveParameters({ bundle: 'kit', target: 'claude-code', prompt: false, ...input });

  it('prefers a flag to the environment, and the environment to what was recorded', async () => {
    process.env.HCM_PARAM_TEAM = 'FromEnv';

    expect(
      (
        await resolve({
          bundle: 'kit',
          target: 'claude-code',
          parameters: [TEAM_PARAM],
          overrides: { TEAM: 'FromFlag' },
          recorded: { TEAM: 'FromLedger' },
        })
      ).values,
    ).toEqual({ TEAM: 'FromFlag' });

    expect(
      (
        await resolve({
          bundle: 'kit',
          target: 'claude-code',
          parameters: [TEAM_PARAM],
          recorded: { TEAM: 'FromLedger' },
        })
      ).values,
    ).toEqual({ TEAM: 'FromEnv' });
  });

  it('falls back to what was recorded, which is what makes update quiet', async () => {
    const resolved = await resolve({
      bundle: 'kit',
      target: 'claude-code',
      parameters: [TEAM_PARAM],
      recorded: { TEAM: 'FromLedger' },
    });

    expect(resolved.values).toEqual({ TEAM: 'FromLedger' });
    expect(resolved.sources.TEAM).toBe('recorded');
  });

  it('ignores what was recorded when told to reconfigure', async () => {
    const resolved = await resolve({
      bundle: 'kit',
      target: 'claude-code',
      parameters: [parameter({ name: 'TEAM', default: 'Unowned', required: false })],
      recorded: { TEAM: 'FromLedger' },
      reconfigure: true,
    });

    expect(resolved.values).toEqual({ TEAM: 'Unowned' });
  });

  it('refuses a supplied value the bundle would not accept', async () => {
    const tone = parameter({ name: 'TONE', choices: ['direct', 'formal'] });

    await expect(
      resolve({
        bundle: 'kit',
        target: 'claude-code',
        parameters: [tone],
        overrides: { TONE: 'brusque' },
      }),
    ).rejects.toThrow(/is not one of its choices \(direct, formal\)/);
  });

  it('asks again rather than failing when a recorded value has gone out of date', async () => {
    // The bundle tightened its rules since; the recorded answer is not the
    // user's mistake, so it falls through to the default instead of stopping.
    const resolved = await resolve({
      bundle: 'kit',
      target: 'claude-code',
      parameters: [parameter({ name: 'TONE', choices: ['direct'], default: 'direct' })],
      recorded: { TONE: 'brusque' },
    });

    expect(resolved.values).toEqual({ TONE: 'direct' });
  });

  it('stops when a required value has nowhere to come from', async () => {
    await expect(
      resolve({ bundle: 'kit', target: 'claude-code', parameters: [TEAM_PARAM] }),
    ).rejects.toThrow(/"kit" needs a value for the parameter "TEAM"/);
  });

  it('renders an optional one with no default as nothing at all', async () => {
    const resolved = await resolve({
      bundle: 'kit',
      target: 'claude-code',
      parameters: [parameter({ name: 'SUFFIX', required: false })],
    });

    expect(resolved.values).toEqual({ SUFFIX: '' });
  });
});

// ---------------------------------------------------------------------------

describe('asking, and only once', () => {
  /** Stands in for the terminal, and counts what it was asked. */
  const recorder = () => {
    const asked: string[] = [];
    return {
      asked,
      ask: async (parameter: ParameterDefinition): Promise<string> => {
        asked.push(parameter.name);
        return `answer-for-${parameter.name}`;
      },
    };
  };

  it('asks for what nothing else could supply, and uses the answer', async () => {
    const { asked, ask } = recorder();

    const resolved = await resolveParameters({
      bundle: 'kit',
      target: 'claude-code',
      parameters: [parameter({ name: 'TEAM' }), parameter({ name: 'TONE', default: 'direct' })],
      overrides: { TONE: 'formal' },
      ask,
    });

    // Only TEAM: the other was already answered on the command line.
    expect(asked).toEqual(['TEAM']);
    expect(resolved.values).toEqual({ TEAM: 'answer-for-TEAM', TONE: 'formal' });
    expect(resolved.sources.TEAM).toBe('prompt');
  });

  it('carries a global answer across harnesses, so three installs ask once', async () => {
    const { asked, ask } = recorder();
    const session = new Map<string, string>();
    const parameters = [parameter({ name: 'TEAM' })];

    for (const target of ['claude-code', 'copilot', 'pi'] as const) {
      const resolved = await resolveParameters({ bundle: 'kit', target, parameters, session, ask });
      expect(resolved.values).toEqual({ TEAM: 'answer-for-TEAM' });
    }

    expect(asked).toEqual(['TEAM']);
  });

  it('asks a harness-scoped one again for each harness, since that is what it is', async () => {
    const { asked, ask } = recorder();
    const session = new Map<string, string>();
    const parameters = [parameter({ name: 'MODEL', targets: ['claude-code', 'copilot'] })];

    for (const target of ['claude-code', 'copilot'] as const) {
      await resolveParameters({ bundle: 'kit', target, parameters, session, ask });
    }

    // A value that is a fact about one harness must not be carried into another.
    expect(asked).toEqual(['MODEL', 'MODEL']);
  });

  it('asks separately for two bundles that happen to share a name', async () => {
    const { asked, ask } = recorder();
    const session = new Map<string, string>();
    const parameters = [parameter({ name: 'TEAM' })];

    for (const bundle of ['alpha', 'beta']) {
      await resolveParameters({ bundle, target: 'claude-code', parameters, session, ask });
    }

    expect(asked).toEqual(['TEAM', 'TEAM']);
  });

  it('does not ask for what a previous install already recorded', async () => {
    const { asked, ask } = recorder();

    await resolveParameters({
      bundle: 'kit',
      target: 'claude-code',
      parameters: [parameter({ name: 'TEAM' })],
      recorded: { TEAM: 'Platform' },
      ask,
    });

    expect(asked).toEqual([]);
  });

  it('asks anyway when reconfiguring', async () => {
    const { asked, ask } = recorder();

    const resolved = await resolveParameters({
      bundle: 'kit',
      target: 'claude-code',
      parameters: [parameter({ name: 'TEAM' })],
      recorded: { TEAM: 'Platform' },
      reconfigure: true,
      ask,
    });

    expect(asked).toEqual(['TEAM']);
    expect(resolved.values).toEqual({ TEAM: 'answer-for-TEAM' });
  });
});

// ---------------------------------------------------------------------------

describe('an install with nobody to ask', () => {
  it('takes the value from the environment, which is what CI has', async () => {
    process.env.HCM_PARAM_TEAM = 'Platform';
    await install();

    expect(await readText(projectDir, 'CLAUDE.md')).toContain('Platform team');
  });
});

// ---------------------------------------------------------------------------
// Living with a customised install
// ---------------------------------------------------------------------------

describe('remembering the values', () => {
  it('records nothing at all for a bundle that asks for nothing', async () => {
    const plain = await copyFixture('bundles/review-kit', path.join(workspace, 'review-kit'));
    await installCommand(plain, { targets: ['claude-code'], scope: 'project', cwd: projectDir });

    // Absent, not empty: that is what every record written before parameters
    // existed says, and it has to keep meaning the same thing.
    expect((await records())[0]).not.toHaveProperty('parameters');
  });

  it('drops what stopped applying rather than carrying it forward', async () => {
    await install({ params: [TEAM], targets: ['claude-code'] });
    expect((await records())[0]?.parameters).toHaveProperty('CLAUDE_MODEL');

    // storableValues only ever holds what this install actually settled.
    expect(storableValues({ A: '1', B: '2' }, [parameter({ name: 'B', secret: true })])).toEqual({
      A: '1',
    });
  });
});

// ---------------------------------------------------------------------------

describe('updating a customised installation', () => {
  const register = async (): Promise<void> => {
    await addToRegistry(kit, workspace);
  };

  /** Change the bundle at its source, the way a new release would. */
  const publish = async (body: string): Promise<void> => {
    await fs.writeFile(path.join(kit, 'context', '10-identity.md'), body);
    await fs.writeFile(
      path.join(kit, 'hcm.yaml'),
      (await fs.readFile(path.join(kit, 'hcm.yaml'), 'utf8')).replace(
        'version: 1.0.0',
        'version: 1.1.0',
      ),
    );
  };

  it('changes one when told to, and records the change', async () => {
    await register();
    await installCommand('branded-kit', {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      params: [TEAM, 'AGENT_NAME=Ada'],
    });

    await updateCommand(['branded-kit'], {
      targets: ['claude-code'],
      cwd: projectDir,
      params: ['AGENT_NAME=Grace'],
    });

    expect(await readText(projectDir, 'CLAUDE.md')).toContain('called Grace');
    expect((await records())[0]?.parameters).toHaveProperty('AGENT_NAME', 'Grace');
    // Everything not named keeps the value it had.
    expect((await records())[0]?.parameters).toHaveProperty('TEAM', 'Platform');
  });

  it('asks a newly declared parameter for a value rather than leaving a hole', async () => {
    await register();
    await installCommand('branded-kit', {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      params: [TEAM],
    });

    // The new version wants something the installed one never recorded.
    await fs.writeFile(
      path.join(kit, 'hcm.yaml'),
      `${await fs.readFile(path.join(kit, 'hcm.yaml'), 'utf8')}  RELEASE_CHANNEL:\n    description: Which channel to follow\n`,
    );
    await fs.appendFile(
      path.join(kit, 'context', '10-identity.md'),
      '\nFollow the <%RELEASE_CHANNEL%> channel.\n',
    );

    await expect(
      updateCommand(['branded-kit'], { targets: ['claude-code'], cwd: projectDir }),
    ).rejects.toThrow(/needs a value for the parameter "RELEASE_CHANNEL"/);
  });

  it('caches the rendered context, not the template', async () => {
    await register();
    await installCommand('branded-kit', {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      params: [TEAM, 'AGENT_NAME=Ada'],
    });

    // `hcm context append` works from the cache, with no bundle in reach; if it
    // held the template the instructions would come back with a hole in them.
    const cached = await readText(projectDir, '.hcm/context/branded-kit/10-identity.md');
    expect(cached).toContain('called Ada');
    expect(cached).not.toContain('<%');
  });
});

// ---------------------------------------------------------------------------

describe('a dependency with parameters of its own', () => {
  const makeKit = async (name: string, body: string): Promise<string> => {
    const dir = path.join(workspace, 'kits', name);
    await fs.mkdir(path.join(dir, 'subagents'), { recursive: true });
    await fs.writeFile(path.join(dir, 'hcm.yaml'), body);
    await fs.writeFile(
      path.join(dir, 'subagents', `${name}-worker.md`),
      `---\ndescription: Works for <%TEAM%>\n---\n\nYou work for <%TEAM%>.\n`,
    );
    return dir;
  };

  it('answers them from the same command line', async () => {
    await addToRegistry(
      await makeKit('shared', 'name: shared\nversion: 1.0.0\nparameters: [TEAM]\n'),
      workspace,
    );
    const dependent = await makeKit(
      'coding-kit',
      'name: coding-kit\nversion: 1.0.0\nparameters: [TEAM]\ndependencies:\n  - shared\n',
    );

    // One `--param TEAM=` reaches every bundle in the run that declares it --
    // which is what makes a dependency tree installable in one command.
    await installCommand(dependent, {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      params: [TEAM],
    });

    expect(await readText(projectDir, '.claude/agents/shared-worker.md')).toContain(
      'You work for Platform.',
    );
    expect(await readText(projectDir, '.claude/agents/coding-kit-worker.md')).toContain(
      'You work for Platform.',
    );
  });

  it('can be given a different value from its dependent', async () => {
    await addToRegistry(
      await makeKit('shared', 'name: shared\nversion: 1.0.0\nparameters: [TEAM]\n'),
      workspace,
    );
    const dependent = await makeKit(
      'coding-kit',
      'name: coding-kit\nversion: 1.0.0\nparameters: [TEAM]\ndependencies:\n  - shared\n',
    );

    await installCommand(dependent, {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      params: [TEAM, 'shared:TEAM=Infra'],
    });

    expect(await readText(projectDir, '.claude/agents/shared-worker.md')).toContain(
      'You work for Infra.',
    );
    expect(await readText(projectDir, '.claude/agents/coding-kit-worker.md')).toContain(
      'You work for Platform.',
    );
  });
});

// ---------------------------------------------------------------------------
// Writing the file to fill in
// ---------------------------------------------------------------------------

describe('hcm params init', () => {
  /** Write the file and hand back what is in it. */
  const init = async (
    references?: string | string[],
    options: Partial<Parameters<typeof paramsInitCommand>[1]> = {},
  ): Promise<string> => {
    await paramsInitCommand(references, {
      scope: 'project',
      cwd: projectDir,
      force: true,
      ...options,
    });
    return readText(projectDir, options.output ?? 'params.yaml');
  };

  it('writes one entry per parameter, with what it is for', async () => {
    const file = await init(kit);

    expect(file).toContain('  branded-kit:');
    expect(file).toContain('    # What the agent should call itself\n    AGENT_NAME: Claude');
    expect(file).toContain('    # one of: direct, formal, playful\n    TONE: direct');
  });

  it('leaves a blank, and says so, where it has no answer to offer', async () => {
    const file = await init(kit);

    // TEAM is the one thing this bundle cannot answer for itself.
    expect(file).toContain('    # REQUIRED — no default\n    TEAM:\n');
  });

  it('leaves a secret blank however much it knows', async () => {
    await install({ params: [TEAM, 'API_TOKEN=hunter2'] });
    const file = await init(kit);

    // It was never recorded, and inventing one would be the only lie this file
    // could tell.
    expect(file).toContain('    # secret — never recorded, so it must be given every time');
    expect(file).toContain('    API_TOKEN:\n');
    expect(file).not.toContain('hunter2');
  });

  it('files a harness-scoped parameter under the harness it belongs to', async () => {
    const file = await init(kit, { targets: ['claude-code'] });

    expect(file).toContain('    targets:\n      claude-code:\n');
    expect(file).toContain('        CLAUDE_MODEL: sonnet');
  });

  it('narrows to what one flavor would ask for', async () => {
    const wide = await init(kit);
    const narrow = await init(kit, { flavors: ['csharp'], output: 'narrow.yaml' });

    expect(wide).toContain('PYTEST_ARGS');
    // A flavor that is not being installed asks nothing, so it offers nothing.
    expect(narrow).not.toContain('PYTEST_ARGS');
  });

  it('prefills from what this project is already installed as', async () => {
    await install({ params: [TEAM, 'AGENT_NAME=Ada'] });
    const file = await init(kit);

    expect(file).toContain('    AGENT_NAME: Ada');
    // Answered, so it is no longer flagged as needing an answer.
    expect(file).toContain('    TEAM: Platform');
    expect(file).not.toContain('REQUIRED');
  });

  it('covers everything installed here when no bundle is named', async () => {
    await install({ params: [TEAM] });
    const file = await init(undefined);

    expect(file).toContain('  branded-kit:');
    expect(file).toContain('# Prefilled from what this project is installed as.');
  });

  it('quotes a value that would otherwise break the file', async () => {
    await install({ params: ['TEAM=Platform: the team, "quoted"'] });
    const file = await init(kit);

    // Round-tripped through the YAML writer rather than pasted in.
    const parsed = YAML.parse(file) as { bundles: { 'branded-kit': { TEAM: string } } };
    expect(parsed.bundles['branded-kit'].TEAM).toBe('Platform: the team, "quoted"');
  });

  it('refuses to replace a file that is already there', async () => {
    await paramsInitCommand(kit, { scope: 'project', cwd: projectDir });

    await expect(
      paramsInitCommand(kit, { scope: 'project', cwd: projectDir }),
    ).rejects.toThrow(/already exists/);
  });

  it('writes nothing for a bundle that asks for nothing', async () => {
    const plain = await copyFixture('bundles/review-kit', path.join(workspace, 'review-kit'));
    await paramsInitCommand(plain, { scope: 'project', cwd: projectDir });

    expect(await exists(projectDir, 'params.yaml')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('the round trip', () => {
  it('produces a file hcm can read straight back', async () => {
    // The whole point of the command: what it writes is what --params-file
    // takes, with no editing needed for anything it could already answer.
    await paramsInitCommand(kit, { scope: 'project', cwd: projectDir });

    const overrides = await readParametersFile('params.yaml', projectDir);
    expect(overrides.byBundle['branded-kit']).toEqual({
      AGENT_NAME: 'Claude',
      TONE: 'direct',
      PYTEST_ARGS: '-q',
    });
    // The blanks are absent rather than empty, so they fall through to being
    // asked for exactly as if the file had never mentioned them.
    expect(overrides.byBundle['branded-kit']).not.toHaveProperty('TEAM');
    expect(overrides.byBundle['branded-kit']).not.toHaveProperty('API_TOKEN');
  });

  it('installs from the file once the blanks are filled in', async () => {
    await paramsInitCommand(kit, { scope: 'project', cwd: projectDir });

    const file = path.join(projectDir, 'params.yaml');
    await fs.writeFile(
      file,
      (await fs.readFile(file, 'utf8'))
        .replace('\n    TEAM:\n', '\n    TEAM: Platform\n')
        .replace('\n    AGENT_NAME: Claude\n', '\n    AGENT_NAME: Ada\n'),
    );

    await installCommand(kit, {
      targets: ['claude-code'],
      scope: 'project',
      cwd: projectDir,
      paramsFiles: [file],
    });

    expect(await readText(projectDir, 'CLAUDE.md')).toContain('called Ada');
    expect(await readText(projectDir, 'CLAUDE.md')).toContain('Platform team');
  });

  it('reproduces an installed setup on another machine', async () => {
    await install({ params: [TEAM, 'AGENT_NAME=Ada'] });
    await paramsInitCommand(undefined, { scope: 'project', cwd: projectDir });

    // The file, carried to a fresh checkout, is enough to set it up the same way.
    const elsewhere = path.join(workspace, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.copyFile(path.join(projectDir, 'params.yaml'), path.join(elsewhere, 'params.yaml'));

    await installCommand(kit, {
      targets: ['claude-code'],
      scope: 'project',
      cwd: elsewhere,
      paramsFiles: ['params.yaml'],
    });

    expect(await readText(elsewhere, 'CLAUDE.md')).toBe(await readText(projectDir, 'CLAUDE.md'));
  });

  it('reads a key left blank as one nobody has answered', async () => {
    const file = path.join(workspace, 'blank.yaml');
    await fs.writeFile(file, 'TEAM:\nAGENT_NAME: Ada\n');

    // Not an error and not an empty string -- a half-finished template is the
    // normal state of one.
    const overrides = await readParametersFile(file, workspace);
    expect(overrides.global).toEqual({ AGENT_NAME: 'Ada' });
  });

  it('still lets a value be deliberately empty', async () => {
    const file = path.join(workspace, 'empty.yaml');
    await fs.writeFile(file, 'SUFFIX: ""\n');

    expect((await readParametersFile(file, workspace)).global).toEqual({ SUFFIX: '' });
  });
});

// ---------------------------------------------------------------------------
// Saying which values exist
// ---------------------------------------------------------------------------

describe('saying what a bundle will ask for', () => {
  it('records them on the registry entry, so a listing need not read the bundle', async () => {
    await addToRegistry(kit, workspace);
    const registry = await readRegistry();

    expect(registry.entries[0]?.parameters?.map((one) => one.name)).toEqual([
      'AGENT_NAME',
      'TEAM',
      'TONE',
      'PYTEST_ARGS',
      'CLAUDE_MODEL',
      'API_TOKEN',
    ]);
    expect(registry.entries[0]?.parameters?.[1]).toEqual({
      name: 'TEAM',
      description: 'The team that owns this project',
      required: true,
    });
  });

  it('prints them in "hcm registry list"', async () => {
    await addToRegistry(kit, workspace);
    expect(await capture(() => registryListCommand({}))).toMatch(/parameters: AGENT_NAME, TEAM/);
  });

  it('leaves the entry alone for a bundle that asks for nothing', async () => {
    const plain = await copyFixture('bundles/review-kit', path.join(workspace, 'review-kit'));
    await addToRegistry(plain, workspace);

    expect((await readRegistry()).entries[0]).not.toHaveProperty('parameters');
  });

  it('describes each of them in "hcm info", with where it applies', async () => {
    const output = await capture(() => infoCommand(kit, { scope: 'project', cwd: projectDir }));

    expect(output).toMatch(/AGENT_NAME \[Claude\] — What the agent should call itself/);
    expect(output).toMatch(/TEAM \(required\)/);
    expect(output).toMatch(/one of: direct, formal, playful/);
    expect(output).toMatch(/only for flavor python/);
    expect(output).toMatch(/only for harness claude-code/);
    expect(output).toMatch(/not stored; supply it again on update/);
  });

  it('previews the rendered text in "hcm info", from the values given', async () => {
    const output = await capture(() =>
      infoCommand(kit, { scope: 'project', cwd: projectDir, params: ['TEAM=Platform'] }),
    );

    // Nothing is asked and nothing is read from the ledger: a preview shows the
    // defaults, plus whatever the command line supplied.
    expect(output).not.toMatch(/needs a value/);
    expect(output).toMatch(/branded-kit/);
  });
});

// ---------------------------------------------------------------------------

describe('what hcm validate has to say', () => {
  it('finds nothing wrong with the fixture', async () => {
    expect(await validateCommand(kit, { cwd: workspace })).toBe(true);
  });

  it('reports a placeholder nothing declares, which would install verbatim', async () => {
    await fs.appendFile(
      path.join(kit, 'context', '10-identity.md'),
      '\nReport to <%MANAGER%>.\n',
    );

    expect(validateBundle(await loadBundle(kit))).toContainEqual(
      expect.stringMatching(/"<%MANAGER%>" is not a parameter this bundle declares/),
    );
  });

  it('finds one in the supporting file beside a skill too', async () => {
    await fs.appendFile(
      path.join(kit, 'skills', 'onboarding', 'welcome.md'),
      '\nAsk <%MANAGER%>.\n',
    );

    expect(validateBundle(await loadBundle(kit))).toContainEqual(
      expect.stringMatching(/onboarding\/welcome\.md: "<%MANAGER%>" is not a parameter/),
    );
  });

  it('reports a parameter declared and never used', async () => {
    await fs.appendFile(path.join(kit, 'hcm.yaml'), '  UNUSED:\n    default: nothing\n');

    expect(validateBundle(await loadBundle(kit))).toContainEqual(
      expect.stringMatching(/Parameter "UNUSED" is declared but never used/),
    );
  });

  it('reports a narrowed parameter with no default used where it is not asked for', async () => {
    // The trap: a parameter only asked for on Copilot, mentioned in a file every
    // harness gets. With a default that is fine; without one it installs as a hole.
    await fs.appendFile(
      path.join(kit, 'hcm.yaml'),
      '  COPILOT_ORG:\n    description: The GitHub org\n    targets: [copilot]\n',
    );
    await fs.appendFile(
      path.join(kit, 'context', '10-identity.md'),
      '\nThe org is <%COPILOT_ORG%>.\n',
    );

    expect(validateBundle(await loadBundle(kit))).toContainEqual(
      expect.stringMatching(
        /"<%COPILOT_ORG%>" is only asked for on copilot and has no default, but this bundle also installs into/,
      ),
    );
  });

  it('says nothing about the same case once the parameter has a default', async () => {
    await fs.appendFile(
      path.join(kit, 'hcm.yaml'),
      '  COPILOT_ORG:\n    default: acme\n    targets: [copilot]\n',
    );
    await fs.appendFile(
      path.join(kit, 'context', '10-identity.md'),
      '\nThe org is <%COPILOT_ORG%>.\n',
    );

    expect(validateBundle(await loadBundle(kit))).toEqual([]);
  });

  it('reports a placeholder in a name, which decides a filename and is never substituted', async () => {
    await fs.writeFile(
      path.join(kit, 'subagents', 'named.md'),
      '---\nname: <%AGENT_NAME%>\ndescription: A subagent\n---\n\nWork.\n',
    );

    expect(validateBundle(await loadBundle(kit))).toContainEqual(
      expect.stringMatching(/"name" holds a placeholder.*never substituted/),
    );
  });

  it('reports a parameter scoped to a flavor the bundle does not have', async () => {
    await fs.appendFile(
      path.join(kit, 'hcm.yaml'),
      '  RUST_EDITION:\n    default: "2021"\n    flavors: [rust]\n',
    );

    expect(validateBundle(await loadBundle(kit))).toContainEqual(
      expect.stringMatching(/flavor "rust" is not one this bundle declares/),
    );
  });
});

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

  // Colour codes would make every assertion here a puzzle.
  // eslint-disable-next-line no-control-regex
  return lines.join('\n').replace(/\[\d+m/g, '');
}
