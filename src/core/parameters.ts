/**
 * Parameters: the values a bundle is customised with as it is installed.
 *
 * A bundle is written once and installed into many projects, and some of what
 * it says is different in each of them -- the agent's name, the team's ticket
 * prefix, the model to prefer. Writing those into the bundle means one bundle
 * per project; leaving them out means the instructions are vague. A *parameter*
 * is the third option: the bundle names the hole, and the install fills it.
 *
 *     # hcm.yaml
 *     parameters:
 *       AGENT_NAME:
 *         description: What the agent should call itself
 *         default: Claude
 *
 *     # context/10-identity.md
 *     You are a coding agent called <%AGENT_NAME%>.
 *
 * Three rules, and the rest follows from them:
 *
 *   1. A placeholder is `<%NAME%>`, and it is replaced wherever the text of an
 *      installed item can hold one -- markdown bodies and their frontmatter,
 *      context blocks, the string values inside MCP and settings fragments, and
 *      any skill or asset file that is text. Never in a *path*: where a file
 *      lands is a fact about the bundle's layout, not about this install.
 *   2. Substitution happens on the *plan*, after the file references have been
 *      remapped and before anything is compared against disk. So the hashes,
 *      the receipts, `--dry-run`, `hcm info` and the cached context sections
 *      all describe the text that will really be there.
 *   3. The values are recorded with the installation. `hcm update` renders the
 *      new version with the same ones without being told again -- an update
 *      that silently renamed the agent would be worse than no update at all.
 *
 * A parameter can also say *where* it applies, which is what makes one bundle
 * able to hold questions that are not all worth asking every time:
 *
 *     parameters:
 *       AGENT_NAME:                  # global: asked for every install
 *         default: Claude
 *       PYTEST_ARGS:                 # only when the python flavor is installed
 *         flavors: [python]
 *         default: -q
 *       COPILOT_ORG:                 # only when installing into Copilot
 *         targets: [copilot]
 *
 * Nothing here removes anything, and nothing here is a template *language*.
 * There are no conditionals, no loops and no expressions: a bundle stays
 * readable as the thing it installs, and the diff between what you wrote and
 * what landed is a handful of names.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { HcmError } from './errors.js';
import { fs, pathExists } from './fsx.js';
import { color, log } from './logger.js';
import { isInteractive, select, text } from './prompt.js';
import { resolveTargetId, TARGET_IDS } from '../targets/index.js';
import type {
  BundleManifest,
  BundleResource,
  LoadedBundle,
  ParameterDefinition,
  ParameterSummary,
  ParameterValues,
  PlanAction,
  PlanTemplating,
  TargetId,
} from './types.js';

/**
 * What a parameter may be called. Deliberately the shape of an environment
 * variable: the name has to survive being typed on a command line, put in
 * `HCM_PARAM_<NAME>`, and read inside `<% %>` without ambiguity.
 */
const PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const DECLARATION_HINT =
  'Write "parameters: [AGENT_NAME]", or a mapping of name to description, or a mapping of ' +
  'name to {description, default, required, choices, pattern, secret, flavors, targets}.';

// ---------------------------------------------------------------------------
// Reading the manifest
// ---------------------------------------------------------------------------

/**
 * Accept every way of writing `parameters:` and return the one shape the rest
 * of hcm works with:
 *
 *   parameters: [AGENT_NAME, TEAM]          # names alone, each one required
 *
 *   parameters:
 *     AGENT_NAME: What the agent calls itself      # name with a description
 *
 *   parameters:
 *     AGENT_NAME:                                  # name with the full shape
 *       description: What the agent calls itself
 *       default: Claude
 *       choices: [Claude, Codey]
 *       flavors: [python]
 *       targets: [claude-code]
 */
export function normalizeParameters(
  manifest: BundleManifest,
  where = manifest.name,
): ParameterDefinition[] {
  const declared = manifest.parameters;
  if (declared === undefined) return [];

  let entries: [string, unknown][];

  if (Array.isArray(declared)) {
    for (const name of declared) {
      if (typeof name !== 'string') {
        throw new HcmError(
          `Malformed parameter in ${where}: ${JSON.stringify(name)}`,
          DECLARATION_HINT,
        );
      }
    }
    entries = declared.map((name) => [name as string, undefined]);
  } else if (declared && typeof declared === 'object') {
    entries = Object.entries(declared);
  } else {
    throw new HcmError(
      `"parameters" in ${where} must be a list of names or a mapping`,
      DECLARATION_HINT,
    );
  }

  const seen = new Set<string>();
  const parameters: ParameterDefinition[] = [];

  for (const [rawName, value] of entries) {
    const name = rawName.trim();
    if (!PARAMETER_NAME_PATTERN.test(name)) {
      throw new HcmError(
        `"${name}" is not a usable parameter name (in ${where})`,
        'Start with a letter or underscore, then letters, digits and underscores -- the ' +
          'name goes inside <% %> and into HCM_PARAM_<NAME>.',
      );
    }
    // Case-insensitively unique, because `HCM_PARAM_<NAME>` upper-cases the
    // name and two parameters differing only in case would share one variable.
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new HcmError(`"${name}" is listed twice in ${where}'s parameters`);
    }
    seen.add(key);

    parameters.push(readParameterBody(name, value, where));
  }

  return parameters;
}

