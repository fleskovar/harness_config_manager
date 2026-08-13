/**
 * Files two harnesses both read.
 *
 * Most of what hcm writes belongs to exactly one harness: `.claude/agents/` is
 * Claude Code's and nobody else's, so installing there and uninstalling there
 * are complete operations. Two files are not like that:
 *
 *   .mcp.json   Claude Code and Pi both read `mcpServers.<name>`
 *   AGENTS.md   OpenCode and Pi both read the whole file
 *
 * hcm's own bookkeeping copes with this already -- claims are keyed by absolute
 * path (`core/state.ts`), so an item is written once and claimed by every
 * installation that wanted it, and it survives until the last claim goes. What
 * the bookkeeping cannot do is make the *harnesses* behave as if the file were
 * per-harness, and that is where the surprise lives:
 *
 *   hcm uninstall my-kit -t reasonix      leaves .mcp.json alone if Claude Code
 *                                         still claims the server -- and Pi,
 *                                         reading the same file, still has it
 *   hcm install my-kit -t claude-code     writes a server Pi can also see, in a
 *                                         folder where Pi is set up
 *
 * Neither is a bug: it is what "one file, two readers" means. But it is not
 * what "-t" suggests, so it is worth saying out loud.
 *
 * The overlaps are computed rather than listed. Each target is asked what it
 * would write for a probe resource of each kind it supports, and paths that
 * land in the same place for two targets are shared by construction -- so a new
 * adapter, or a change to an existing one, is accounted for without anybody
 * remembering to update a table here.
 */

import { fromPosix } from './fsx.js';
import type {
  BundleResource,
  ResourceKind,
  Scope,
  TargetId,
  TargetOptions,
} from './types.js';
import { getTarget, TARGET_IDS } from '../targets/index.js';

/** One file, and the harnesses that write to it at a given scope. */
export interface SharedFile {
  /** Absolute path, lower-cased -- the same key `core/state.ts` claims by. */
  key: string;
  /** How each harness spells the path, relative to its own scope root. */
  readers: { target: TargetId; path: string; kinds: ResourceKind[] }[];
}

/**
 * A path this run is about to touch that another harness also reads.
 * `others` is only ever harnesses actually set up in the folder: a warning
 * about Pi in a project with no Pi in it would be noise.
 */
export interface SharedFileNotice {
  /** The path as the acting harness spells it. */
  path: string;
  others: TargetId[];
}

/** The name every probe resource carries, so a stray one is recognisable. */
const PROBE = 'hcm-probe';

/**
 * Files written by more than one of `targets` at this scope.
 *
 * Note this is a question about *harnesses*, not about bundles: two harnesses
 * whose layouts happen to collide share the file whatever is installed in it.
 */
export function sharedFiles(
  targets: readonly TargetId[],
  scope: Scope,
  cwd: string,
  options: TargetOptions = {},
): SharedFile[] {
  const byKey = new Map<string, SharedFile>();

  for (const id of targets) {
    const target = getTarget(id);
    const root = target.scopeRoot(scope, cwd);

    for (const [path, kinds] of writtenPaths(id, scope, options)) {
      const key = fromPosix(root, path).toLowerCase();
      const entry = byKey.get(key) ?? { key, readers: [] };
      entry.readers.push({ target: id, path, kinds });
      byKey.set(key, entry);
    }
  }

  return [...byKey.values()].filter(
    (file) => new Set(file.readers.map((reader) => reader.target)).size > 1,
  );
}

/**
 * Which paths one target writes, and for which kinds.
 *
 * Probing with a fixed name is enough because the question is whether two
 * layouts collide, and a layout that collides for one name collides for all of
 * them: `.mcp.json` is `.mcp.json` whatever the server is called, and
 * `.claude/agents/<n>.md` can never be `.pi/skills/<n>/SKILL.md`.
 */
function writtenPaths(
  id: TargetId,
  scope: Scope,
  options: TargetOptions,
): Map<string, ResourceKind[]> {
  const target = getTarget(id);
  const paths = new Map<string, ResourceKind[]>();

  for (const kind of target.supports) {
    const resource = probeResource(kind);
    if (!resource) continue;

    for (const action of target.actions(resource, { bundle: PROBE, scope, options })) {
      const kinds = paths.get(action.path) ?? [];
      if (!kinds.includes(kind)) kinds.push(kind);
      paths.set(action.path, kinds);
    }
  }

  return paths;
}

/**
 * A resource that exists only to be asked "where would you go?".
 *
 * Assets are left out: mapping one reads the file it ships, and there is
 * nothing to read here. They land in a per-harness directory in every target,
 * so there is no overlap to miss.
 */
function probeResource(kind: ResourceKind): BundleResource | undefined {
  if (kind === 'asset') return undefined;

  const base: BundleResource = {
    kind,
    name: PROBE,
    bundlePath: `${kind}/${PROBE}`,
    primaryFile: '',
    files: [],
    frontmatter: { description: 'probe' },
    body: '',
  };

  switch (kind) {
    // Only SKILL.md, which is rendered rather than copied -- any other file
    // would have to be read off disk.
    case 'skill':
      return { ...base, files: [{ absolutePath: '', relativePath: 'SKILL.md' }] };
    case 'mcp':
      return { ...base, data: { command: PROBE } };
    // One leaf, so the settings mapping produces one write rather than none.
    case 'settings':
      return { ...base, data: { [PROBE]: true } };
    default:
      return base;
  }
}

/**
 * The shared-file warnings for one harness's writes.
 *
 * `paths` are as that harness spells them -- plan action paths, or receipt
 * paths, both of which are relative to its own scope root.
 */
export function sharedFileNotices(params: {
  target: TargetId;
  paths: readonly string[];
  scope: Scope;
  cwd: string;
  /** Harnesses set up in this folder. Anything else is not worth mentioning. */
  present: readonly TargetId[];
  options?: TargetOptions;
}): SharedFileNotice[] {
  const others = params.present.filter((id) => id !== params.target);
  if (others.length === 0) return [];

  const shared = sharedFiles(
    [params.target, ...others],
    params.scope,
    params.cwd,
    params.options ?? {},
  );
  if (shared.length === 0) return [];

  const root = getTarget(params.target).scopeRoot(params.scope, params.cwd);
  const notices = new Map<string, SharedFileNotice>();

  for (const path of params.paths) {
    const key = fromPosix(root, path).toLowerCase();
    const file = shared.find((candidate) => candidate.key === key);
    if (!file) continue;

    const readers = file.readers
      .map((reader) => reader.target)
      .filter((id) => id !== params.target);
    if (readers.length === 0) continue;

    notices.set(path, { path, others: [...new Set(readers)] });
  }

  return [...notices.values()];
}

/** "Pi", or "Pi and OpenCode" -- the harnesses on the other side of a file. */
export function describeReaders(targets: readonly TargetId[]): string {
  const titles = targets.map((id) => getTarget(id).title);
  if (titles.length <= 1) return titles.join('');
  return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
}

/** Every overlap that exists at a scope, for `hcm targets`. */
export function allSharedFiles(scope: Scope, cwd: string): SharedFile[] {
  return sharedFiles(TARGET_IDS, scope, cwd);
}
