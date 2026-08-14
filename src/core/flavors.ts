/**
 * Flavors: installing part of a bundle.
 *
 * A coding kit that covers Python and C# is one bundle -- the review command,
 * the house conventions, the PR skill are the same either way -- but half of
 * what it ships is only useful in one language. A *flavor* names that half:
 *
 *   hcm install coding-kit --flavor python
 *
 * installs everything common to the kit plus everything marked `python`, and
 * leaves the rest on the shelf.
 *
 * Two rules, and the rest follows from them:
 *
 *   1. A resource belonging to no flavor is *common*: it installs whatever was
 *      asked for. This is what keeps every bundle written before flavors
 *      existed installing in full, and it is why a dependency that has never
 *      heard of `python` still arrives whole when its dependent is narrowed.
 *   2. A resource belonging to at least one flavor installs only when one of
 *      its flavors was asked for. Asking for no flavor at all asks for all of
 *      them, so a plain `hcm install` is unchanged.
 *
 * A resource says which flavors it belongs to in its own frontmatter:
 *
 *     ---
 *     description: Runs pytest and reads the failures
 *     flavors: [python]
 *     ---
 *
 * or the manifest says it for them with a path pattern, which is the only
 * option for `mcp/`, `settings/` and `assets/` -- they have no frontmatter to
 * write in:
 *
 *     flavors:
 *       python:
 *         description: Python tooling
 *         includes:
 *           - skills/pytest-*
 *           - mcp/pyright.json
 *           - assets/python
 *
 * Nothing here removes anything. A flavor decides what a *plan* contains, so an
 * install narrowed to Python writes only Python items and its receipts claim
 * only those -- and uninstall, status and rollback need to know nothing about
 * any of this.
 */

import { HcmError } from './errors.js';
import type {
  BundleManifest,
  BundleResource,
  FlavorDefinition,
  FlavorSummary,
  LoadedBundle,
} from './types.js';

const FLAVOR_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * `--flavor all` is how you ask for the whole bundle, which matters for `hcm
 * update`: with no flag at all it reinstalls whatever subset was recorded, so
 * widening back needs something to say. Reserved, so it always means that.
 */
export const ALL_FLAVORS = 'all';

const DECLARATION_HINT =
  'Write "flavors: [python, csharp]", or a mapping of name to description, or a ' +
  'mapping of name to {description, includes}.';

// ---------------------------------------------------------------------------
// Reading the manifest
// ---------------------------------------------------------------------------

/**
 * Accept every way of writing `flavors:` and return the one shape the rest of
 * hcm works with:
 *
 *   flavors: [python, csharp]           # names alone
 *
 *   flavors:
 *     python: Python tooling            # names with a description
 *
 *   flavors:
 *     python:                           # names with patterns
 *       description: Python tooling
 *       includes: [skills/pytest-*, mcp/pyright.json]
 */
export function normalizeFlavors(
  manifest: BundleManifest,
  where = manifest.name,
): FlavorDefinition[] {
  const declared = manifest.flavors;
  if (declared === undefined) return [];

  let entries: [string, unknown][];

  if (Array.isArray(declared)) {
    for (const name of declared) {
      if (typeof name !== 'string') {
        throw new HcmError(`Malformed flavor in ${where}: ${JSON.stringify(name)}`, DECLARATION_HINT);
      }
    }
    entries = declared.map((name) => [name as string, undefined]);
  } else if (declared && typeof declared === 'object') {
    entries = Object.entries(declared);
  } else {
    throw new HcmError(`"flavors" in ${where} must be a list of names or a mapping`, DECLARATION_HINT);
  }

  const seen = new Set<string>();
  const flavors: FlavorDefinition[] = [];

  for (const [rawName, value] of entries) {
    const name = rawName.trim();
    if (!FLAVOR_NAME_PATTERN.test(name)) {
      throw new HcmError(
        `"${name}" is not a usable flavor name (in ${where})`,
        'Use letters, digits, dots, dashes and underscores.',
      );
    }

    const key = name.toLowerCase();
    if (key === ALL_FLAVORS) {
      throw new HcmError(
        `"${ALL_FLAVORS}" cannot be used as a flavor name (in ${where})`,
        `"--flavor ${ALL_FLAVORS}" is how a user asks for the whole bundle.`,
      );
    }
    if (seen.has(key)) {
      throw new HcmError(`"${name}" is listed twice in ${where}'s flavors`);
    }
    seen.add(key);

    flavors.push({ name, ...readFlavorBody(name, value, where) });
  }

  return flavors;
}

/** The right-hand side of one flavor entry: nothing, a description, or both. */
function readFlavorBody(
  name: string,
  value: unknown,
  where: string,
): { description?: string; includes: string[] } {
  if (value === undefined || value === null) return { includes: [] };

  if (typeof value === 'string') {
    const description = value.trim();
    return { ...(description ? { description } : {}), includes: [] };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HcmError(`Malformed flavor "${name}" in ${where}`, DECLARATION_HINT);
  }

  const shape = value as { description?: unknown; includes?: unknown };

  if (shape.description !== undefined && typeof shape.description !== 'string') {
    throw new HcmError(`"description" for flavor "${name}" in ${where} must be text`);
  }
  const description = typeof shape.description === 'string' ? shape.description.trim() : undefined;

  return {
    ...(description ? { description } : {}),
    includes: readPatterns(shape.includes, name, where),
  };
}