/** The right-hand side of one parameter entry: nothing, a description, or all of it. */
function readParameterBody(name: string, value: unknown, where: string): ParameterDefinition {
  const bare = (extra: Partial<ParameterDefinition> = {}): ParameterDefinition => ({
    name,
    required: true,
    flavors: [],
    targets: [],
    ...extra,
  });

  if (value === undefined || value === null) return bare();

  if (typeof value === 'string') {
    const description = value.trim();
    return bare(description ? { description } : {});
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HcmError(`Malformed parameter "${name}" in ${where}`, DECLARATION_HINT);
  }

  const shape = value as Record<string, unknown>;

  if (shape.description !== undefined && typeof shape.description !== 'string') {
    throw new HcmError(`"description" for parameter "${name}" in ${where} must be text`);
  }
  const description = typeof shape.description === 'string' ? shape.description.trim() : undefined;

  const fallback = readDefault(shape.default, name, where);
  const choices = readChoices(shape.choices, name, where);
  const pattern = readPattern(shape.pattern, name, where);

  if (shape.required !== undefined && typeof shape.required !== 'boolean') {
    throw new HcmError(`"required" for parameter "${name}" in ${where} must be true or false`);
  }
  if (shape.secret !== undefined && typeof shape.secret !== 'boolean') {
    throw new HcmError(`"secret" for parameter "${name}" in ${where} must be true or false`);
  }

  // A parameter with a default can always be satisfied, so requiredness only
  // decides what happens when there is nothing to fall back on.
  const required = typeof shape.required === 'boolean' ? shape.required : fallback === undefined;

  if (fallback !== undefined && choices && !choices.includes(fallback)) {
    throw new HcmError(
      `The default for parameter "${name}" in ${where} is not one of its choices`,
      `default: ${JSON.stringify(fallback)}; choices: ${choices.join(', ')}`,
    );
  }
  if (fallback !== undefined && pattern && !new RegExp(pattern).test(fallback)) {
    throw new HcmError(
      `The default for parameter "${name}" in ${where} does not match its own pattern`,
      `default: ${JSON.stringify(fallback)}; pattern: ${pattern}`,
    );
  }

  return {
    name,
    ...(description ? { description } : {}),
    ...(fallback !== undefined ? { default: fallback } : {}),
    required,
    ...(choices ? { choices } : {}),
    ...(pattern ? { pattern } : {}),
    ...(shape.secret === true ? { secret: true } : {}),
    flavors: readNames(shape.flavors ?? shape.flavor, 'flavors', name, where),
    targets: readTargets(shape.targets ?? shape.target, name, where),
  };
}

/**
 * A default written in YAML need not be a string: `default: 3` and
 * `default: true` are the obvious way to write a number and a flag, and both
 * become text on the way into a file anyway.
 */
function readDefault(value: unknown, name: string, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new HcmError(
    `"default" for parameter "${name}" in ${where} must be text, a number or a boolean`,
  );
}

function readChoices(value: unknown, name: string, where: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new HcmError(`"choices" for parameter "${name}" in ${where} must be a non-empty list`);
  }

  const choices = value.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (typeof entry === 'number' || typeof entry === 'boolean') return String(entry);
    throw new HcmError(
      `"choices" for parameter "${name}" in ${where} must hold text, numbers or booleans`,
    );
  });

  if (new Set(choices).size !== choices.length) {
    throw new HcmError(`"choices" for parameter "${name}" in ${where} lists the same value twice`);
  }
  return choices;
}

function readPattern(value: unknown, name: string, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new HcmError(`"pattern" for parameter "${name}" in ${where} must be a regular expression`);
  }
  try {
    new RegExp(value);
  } catch (error) {
    throw new HcmError(
      `"pattern" for parameter "${name}" in ${where} is not a valid regular expression`,
      (error as Error).message,
    );
  }
  return value;
}

function readNames(value: unknown, field: string, name: string, where: string): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const names: string[] = [];

  for (const entry of list) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new HcmError(
        `"${field}" for parameter "${name}" in ${where} must be a name or a list of them`,
        `Got ${JSON.stringify(entry)}.`,
      );
    }
    names.push(entry.trim());
  }
  return names;
}

