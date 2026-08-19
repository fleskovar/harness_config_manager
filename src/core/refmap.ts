/**
 * Keeping a bundle's internal file references true after installation.
 *
 * Inside a bundle, one file points at another the way the bundle is laid out:
 *
 *   skills/dependency-audit/SKILL.md   ->  `checklist.md`
 *   commands/review-pr.md              ->  `skills/dependency-audit/checklist.md`
 *
 * Installation takes that layout apart. The same two files land in
 * `.claude/skills/dependency-audit/` and `.claude/commands/`, in
 * `.github/skills/` and `.github/prompts/`, in `.pi/skills/` and `.pi/prompts/`
 * -- and on Reasonix a rule is not a file at all, it is a block inside
 * REASONIX.md. A reference written against the bundle's layout is wrong in
 * every one of those places, and wrong in a different way in each.
 *
 * So references are authored against the *bundle*, and rewritten on the way in.
 * The plan already knows where every file is going -- that is what a plan is --
 * so the mapping is read straight off it, and the rewrite happens before
 * conflict detection, which means hashes, receipts, `--dry-run` and `hcm info`
 * all see the text that will actually be on disk.
 *
 * The rewritten form is always relative to the file doing the referring:
 *
 *   skills/audit/SKILL.md -> checklist.md          `checklist.md`
 *   commands/review.md    -> skills/audit/x.md     `../skills/audit/x.md`
 *   context/notes.md      -> skills/audit/x.md     `.claude/skills/audit/x.md`
 *                                                  (a context section lands in
 *                                                  CLAUDE.md, at the scope
 *                                                  root, with nothing to climb)
 *
 * One rule, not two: a reference means the same thing to whoever reads the file
 * it is written in, wherever that file ended up and whichever scope it went
 * into. `checklist.md` next to a SKILL.md was already relative and comes out
 * unchanged, which is also what the harnesses document for a skill's own
 * supporting files.
 *
 * Nothing is guessed: a reference is rewritten only when it resolves to a file
 * the bundle actually ships and the plan actually installs. One that resolves
 * to a file this target drops -- a rule on a harness with no rule files -- is
 * left alone and reported, because a broken reference the user is told about is
 * better than a plausible one that is wrong.
 */

import { extractRefs, INSTALL_POLICY, looksLikePath } from './refs.js';
import type { BundleResource, LoadedBundle, PlanAction } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RefMap {
  /** Bundle-relative POSIX path -> scope-root-relative path it installs to. */
  installed: Map<string, string>;
  /** Every file the bundle ships, whether or not this target installs it. */
  known: Set<string>;
  /** Which action renders which bundle file, so a rewrite knows where it is. */
  origins: Map<PlanAction, string>;
}

export interface RefRewrite {
  /** Scope-root-relative path of the file that was rewritten. */
  path: string;
  from: string;
  to: string;
}

export interface DroppedRef {
  path: string;
  ref: string;
  reason: string;
}

export interface RemapReport {
  /** Rewritten copies; actions with nothing to change are returned unchanged. */
  actions: PlanAction[];
  rewrites: RefRewrite[];
  /** References to bundle files this target does not install. */
  dropped: DroppedRef[];
}

// ---------------------------------------------------------------------------
// Building the map
// ---------------------------------------------------------------------------

/**
 * Pair each action with the bundle file it renders, and each bundle file with
 * where it lands.
 *
 * Targets are not asked to declare any of this. They already answer the only
 * question that matters -- what path does this resource write to -- so the
 * pairing is done here by matching a resource's files against its actions, and
 * a target stays a description of one harness's conventions.
 */
export function buildRefMap(bundle: LoadedBundle, actions: PlanAction[]): RefMap {
  const installed = new Map<string, string>();
  const known = new Set<string>();
  const origins = new Map<PlanAction, string>();

  for (const resource of bundle.resources) {
    for (const bundlePath of resourceFiles(resource)) known.add(bundlePath);
  }

  for (const [resource, group] of byResource(actions)) {
    // A skill is many files and many actions; everything else is one file that
    // may imply several writes (a rule on OpenCode is a file *and* a config
    // entry), and only the first of those is the file itself.
    if (resource.kind === 'skill') {
      for (const file of resource.files) {
        const bundlePath = `${resource.bundlePath}/${file.relativePath}`;
        const action = group.find(
          (candidate) =>
            candidate.payload.kind === 'file' &&
            !origins.has(candidate) &&
            (candidate.path === file.relativePath ||
              candidate.path.endsWith(`/${file.relativePath}`)),
        );
        if (!action) continue;
        origins.set(action, bundlePath);
        installed.set(bundlePath, action.path);
      }
      continue;
    }

    const primary =
      group.find((action) => action.payload.kind === 'file') ??
      group.find((action) => action.payload.kind === 'block') ??
      group[0];
    if (!primary) continue;

    origins.set(primary, resource.bundlePath);
    installed.set(resource.bundlePath, primary.path);

    // A settings fragment or an MCP server is one bundle file split across many
    // writes into one config; all of them may carry a path to remap.
    for (const action of group) {
      if (!origins.has(action)) origins.set(action, resource.bundlePath);
    }
  }

  return { installed, known, origins };
}