function readPatterns(value: unknown, name: string, where: string): string[] {
  if (value === undefined || value === null) return [];

  const list = Array.isArray(value) ? value : [value];
  const patterns: string[] = [];

  for (const entry of list) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new HcmError(
        `"includes" for flavor "${name}" in ${where} must be a path pattern or a list of them`,
        'Patterns are bundle-relative, e.g. "skills/pytest-*" or "rules/python.md".',
      );
    }
    // A trailing slash and a leading `./` both mean the same directory; strip
    // them so `assets/python/` and `assets/python` are one pattern.
    patterns.push(entry.trim().replace(/^\.\//, '').replace(/\/+$/, ''));
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Matching resources
// ---------------------------------------------------------------------------

const PATTERNS = new Map<string, RegExp>();

/**
 * Does a bundle-relative path fall under a flavor's pattern?
 *
 * `*` matches within one path segment, `**` across segments, `?` one character.
 * A pattern naming a directory takes everything under it, so `assets/python`
 * covers `assets/python/lint.sh` without a trailing `/**` -- which is what
 * anyone writing the pattern by hand means by it.
 */
export function matchesPattern(bundlePath: string, pattern: string): boolean {
  return compilePattern(pattern).test(bundlePath);
}

function compilePattern(pattern: string): RegExp {
  const cached = PATTERNS.get(pattern);
  if (cached) return cached;

  let source = '';
  let at = 0;

  while (at < pattern.length) {
    const rest = pattern.slice(at);

    // `**/` also matches zero directories, so `**/x.md` finds a top-level x.md.
    if (rest.startsWith('**/')) {
      source += '(?:.*/)?';
      at += 3;
      continue;
    }
    if (rest.startsWith('**')) {
      source += '.*';
      at += 2;
      continue;
    }

    const char = pattern[at] as string;
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    at += 1;
  }

  const expression = new RegExp(`^${source}(?:/.*)?$`, 'i');
  PATTERNS.set(pattern, expression);
  return expression;
}

/**
 * Work out which flavors each resource belongs to, and which flavors the bundle
 * has at all. Sets `resource.flavors` in place; returns the bundle's flavors.
 *
 * Declaring nothing in the manifest is allowed -- the flavors are then whatever
 * the resources named for themselves, which is the shortest way to write a kit
 * that is all markdown. Declaring some makes that list the authority, and
 * `hcm validate` reports a resource naming one outside it.
 */
export function attachFlavors(
  resources: BundleResource[],
  declared: FlavorDefinition[],
): FlavorDefinition[] {
  const spellings = new Map(declared.map((flavor) => [flavor.name.toLowerCase(), flavor.name]));

  for (const resource of resources) {
    const own = takeFrontmatterFlavors(resource.frontmatter, resource.bundlePath);
    const matched = declared
      .filter((flavor) =>
        flavor.includes.some((pattern) => matchesPattern(resource.bundlePath, pattern)),
      )
      .map((flavor) => flavor.name);

    // The manifest's spelling wins, so one flavor is one entry however the
    // resources happened to capitalise it.
    const names = new Map<string, string>();
    for (const name of [...own, ...matched]) {
      const key = name.toLowerCase();
      names.set(key, spellings.get(key) ?? name);
    }

    resource.flavors = [...names.values()].sort((a, b) => a.localeCompare(b));
  }

  if (declared.length > 0) return declared;

  const used = new Map<string, string>();
  for (const resource of resources) {
    for (const name of resource.flavors) used.set(name.toLowerCase(), name);
  }

  return [...used.values()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, includes: [] }));
}

/**
 * Read a resource's own `flavors:` and take it back out of the frontmatter.
 *
 * Out, because every target copies frontmatter keys it does not recognise into
 * the file it writes -- this one is hcm's bookkeeping and has no business in an
 * installed SKILL.md.
 */
function takeFrontmatterFlavors(frontmatter: Record<string, unknown>, where: string): string[] {
  const names: string[] = [];

  for (const key of ['flavors', 'flavor']) {
    const value = frontmatter[key];
    if (value === undefined) continue;
    delete frontmatter[key];

    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry !== 'string' || !entry.trim()) {
        throw new HcmError(
          `"${key}" in ${where} must be a flavor name or a list of them`,
          `Got ${JSON.stringify(entry)}.`,
        );
      }
      names.push(entry.trim());
    }
  }

  return names;
}

// ---------------------------------------------------------------------------
// Selecting
// ---------------------------------------------------------------------------

/**
 * Is this resource part of an install that asked for `requested`?
 *
 * An empty request is a whole install -- which is what every command that never
 * mentions flavors passes, and what a bundle with no flavors always gets.
 */
export function inFlavors(resource: BundleResource, requested: string[]): boolean {
  const own = resource.flavors ?? [];
  if (requested.length === 0 || own.length === 0) return true;

  const wanted = new Set(requested.map((name) => name.toLowerCase()));
  return own.some((name) => wanted.has(name.toLowerCase()));
}