/** Harness names are validated here rather than at install time, and against the real list. */
function readTargets(value: unknown, name: string, where: string): TargetId[] {
  const names = readNames(value, 'targets', name, where);
  return names.map((entry) => {
    try {
      return resolveTargetId(entry);
    } catch {
      throw new HcmError(
        `"${entry}" is not a harness hcm knows (parameter "${name}" in ${where})`,
        `Supported: ${TARGET_IDS.join(', ')}`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// The placeholder
// ---------------------------------------------------------------------------

/**
 * `<%NAME%>`, with optional spaces inside. A doubled `%` escapes it, so
 * `<%%NAME%>` renders as the literal `<%NAME%>` -- which is how a bundle
 * documents this very feature without its own examples being filled in.
 *
 * Anything that is not exactly a name between the delimiters is left alone, so
 * a file carrying some other template language's `<% if x %>` survives intact.
 */
const PLACEHOLDER = /<%(%?)\s*([A-Za-z_][A-Za-z0-9_]*)\s*%>/g;

export interface RenderResult {
  text: string;
  /** Name -> how many times it was filled in. */
  substituted: Map<string, number>;
  /** Name -> how many times it was left standing, nothing having a value for it. */
  unresolved: Map<string, number>;
}

/** Fill in every placeholder that has a value; leave the rest exactly as they are. */
export function renderTemplate(input: string, values: ParameterValues): RenderResult {
  const substituted = new Map<string, number>();
  const unresolved = new Map<string, number>();

  const text = input.replace(PLACEHOLDER, (match, escape: string, name: string) => {
    if (escape === '%') return `<%${name}%>`;

    const value = values[name];
    if (value === undefined) {
      unresolved.set(name, (unresolved.get(name) ?? 0) + 1);
      return match;
    }

    substituted.set(name, (substituted.get(name) ?? 0) + 1);
    return value;
  });

  return { text, substituted, unresolved };
}

/** Every parameter name a piece of text refers to, escaped ones excluded. */
export function placeholderNames(input: string): string[] {
  const found = new Set<string>();
  for (const match of input.matchAll(PLACEHOLDER)) {
    if (match[1] === '%') continue;
    found.add(match[2] as string);
  }
  return [...found];
}

/** True when text anywhere in here refers to a parameter. */
export function hasPlaceholder(input: string): boolean {
  return placeholderNames(input).length > 0;
}

/**
 * A buffer read back as text, or undefined when it is not text at all.
 *
 * Skills and assets are copied byte-for-byte, and most of them are markdown or
 * a shell script that should be templated like anything else. An image must not
 * be: decoding it, substituting nothing and re-encoding would still be a
 * needless round trip, and a NUL byte is the cheapest reliable evidence.
 */
export function decodeText(buffer: Buffer): string | undefined {
  if (buffer.includes(0)) return undefined;
  const text = buffer.toString('utf8');
  // A lossy decode leaves U+FFFD behind; re-encoding then would corrupt the file.
  return Buffer.from(text, 'utf8').equals(buffer) ? text : undefined;
}

// ---------------------------------------------------------------------------
// Applying it to a plan
// ---------------------------------------------------------------------------

export interface TemplatingReport {
  actions: PlanAction[];
  substituted: PlanTemplating['substituted'];
  unresolved: PlanTemplating['unresolved'];
}

/**
 * Render every action's payload with `values`.
 *
 * `only` limits what is rendered without limiting what is reported -- which is
 * what a resolved conflict needs, having regenerated one resource's actions
 * under a new name after the rest were already done.
 *
 * `declared` is used only to explain a placeholder that was left standing: one
 * naming a parameter the bundle never declared is a typo, one naming a
 * parameter that does not apply here is a bundle installed more narrowly than
 * it was written. Both leave the text alone, because a placeholder the user is
 * told about beats a plausible value that is wrong.
 */
export function applyParameters(
  actions: PlanAction[],
  values: ParameterValues,
  declared: ParameterDefinition[] = [],
  only?: PlanAction[],
): TemplatingReport {
  const rendering = new Set(only ?? actions);
  const substituted: PlanTemplating['substituted'] = [];
  const unresolved: PlanTemplating['unresolved'] = [];
  const known = new Set(declared.map((parameter) => parameter.name));

  const collect = (at: string, result: { substituted: Map<string, number>; unresolved: Map<string, number> }): void => {
    for (const [name, count] of result.substituted) substituted.push({ path: at, name, count });
    for (const [name] of result.unresolved) {
      unresolved.push({
        path: at,
        name,
        reason: known.has(name)
          ? 'is a parameter of this bundle, but does not apply to this harness or flavor'
          : 'is not a parameter this bundle declares',
      });
    }
  };

  const rendered = actions.map((action) => {
    if (!rendering.has(action)) return action;

    const { payload } = action;

    if (payload.kind === 'file') {
      if (typeof payload.contents === 'string') {
        const result = renderTemplate(payload.contents, values);
        collect(action.path, result);
        if (result.text === payload.contents) return action;
        return { ...action, payload: { ...payload, contents: result.text } };
      }

      const decoded = decodeText(payload.contents);
      if (decoded === undefined) return action;
      const result = renderTemplate(decoded, values);
      collect(action.path, result);
      if (result.text === decoded) return action;
      return { ...action, payload: { ...payload, contents: Buffer.from(result.text, 'utf8') } };
    }

    if (payload.kind === 'block') {
      const result = renderTemplate(payload.body, values);
      collect(action.path, result);
      if (result.text === payload.body) return action;
      return { ...action, payload: { ...payload, body: result.text } };
    }

    if (payload.kind === 'json-value') {
      const result = renderJson(payload.value, values);
      collect(action.path, result);
      if (!result.changed) return action;
      return { ...action, payload: { ...payload, value: result.value } };
    }

    const result = renderJson(payload.items, values);
    collect(action.path, result);
    if (!result.changed) return action;
    return { ...action, payload: { ...payload, items: result.value as unknown[] } };
  });

  return { actions: rendered, substituted, unresolved };
}

/**
 * Render the strings inside a JSON payload -- an MCP server's arguments, a
 * settings value, an entry in an allowlist.
 *
 * Values only. A templated *key* would move the JSON pointer the receipt is
 * written against, so the item hcm claims and the item it wrote would be
 * addressed differently; `hcm validate` reports one rather than guessing.
 */
function renderJson(
  value: unknown,
  values: ParameterValues,
): { value: unknown; changed: boolean; substituted: Map<string, number>; unresolved: Map<string, number> } {
  const substituted = new Map<string, number>();
  const unresolved = new Map<string, number>();
  let changed = false;

  const add = (into: Map<string, number>, from: Map<string, number>): void => {
    for (const [name, count] of from) into.set(name, (into.get(name) ?? 0) + count);
  };

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const result = renderTemplate(node, values);
      add(substituted, result.substituted);
      add(unresolved, result.unresolved);
      if (result.text === node) return node;
      changed = true;
      return result.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]));
    }
    return node;
  };

  return { value: walk(value), changed, substituted, unresolved };
}