/** Every file a resource is made of, as bundle-relative POSIX paths. */
function resourceFiles(resource: BundleResource): string[] {
  if (resource.kind === 'skill') {
    return resource.files.map((file) => `${resource.bundlePath}/${file.relativePath}`);
  }
  return [resource.bundlePath];
}

function byResource(actions: PlanAction[]): Map<BundleResource, PlanAction[]> {
  const groups = new Map<BundleResource, PlanAction[]>();
  for (const action of actions) {
    if (!action.resource) continue;
    const existing = groups.get(action.resource);
    if (existing) existing.push(action);
    else groups.set(action.resource, [action]);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite every reference in `actions` that points at another file in the same
 * bundle. `only` limits what is rewritten without limiting what the map knows
 * about -- which is what a conflict rename needs, having regenerated one
 * resource's actions after the rest were already done.
 */
export function remapReferences(
  bundle: LoadedBundle,
  actions: PlanAction[],
  only?: PlanAction[],
): RemapReport {
  const map = buildRefMap(bundle, actions);
  const rewriting = new Set(only ?? actions);

  const rewrites: RefRewrite[] = [];
  const dropped: DroppedRef[] = [];

  const rewritten = actions.map((action) => {
    if (!rewriting.has(action)) return action;

    const from = map.origins.get(action);
    if (from === undefined) return action;

    const { payload } = action;

    if (payload.kind === 'file' && typeof payload.contents === 'string') {
      const result = remapText(payload.contents, from, action.path, map);
      collect(result, action.path, rewrites, dropped);
      if (result.text === payload.contents) return action;
      return { ...action, payload: { ...payload, contents: result.text } };
    }

    if (payload.kind === 'block') {
      const result = remapText(payload.body, from, action.path, map);
      collect(result, action.path, rewrites, dropped);
      if (result.text === payload.body) return action;
      return { ...action, payload: { ...payload, body: result.text } };
    }

    // MCP servers and settings fragments: a path can be an argument, a cwd or
    // an entry in an allowlist. Only whole string values that name a bundle
    // file are touched -- nothing here goes looking inside a command line.
    if (payload.kind === 'json-value') {
      const result = remapJson(payload.value, from, action.path, map);
      collect(result, action.path, rewrites, dropped);
      if (!result.changed) return action;
      return { ...action, payload: { ...payload, value: result.value } };
    }

    if (payload.kind === 'json-array-item') {
      const result = remapJson(payload.items, from, action.path, map);
      collect(result, action.path, rewrites, dropped);
      if (!result.changed) return action;
      return { ...action, payload: { ...payload, items: result.value as unknown[] } };
    }

    return action;
  });

  return { actions: rewritten, rewrites, dropped };
}

interface RemapResult {
  rewrites: { from: string; to: string }[];
  dropped: { ref: string; reason: string }[];
}

function collect(
  result: RemapResult,
  at: string,
  rewrites: RefRewrite[],
  dropped: DroppedRef[],
): void {
  for (const rewrite of result.rewrites) rewrites.push({ path: at, ...rewrite });
  for (const miss of result.dropped) dropped.push({ path: at, ...miss });
}

function remapText(
  text: string,
  from: string,
  installedFrom: string,
  map: RefMap,
): RemapResult & { text: string } {
  const found = extractRefs(from, text, INSTALL_POLICY);
  const rewrites: { from: string; to: string }[] = [];
  const dropped: { ref: string; reason: string }[] = [];
  const edits: { start: number; end: number; value: string }[] = [];

  for (const ref of found) {
    const outcome = translate(ref.ref, from, installedFrom, map);
    if (outcome.kind === 'dropped') {
      dropped.push({ ref: ref.ref, reason: outcome.reason });
      continue;
    }
    if (outcome.kind !== 'rewrite') continue;
    edits.push({ start: ref.start, end: ref.end, value: outcome.to });
    rewrites.push({ from: ref.ref, to: outcome.to });
  }

  // Back to front, so an earlier edit cannot move a later offset. Overlapping
  // candidates (a link inside inline code) are applied once, outermost wins.
  let updated = text;
  let boundary = text.length;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.end > boundary) continue;
    updated = updated.slice(0, edit.start) + edit.value + updated.slice(edit.end);
    boundary = edit.start;
  }

  return { text: updated, rewrites, dropped };
}