/**
 * Tidy what the command line gave: trimmed, in the order typed, one entry per
 * flavor however many times it was said.
 *
 * Undefined for "no narrowing" -- which `--flavor all` says explicitly, and an
 * omitted flag says by default. The difference matters only to `hcm update`,
 * where an omitted flag means "whatever was recorded" and `all` means "widen
 * back to the whole bundle".
 */
export function expandFlavors(values: string[] | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  if (values.some((value) => value.trim().toLowerCase() === ALL_FLAVORS)) return undefined;

  const seen = new Map<string, string>();
  for (const value of values) {
    const name = value.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  }

  const names = [...seen.values()];
  return names.length > 0 ? names : undefined;
}

/** True when a bundle offers a flavor by that name, however it is capitalised. */
export function hasFlavor(bundle: LoadedBundle, name: string): boolean {
  return bundle.flavors.some((flavor) => flavor.name.toLowerCase() === name.toLowerCase());
}

/**
 * Refuse a `--flavor` the bundles being installed do not have.
 *
 * A misspelled flavor would otherwise install the common part and quietly drop
 * everything the user actually asked for, which looks exactly like a bundle
 * that shipped less than it says.
 *
 * Naming several bundles at once is only allowed when they all define the
 * flavor: one `--flavor python` cannot mean the Python part of one kit and the
 * whole of another, and picking either reading for the user would be a guess.
 */
export function assertFlavorsAvailable(bundles: LoadedBundle[], requested: string[]): void {
  if (requested.length === 0 || bundles.length === 0) return;

  for (const name of requested) {
    const missing = bundles.filter((bundle) => !hasFlavor(bundle, name));
    if (missing.length === 0) continue;

    const first = bundles[0] as LoadedBundle;

    if (bundles.length === 1) {
      throw new HcmError(
        `"${first.manifest.name}" has no flavor "${name}"`,
        first.flavors.length > 0
          ? `It offers: ${first.flavors.map((flavor) => flavor.name).join(', ')}`
          : 'It defines no flavors, so it installs in full -- drop --flavor.',
      );
    }

    throw new HcmError(
      `--flavor ${name} does not apply to ` +
        missing.map((bundle) => `"${bundle.manifest.name}"`).join(', '),
      'Installing several bundles at once with --flavor needs every one of them to define ' +
        'the flavor. Install them one at a time to give each its own.',
    );
  }
}

// ---------------------------------------------------------------------------
// Saying it out loud
// ---------------------------------------------------------------------------

/** What to store in the registry: the names and what they are for, not the patterns. */
export function summarizeFlavors(flavors: FlavorDefinition[]): FlavorSummary[] {
  return flavors.map((flavor) => ({
    name: flavor.name,
    ...(flavor.description ? { description: flavor.description } : {}),
  }));
}

/** `python, csharp` -- for the listings. */
export function flavorNames(flavors: FlavorSummary[] | undefined): string {
  return (flavors ?? []).map((flavor) => flavor.name).join(', ');
}

/** How an install describes the subset it is writing, in prose. */
export function describeFlavorSelection(flavors: string[] | undefined): string {
  return flavors?.length ? `flavor(s) ${flavors.join(', ')}` : 'every flavor';
}

/** True when two installs asked for the same subset, however it was typed. */
export function sameFlavors(left: string[] | undefined, right: string[] | undefined): boolean {
  const key = (names: string[] | undefined): string =>
    [...new Set((names ?? []).map((name) => name.toLowerCase()))].sort().join(',');
  return key(left) === key(right);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Flavor mistakes worth reporting, surfaced by `hcm validate` and `hcm info`. */
export function flavorProblems(bundle: LoadedBundle): string[] {
  const problems: string[] = [];
  const declared = normalizeFlavors(bundle.manifest);

  // Only when the manifest declares a list is there a list to be outside of.
  if (declared.length > 0) {
    const known = new Set(declared.map((flavor) => flavor.name.toLowerCase()));
    for (const resource of bundle.resources) {
      for (const name of resource.flavors) {
        if (known.has(name.toLowerCase())) continue;
        problems.push(
          `${resource.bundlePath}: flavor "${name}" is not declared in the manifest ` +
            `(it declares: ${declared.map((flavor) => flavor.name).join(', ')})`,
        );
      }
    }
  }

  for (const flavor of bundle.flavors) {
    for (const pattern of flavor.includes) {
      if (bundle.resources.some((resource) => matchesPattern(resource.bundlePath, pattern))) {
        continue;
      }
      problems.push(`Flavor "${flavor.name}": "${pattern}" matches nothing in the bundle`);
    }

    const members = bundle.resources.filter((resource) =>
      resource.flavors.some((name) => name.toLowerCase() === flavor.name.toLowerCase()),
    );
    if (members.length === 0) {
      problems.push(
        `Flavor "${flavor.name}" has no resources; ` +
          `"--flavor ${flavor.name}" would install the common part and nothing else`,
      );
    }
  }

  return problems;
}