// ---------------------------------------------------------------------------
// Where a parameter applies
// ---------------------------------------------------------------------------

export interface ParameterScope {
  target: TargetId;
  /** The flavors being installed. Empty is the whole bundle, so everything applies. */
  flavors: string[];
}

/**
 * Does this parameter belong to the install being planned?
 *
 * A parameter that names no flavors and no targets is *global*: it applies
 * always, which is what makes the simplest declaration also the most useful
 * one. Naming either narrows it, and the flavor rule is the same one resources
 * follow -- asking for no flavor asks for all of them.
 *
 * Applicability decides what is *asked for*, not what is substituted. A
 * parameter narrowed to Copilot still has a default, and a file installed into
 * Claude Code that mentions it gets that default rather than a placeholder --
 * see `withDefaults`. Only a narrowed parameter with no default at all leaves a
 * hole elsewhere, and `hcm validate` reports exactly that case.
 */
export function appliesTo(parameter: ParameterDefinition, scope: ParameterScope): boolean {
  if (parameter.targets.length > 0 && !parameter.targets.includes(scope.target)) return false;

  if (parameter.flavors.length > 0 && scope.flavors.length > 0) {
    const wanted = new Set(scope.flavors.map((name) => name.toLowerCase()));
    return parameter.flavors.some((name) => wanted.has(name.toLowerCase()));
  }

  return true;
}

/** The parameters an install into one harness, narrowed to some flavors, has to answer. */
export function applicableParameters(
  parameters: ParameterDefinition[],
  scope: ParameterScope,
): ParameterDefinition[] {
  return parameters.filter((parameter) => appliesTo(parameter, scope));
}

/**
 * The resolved values, plus a default for every parameter that was not asked
 * about because it does not apply here.
 *
 * This is what stops a narrowing from putting a hole in a file. A bundle whose
 * `MODEL` is asked for on Claude Code and defaulted everywhere else is an
 * ordinary thing to want; without this, "everywhere else" would read
 * `<%MODEL%>` in the installed text. Nothing here is recorded -- a default is
 * always re-derivable from the manifest, and writing it down would freeze it
 * against the next version.
 */
export function withDefaults(
  values: ParameterValues,
  parameters: ParameterDefinition[],
): ParameterValues {
  const filled = { ...values };
  for (const parameter of parameters) {
    if (filled[parameter.name] === undefined && parameter.default !== undefined) {
      filled[parameter.name] = parameter.default;
    }
  }
  return filled;
}

// ---------------------------------------------------------------------------
// Where the values come from
// ---------------------------------------------------------------------------

/**
 * Values supplied from outside the terminal: `--param`, `--params-file`.
 *
 * Scoped three ways, because one command can install several bundles into
 * several harnesses and `AGENT_NAME` may well mean something different in each.
 * The narrowest scope that mentions a name wins.
 */
export interface ParameterOverrides {
  /** Applies to any bundle that declares the name. */
  global: ParameterValues;
  /** Bundle name -> values. */
  byBundle: Record<string, ParameterValues>;
  /** `${bundle}@${target}` -> values. */
  byBundleTarget: Record<string, ParameterValues>;
}

export function emptyOverrides(): ParameterOverrides {
  return { global: {}, byBundle: {}, byBundleTarget: {} };
}

export function mergeOverrides(...list: (ParameterOverrides | undefined)[]): ParameterOverrides {
  const merged = emptyOverrides();

  for (const overrides of list) {
    if (!overrides) continue;
    Object.assign(merged.global, overrides.global);
    for (const [bundle, values] of Object.entries(overrides.byBundle)) {
      merged.byBundle[bundle] = { ...merged.byBundle[bundle], ...values };
    }
    for (const [key, values] of Object.entries(overrides.byBundleTarget)) {
      merged.byBundleTarget[key] = { ...merged.byBundleTarget[key], ...values };
    }
  }

  return merged;
}

/** The values that apply to one bundle in one harness, narrowest last. */
export function overridesFor(
  overrides: ParameterOverrides,
  bundle: string,
  target: TargetId,
): ParameterValues {
  return {
    ...overrides.global,
    ...overrides.byBundle[bundle],
    ...overrides.byBundleTarget[`${bundle}@${target}`],
  };
}