function remapJson(
  value: unknown,
  from: string,
  installedFrom: string,
  map: RefMap,
): RemapResult & { value: unknown; changed: boolean } {
  const rewrites: { from: string; to: string }[] = [];
  const dropped: { ref: string; reason: string }[] = [];
  let changed = false;

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      if (!looksLikePath(node, 'config')) return node;
      const outcome = translate(node, from, installedFrom, map);
      if (outcome.kind === 'dropped') {
        dropped.push({ ref: node, reason: outcome.reason });
        return node;
      }
      if (outcome.kind !== 'rewrite') return node;
      changed = true;
      rewrites.push({ from: node, to: outcome.to });
      return outcome.to;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]));
    }
    return node;
  };

  return { value: walk(value), rewrites, dropped, changed };
}

type Translation =
  | { kind: 'rewrite'; to: string }
  | { kind: 'unchanged' }
  | { kind: 'external' }
  | { kind: 'dropped'; reason: string };

/**
 * What one reference should say after installation.
 *
 * Both readings of a relative path are tried, bundle root first -- the same
 * order `hcm refs` resolves in, so what the checker calls resolved is what the
 * installer can remap.
 */
function translate(ref: string, from: string, installedFrom: string, map: RefMap): Translation {
  const trimmed = ref.trim();
  const hash = trimmed.indexOf('#');
  const anchor = hash === -1 ? '' : trimmed.slice(hash);
  const cleaned = (hash === -1 ? trimmed : trimmed.slice(0, hash)).replace(/^\.\//, '');
  if (!cleaned) return { kind: 'external' };

  const fromBundleRoot = normalize(cleaned);
  const fromThisFile = normalize(`${posixDirname(from)}/${cleaned}`);

  const bundlePath = [fromBundleRoot, fromThisFile].find(
    (candidate) => candidate !== undefined && map.installed.has(candidate),
  );

  if (bundlePath === undefined) {
    const missing = [fromBundleRoot, fromThisFile].find(
      (candidate) => candidate !== undefined && map.known.has(candidate),
    );
    if (missing !== undefined) {
      return {
        kind: 'dropped',
        reason: 'the file it names is not installed into this harness',
      };
    }
    return { kind: 'external' };
  }

  const target = map.installed.get(bundlePath) as string;
  const to = relativeTo(installedFrom, target) + anchor;
  return to === trimmed ? { kind: 'unchanged' } : { kind: 'rewrite', to };
}

/**
 * The path to write for `target` in a file that lives at `installedFrom`,
 * always relative to that file's own directory.
 *
 *   .claude/skills/audit/SKILL.md -> .claude/skills/audit/checklist.md
 *     becomes `checklist.md`
 *   .claude/commands/review.md    -> .claude/skills/audit/checklist.md
 *     becomes `../skills/audit/checklist.md`
 *   CLAUDE.md                     -> .claude/skills/audit/checklist.md
 *     becomes `.claude/skills/audit/checklist.md`
 *
 * One rule for every reference, so a file says the same thing about its
 * neighbours wherever the bundle is installed and whatever scope it went into
 * -- a file at the scope root simply has nothing to climb out of, which is why
 * the third case looks like a rooted path without being one.
 *
 * The rule holds only where paths are resolved against the file that contains
 * them. That is how the harnesses read the markdown they load; it is not
 * necessarily how they read a path *inside a config value*, where the working
 * directory is usually the project root -- see the note in the README.
 */
function relativeTo(installedFrom: string, target: string): string {
  const here = posixDirname(installedFrom).split('/').filter(Boolean);
  const there = target.split('/').filter(Boolean);

  let shared = 0;
  while (shared < here.length && shared < there.length && here[shared] === there[shared]) {
    shared += 1;
  }

  const up = here.slice(shared).map(() => '..');
  const down = there.slice(shared);
  // A file referring to itself: the only way both halves come out empty.
  return [...up, ...down].join('/') || posixBasename(target);
}

function posixBasename(value: string): string {
  const at = value.lastIndexOf('/');
  return at === -1 ? value : value.slice(at + 1);
}

function posixDirname(value: string): string {
  const at = value.lastIndexOf('/');
  return at === -1 ? '' : value.slice(0, at);
}

/** POSIX normalisation that refuses to leave the bundle. */
function normalize(value: string): string | undefined {
  const out: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length === 0 ? undefined : out.join('/');
}

/** Exported for the install log: one line per file, not one per reference. */
export function summarizeRewrites(rewrites: RefRewrite[]): { path: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const rewrite of rewrites) counts.set(rewrite.path, (counts.get(rewrite.path) ?? 0) + 1);
  return [...counts].map(([file, count]) => ({ path: file, count }));
}