/**
 * Read `--param` assignments.
 *
 *   --param AGENT_NAME=Ada                     every bundle that asks for one
 *   --param review-kit:AGENT_NAME=Ada          that bundle only
 *   --param review-kit@copilot:AGENT_NAME=Ada  that bundle, in that harness only
 */
export function parseAssignments(entries: readonly string[] | undefined): ParameterOverrides {
  const overrides = emptyOverrides();
  if (!entries?.length) return overrides;

  for (const entry of entries) {
    const equals = entry.indexOf('=');
    if (equals <= 0) {
      throw new HcmError(
        `"${entry}" is not a parameter assignment`,
        'Write NAME=value, or bundle:NAME=value, or bundle@harness:NAME=value.',
      );
    }

    const key = entry.slice(0, equals).trim();
    const value = entry.slice(equals + 1);
    const colon = key.lastIndexOf(':');
    const name = (colon === -1 ? key : key.slice(colon + 1)).trim();

    if (!PARAMETER_NAME_PATTERN.test(name)) {
      throw new HcmError(
        `"${name}" is not a usable parameter name (in --param ${entry})`,
        'Start with a letter or underscore, then letters, digits and underscores.',
      );
    }

    if (colon === -1) {
      overrides.global[name] = value;
      continue;
    }

    const where = key.slice(0, colon).trim();
    if (!where) {
      throw new HcmError(
        `"${entry}" names no bundle before the ":"`,
        'Write NAME=value for every bundle, or bundle:NAME=value for one of them.',
      );
    }

    const at = where.indexOf('@');
    if (at === -1) {
      overrides.byBundle[where] = { ...overrides.byBundle[where], [name]: value };
      continue;
    }

    const bundle = where.slice(0, at).trim();
    const target = resolveHarness(where.slice(at + 1).trim(), entry);
    const scoped = `${bundle}@${target}`;
    overrides.byBundleTarget[scoped] = { ...overrides.byBundleTarget[scoped], [name]: value };
  }

  return overrides;
}

function resolveHarness(value: string, where: string): TargetId {
  try {
    return resolveTargetId(value);
  } catch {
    throw new HcmError(
      `"${value}" is not a harness hcm knows (in ${where})`,
      `Supported: ${TARGET_IDS.join(', ')}`,
    );
  }
}

/**
 * Read a parameters file -- YAML or JSON, the same two the manifest may be.
 *
 *     AGENT_NAME: Ada             # every bundle that asks for one
 *
 *     bundles:
 *       review-kit:
 *         REVIEWER: Ada           # that bundle
 *         targets:
 *           copilot:
 *             AGENT_NAME: Codey   # that bundle, in Copilot
 *
 * This is the answer to "how do I install the same thing on twenty machines":
 * commit the file, pass `--params-file`, and no question is ever asked.
 */
export async function readParametersFile(file: string, cwd: string): Promise<ParameterOverrides> {
  const absolute = path.resolve(cwd, file);
  if (!(await pathExists(absolute))) {
    throw new HcmError(`No parameters file at ${absolute}`);
  }

  const raw = await fs.readFile(absolute, 'utf8');
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    throw new HcmError(`Failed to parse ${file}: ${(error as Error).message}`);
  }

  if (parsed === null || parsed === undefined) return emptyOverrides();
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HcmError(
      `${file} must be a mapping of parameter names to values`,
      'Optionally with a "bundles:" section for values that apply to one bundle only.',
    );
  }

  const overrides = emptyOverrides();
  const root = parsed as Record<string, unknown>;

  for (const [key, value] of Object.entries(root)) {
    if (key === 'bundles') continue;
    if (isBlank(value)) continue;
    overrides.global[key] = readFileValue(value, key, file);
  }

  const bundles = root.bundles;
  if (bundles === undefined || bundles === null) return overrides;
  if (typeof bundles !== 'object' || Array.isArray(bundles)) {
    throw new HcmError(`"bundles" in ${file} must be a mapping of bundle name to values`);
  }

  for (const [bundle, section] of Object.entries(bundles as Record<string, unknown>)) {
    if (section === null || section === undefined) continue;
    if (typeof section !== 'object' || Array.isArray(section)) {
      throw new HcmError(`"bundles.${bundle}" in ${file} must be a mapping of names to values`);
    }

    for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
      if (key === 'targets') continue;
      if (isBlank(value)) continue;
      overrides.byBundle[bundle] = {
        ...overrides.byBundle[bundle],
        [key]: readFileValue(value, `bundles.${bundle}.${key}`, file),
      };
    }

    const targets = (section as Record<string, unknown>).targets;
    if (targets === undefined || targets === null) continue;
    if (typeof targets !== 'object' || Array.isArray(targets)) {
      throw new HcmError(`"bundles.${bundle}.targets" in ${file} must be a mapping`);
    }

    for (const [name, values] of Object.entries(targets as Record<string, unknown>)) {
      const target = resolveHarness(name, `${file} (bundles.${bundle}.targets)`);
      if (values === null || values === undefined) continue;
      if (typeof values !== 'object' || Array.isArray(values)) {
        throw new HcmError(
          `"bundles.${bundle}.targets.${name}" in ${file} must be a mapping of names to values`,
        );
      }

      const key = `${bundle}@${target}`;
      for (const [parameter, value] of Object.entries(values as Record<string, unknown>)) {
        if (isBlank(value)) continue;
        overrides.byBundleTarget[key] = {
          ...overrides.byBundleTarget[key],
          [parameter]: readFileValue(value, `bundles.${bundle}.targets.${name}.${parameter}`, file),
        };
      }
    }
  }

  return overrides;
}

/**
 * A key that is present but says nothing.
 *
 * `hcm params init` writes a template with a blank beside every value it cannot
 * fill in for you, so a half-completed file is the normal state of one. A blank
 * therefore means "I have not said", not "the value is nothing" -- hcm falls
 * back to the default, or asks, exactly as if the key were absent. Saying the
 * value really is empty takes an explicit `KEY: ""`.
 */
function isBlank(value: unknown): boolean {
  return value === null || value === undefined;
}

function readFileValue(value: unknown, at: string, file: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new HcmError(
    `"${at}" in ${file} must be text, a number or a boolean`,
    'Parameter values are substituted into files as they are written.',
  );
}

/** The environment variable one parameter answers to, for a run with no terminal. */
export function parameterEnvName(name: string): string {
  return `HCM_PARAM_${name.toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

export type ParameterSource =
  | 'flag'
  | 'environment'
  | 'session'
  | 'recorded'
  | 'prompt'
  | 'default'
  | 'empty';

export interface ResolveParametersInput {
  bundle: string;
  target: TargetId;
  /** Already narrowed with `applicableParameters`. */
  parameters: ParameterDefinition[];
  /** From `--param` and `--params-file`, already narrowed to this bundle and harness. */
  overrides?: ParameterValues;
  /** What the installation already here was rendered with. */
  recorded?: ParameterValues;
  /**
   * Answers given earlier in this run, so installing into three harnesses asks
   * each question once. Written back as answers are given.
   */
  session?: Map<string, string>;
  /** Ask when a value is missing and there is a terminal to ask at. */
  prompt?: boolean;
  /** Ignore `recorded` and ask again -- `hcm update --reconfigure`. */
  reconfigure?: boolean;
  /** Test seam: answers the questions instead of the terminal. */
  ask?: (parameter: ParameterDefinition) => Promise<string>;
}

export interface ResolvedParameters {
  values: ParameterValues;
  /** Where each value came from, for `--verbose`. */
  sources: Record<string, ParameterSource>;
}

/**
 * Work out the value of every parameter this install needs.
 *
 * The order is the point. What the command line says beats the environment,
 * which beats what has already been answered in this run, which beats what the
 * last install recorded -- and only when all of those are silent is anybody
 * asked. So a scripted run never blocks, an interactive one never repeats
 * itself, and `hcm update` never changes an answer behind your back.
 */
export async function resolveParameters(
  input: ResolveParametersInput,
): Promise<ResolvedParameters> {
  const values: ParameterValues = {};
  const sources: Record<string, ParameterSource> = {};
  const session = input.session ?? new Map<string, string>();
  const overrides = input.overrides ?? {};
  let headerShown = false;

  for (const parameter of input.parameters) {
    const key = sessionKey(input.bundle, input.target, parameter);

    const supplied = firstSupplied(parameter, {
      overrides,
      session,
      key,
      ...(input.recorded && !input.reconfigure ? { recorded: input.recorded } : {}),
    });

    if (supplied) {
      values[parameter.name] = supplied.value;
      sources[parameter.name] = supplied.source;
      continue;
    }

    if (input.prompt !== false && (input.ask !== undefined || isInteractive())) {
      if (!headerShown && input.ask === undefined) {
        log.plain('');
        log.info(`  ${color.bold(input.bundle)} asks for:`);
        headerShown = true;
      }
      const answer = await (input.ask ?? askParameter)(parameter);
      values[parameter.name] = answer;
      sources[parameter.name] = 'prompt';
      session.set(key, answer);
      continue;
    }

    if (parameter.default !== undefined) {
      values[parameter.name] = parameter.default;
      sources[parameter.name] = 'default';
      continue;
    }

    if (parameter.required) throw missingValue(parameter, input.bundle);

    // Optional, unanswered and with nothing to fall back on: the placeholder
    // stands for nothing, so it becomes nothing rather than staying in the text.
    values[parameter.name] = '';
    sources[parameter.name] = 'empty';
  }

  return { values, sources };
}

/**
 * Answers are remembered per bundle, except for a parameter that names the
 * harnesses it applies to -- that one is a fact about a harness, so it is asked
 * again for the next one rather than carried across.
 */
function sessionKey(bundle: string, target: TargetId, parameter: ParameterDefinition): string {
  return parameter.targets.length > 0
    ? `${bundle}@${target}::${parameter.name}`
    : `${bundle}::${parameter.name}`;
}

/** The first source that has something to say, checked in precedence order. */
function firstSupplied(
  parameter: ParameterDefinition,
  from: {
    overrides: ParameterValues;
    session: Map<string, string>;
    key: string;
    recorded?: ParameterValues;
  },
): { value: string; source: ParameterSource } | undefined {
  const candidates: { value: string | undefined; source: ParameterSource }[] = [
    { value: from.overrides[parameter.name], source: 'flag' },
    { value: process.env[parameterEnvName(parameter.name)], source: 'environment' },
    { value: from.session.get(from.key), source: 'session' },
    { value: from.recorded?.[parameter.name], source: 'recorded' },
  ];

  for (const candidate of candidates) {
    if (candidate.value === undefined) continue;

    const problem = valueProblem(parameter, candidate.value);
    if (!problem) return { value: candidate.value, source: candidate.source };

    // A value the bundle itself no longer accepts. From the command line or the
    // environment that is a mistake worth stopping for; a recorded one just
    // means the bundle tightened its rules since, so fall through and ask.
    if (candidate.source === 'flag' || candidate.source === 'environment') {
      throw new HcmError(
        `The value given for "${parameter.name}" ${problem}`,
        candidate.source === 'environment'
          ? `It came from ${parameterEnvName(parameter.name)}.`
          : undefined,
      );
    }
    log.warn(
      `  the value recorded for "${parameter.name}" ${problem}; asking again`,
    );
  }

  return undefined;
}

/** What is wrong with a value, if anything -- phrased to follow "the value ...". */
export function valueProblem(
  parameter: ParameterDefinition,
  value: string,
): string | undefined {
  if (parameter.choices && !parameter.choices.includes(value)) {
    return `is not one of its choices (${parameter.choices.join(', ')})`;
  }
  if (parameter.pattern && !new RegExp(parameter.pattern).test(value)) {
    return `does not match the pattern ${parameter.pattern}`;
  }
  if (parameter.required && value === '') return 'is empty, and it is required';
  return undefined;
}

function missingValue(parameter: ParameterDefinition, bundle: string): HcmError {
  return new HcmError(
    `"${bundle}" needs a value for the parameter "${parameter.name}"` +
      (parameter.description ? ` (${parameter.description})` : ''),
    `Pass --param ${parameter.name}=<value>, put it in a --params-file, set ` +
      `${parameterEnvName(parameter.name)}, or run this in a terminal to be asked.`,
  );
}

/**
 * One question. A menu when the bundle listed the answers, free text otherwise.
 *
 * The name is printed once, by whichever of the two is asking, and the default
 * is offered as the suggestion so that pressing enter takes it.
 */
async function askParameter(parameter: ParameterDefinition): Promise<string> {
  const note =
    (parameter.description ? color.dim(` — ${parameter.description}`) : '') +
    (parameter.secret ? color.dim(' (not stored; supply it again on update)') : '');

  if (parameter.choices) {
    return select(
      `    ${color.bold(parameter.name)}${note}`,
      parameter.choices.map((choice) => ({ value: choice, label: choice })),
      parameter.default,
    );
  }

  if (note) log.plain(`    ${color.dim(note.replace(/^ — /, ''))}`);

  const suggestion = parameter.default;
  const question =
    `  ${color.bold(parameter.name)}` +
    (suggestion === undefined ? '' : color.dim(` [${suggestion}]`));

  const answer = await text(question, (value) => {
    const candidate = value === '' && suggestion !== undefined ? suggestion : value;
    if (candidate === '' && !parameter.required) return undefined;
    const problem = valueProblem(parameter, candidate);
    return problem ? `that value ${problem}` : undefined;
  });

  return answer === '' && suggestion !== undefined ? suggestion : answer;
}

/**
 * The values worth writing into the ledger. Secrets are not: the project-scope
 * ledger sits in `.hcm/state.json` next to the code, and a token in there is a
 * token in the repository.
 */
export function storableValues(
  values: ParameterValues,
  parameters: ParameterDefinition[],
): ParameterValues {
  const secret = new Set(parameters.filter((one) => one.secret).map((one) => one.name));
  return Object.fromEntries(Object.entries(values).filter(([name]) => !secret.has(name)));
}

// ---------------------------------------------------------------------------
// Saying it out loud
// ---------------------------------------------------------------------------

/** What to store in the registry: what will be asked, not how it is validated. */
export function summarizeParameters(parameters: ParameterDefinition[]): ParameterSummary[] {
  return parameters.map((parameter) => ({
    name: parameter.name,
    ...(parameter.description ? { description: parameter.description } : {}),
    ...(parameter.default !== undefined ? { default: parameter.default } : {}),
    ...(parameter.required ? { required: true } : {}),
    ...(parameter.secret ? { secret: true } : {}),
    ...(parameter.flavors.length > 0 ? { flavors: parameter.flavors } : {}),
    ...(parameter.targets.length > 0 ? { targets: parameter.targets } : {}),
  }));
}

/** `AGENT_NAME, TEAM` -- for the listings. */
export function parameterNames(parameters: ParameterSummary[] | undefined): string {
  return (parameters ?? []).map((parameter) => parameter.name).join(', ');
}

/** Where a parameter applies, in prose. Empty for a global one. */
export function describeScope(parameter: ParameterDefinition | ParameterSummary): string {
  const parts: string[] = [];
  if (parameter.flavors?.length) parts.push(`flavor ${parameter.flavors.join('/')}`);
  if (parameter.targets?.length) parts.push(`harness ${parameter.targets.join('/')}`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Text worth scanning for placeholders in a file we would otherwise copy
 * verbatim. Read synchronously because `validateBundle` is, and a bundle's
 * supporting files are small enough that making it async would buy nothing.
 */
function readableText(absolutePath: string): string | undefined {
  try {
    return decodeText(readFileSync(absolutePath));
  } catch {
    return undefined;
  }
}

/** Every piece of text one resource would install, with a label for each. */
function resourceText(resource: BundleResource): { where: string; text: string }[] {
  const found: { where: string; text: string }[] = [];

  if (resource.body !== undefined) found.push({ where: resource.bundlePath, text: resource.body });
  for (const [key, value] of Object.entries(resource.frontmatter)) {
    found.push({ where: `${resource.bundlePath} (${key})`, text: JSON.stringify(value) });
  }
  if (resource.data !== undefined) {
    found.push({ where: resource.bundlePath, text: JSON.stringify(resource.data) });
  }

  // Skills and assets carry files the loader never parsed; they are templated
  // too, so they are scanned too.
  for (const file of resource.files) {
    if (file.absolutePath === resource.primaryFile) continue;
    const text = readableText(file.absolutePath);
    if (text !== undefined) {
      found.push({ where: `${resource.bundlePath}/${file.relativePath}`, text });
    }
  }
  if (resource.kind === 'asset') {
    const text = readableText(resource.primaryFile);
    if (text !== undefined) found.push({ where: resource.bundlePath, text });
  }

  return found;
}

/**
 * Parameter mistakes worth reporting, surfaced by `hcm validate` and `hcm info`.
 *
 * The first two are the ones that bite: a placeholder nothing declares installs
 * verbatim, and a parameter narrower than the file that uses it installs
 * verbatim for everyone outside the narrowing. Both look, in the installed
 * file, exactly like a bundle that forgot to finish a sentence.
 */
export function parameterProblems(bundle: LoadedBundle): string[] {
  const problems: string[] = [];
  const declared = new Map(bundle.parameters.map((parameter) => [parameter.name, parameter]));
  const flavors = new Set(bundle.flavors.map((flavor) => flavor.name.toLowerCase()));
  const bundleTargets = bundle.manifest.targets?.length ? bundle.manifest.targets : [...TARGET_IDS];
  const used = new Set<string>();

  for (const resource of bundle.resources) {
    // The name decides the installed filename, and a path is never templated.
    if (typeof resource.frontmatter.name === 'string' && hasPlaceholder(resource.frontmatter.name)) {
      problems.push(
        `${resource.bundlePath}: "name" holds a placeholder, but it decides the installed ` +
          'filename and is never substituted',
      );
    }

    for (const { where, text } of resourceText(resource)) {
      for (const name of placeholderNames(text)) {
        used.add(name);
        const parameter = declared.get(name);

        if (!parameter) {
          problems.push(
            `${where}: "<%${name}%>" is not a parameter this bundle declares, so it installs verbatim`,
          );
          continue;
        }

        // A parameter narrowed to one flavor or one harness is only *asked* for
        // there; everywhere else it falls back to its default. With no default
        // there is nothing to fall back to, and the placeholder installs as it
        // stands -- which is the only version of this worth reporting.
        if (parameter.default !== undefined) continue;

        if (parameter.flavors.length > 0) {
          const outside =
            resource.flavors.length === 0 ||
            !resource.flavors.every((flavor) =>
              parameter.flavors.some((one) => one.toLowerCase() === flavor.toLowerCase()),
            );
          if (outside) {
            problems.push(
              `${where}: "<%${name}%>" is only asked for with flavor ${parameter.flavors.join('/')} ` +
                `and has no default, but ` +
                (resource.flavors.length === 0
                  ? 'this resource is common and installs whatever flavor was asked for'
                  : `this resource belongs to ${resource.flavors.join('/')}`),
            );
          }
        }

        if (parameter.targets.length > 0) {
          const elsewhere = bundleTargets.filter((id) => !parameter.targets.includes(id));
          if (elsewhere.length > 0) {
            problems.push(
              `${where}: "<%${name}%>" is only asked for on ${parameter.targets.join('/')} and has ` +
                `no default, but this bundle also installs into ${elsewhere.join(', ')}`,
            );
          }
        }
      }
    }
  }

  for (const parameter of bundle.parameters) {
    if (!used.has(parameter.name)) {
      problems.push(
        `Parameter "${parameter.name}" is declared but never used; installing would ask for a ` +
          'value and put it nowhere',
      );
    }
    for (const flavor of parameter.flavors) {
      if (flavors.has(flavor.toLowerCase())) continue;
      problems.push(
        `Parameter "${parameter.name}": flavor "${flavor}" is not one this bundle declares` +
          (bundle.flavors.length > 0
            ? ` (it has: ${bundle.flavors.map((one) => one.name).join(', ')})`
            : ' (it has none)'),
      );
    }
    for (const target of parameter.targets) {
      if (bundleTargets.includes(target)) continue;
      problems.push(
        `Parameter "${parameter.name}": harness "${target}" is not one this bundle supports ` +
          `(it declares: ${bundleTargets.join(', ')})`,
      );
    }
  }

  return problems;
}
