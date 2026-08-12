/**
 * The context cache.
 *
 * `context/` resources are the one kind that lands in a file the harness's own
 * agent edits: `CLAUDE.md`, `AGENTS.md`, `REASONIX.md`. When an agent rewrites
 * one of those to record what it has learned about the project, the marker
 * blocks -- and the instructions inside them -- can go with it.
 *
 * Rollback receipts cannot help: a block receipt says *where* a section was,
 * not what it said. Re-reading the bundle can, but that needs the registry, the
 * store, and possibly the network, none of which are around when you just want
 * your instructions back.
 *
 * So every install also drops a copy of each context section under `.hcm`,
 * together with a ledger of which file each one belongs in. `hcm context
 * append|override|remove` then works entirely from that copy.
 *
 *   .hcm/context.json              the ledger
 *   .hcm/context/<bundle>/<name>.md   one section, body only
 */

import path from 'node:path';
import {
  fromPosix,
  pruneEmptyDirs,
  readJsonIfExists,
  readTextIfExists,
  removeDirIfEmpty,
  removeFile,
  writeJson,
  writeText,
} from './fsx.js';
import { sha256 } from './hash.js';
import { contextCacheDir, contextLedgerFile } from './paths.js';
import { mutateInstallations, setBlockReceipt } from './state.js';
import {
  type ContextLedger,
  type ContextPlacement,
  type ContextSection,
  installationId,
  type LoadedBundle,
  type PlanAction,
  type Scope,
  type TargetId,
} from './types.js';
import {
  hasBlock,
  isEffectivelyEmpty,
  keepOnlyBlocks,
  removeBlock,
  upsertBlock,
} from '../merge/blocks.js';
import { getTarget } from '../targets/index.js';

const EMPTY: ContextLedger = { version: 1, sections: [] };

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export async function readContextLedger(scope: Scope, cwd: string): Promise<ContextLedger> {
  const ledger = await readJsonIfExists<ContextLedger>(contextLedgerFile(scope, cwd));
  if (!ledger || !Array.isArray(ledger.sections)) return { ...EMPTY, sections: [] };
  return ledger;
}

export async function writeContextLedger(
  scope: Scope,
  cwd: string,
  ledger: ContextLedger,
): Promise<void> {
  await writeJson(contextLedgerFile(scope, cwd), ledger);
}

/** Sections in the order they should appear: by bundle, then by bundle order. */
function sortSections(sections: ContextSection[]): ContextSection[] {
  return [...sections].sort(
    (a, b) =>
      a.bundle.localeCompare(b.bundle) || a.order - b.order || a.name.localeCompare(b.name),
  );
}

/** Bundle and section names come from filenames, but need not be path-safe. */
function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
}

// ---------------------------------------------------------------------------
// Capture, on the way in
// ---------------------------------------------------------------------------

/**
 * Remember the context sections a plan just wrote. Called after the install so
 * the cache only ever holds sections that really landed somewhere.
 *
 * Re-installing overwrites the cached copy, which is what makes `hcm update`
 * refresh the sections rather than pin them to whatever shipped first.
 */
export async function captureContext(
  bundle: LoadedBundle,
  targetId: TargetId,
  scope: Scope,
  cwd: string,
  actions: PlanAction[],
): Promise<number> {
  const contextResources = bundle.resources.filter((resource) => resource.kind === 'context');
  const order = new Map(contextResources.map((resource, index) => [resource.name, index]));

  // Every target files context as a markdown block today, and the operations
  // below assume it. A target that filed one somewhere else would need its own
  // excision rules, so leave it untracked rather than edit it with the wrong ones.
  const written = actions.filter(
    (action) =>
      action.resource?.kind === 'context' &&
      action.payload.kind === 'block' &&
      action.payload.syntax === 'markdown',
  );
  if (written.length === 0) return 0;

  const ledger = await readContextLedger(scope, cwd);
  const cacheRoot = contextCacheDir(scope, cwd);
  const now = new Date().toISOString();
  const bundleName = bundle.manifest.name;

  for (const action of written) {
    if (action.payload.kind !== 'block') continue;
    const name = action.resource?.name ?? action.payload.blockId;
    const body = action.payload.body;
    const file = `${safeName(bundleName)}/${safeName(name)}.md`;

    await writeText(fromPosix(cacheRoot, file), body.endsWith('\n') ? body : `${body}\n`);

    const placement: ContextPlacement = {
      target: targetId,
      path: action.path,
      blockId: action.payload.blockId,
      updatedAt: now,
    };

    const existing = ledger.sections.find(
      (section) => section.bundle === bundleName && section.name === name,
    );

    if (!existing) {
      ledger.sections.push({
        bundle: bundleName,
        name,
        order: order.get(name) ?? ledger.sections.length,
        file,
        hash: sha256(body),
        capturedAt: now,
        placements: [placement],
      });
      continue;
    }

    existing.order = order.get(name) ?? existing.order;
    existing.file = file;
    existing.hash = sha256(body);
    existing.capturedAt = now;
    existing.placements = [
      ...existing.placements.filter(
        (candidate) => !(candidate.target === targetId && candidate.path === action.path),
      ),
      placement,
    ];
  }

  ledger.sections = sortSections(ledger.sections);
  await writeContextLedger(scope, cwd, ledger);
  return written.length;
}

/**
 * Forget what a bundle contributed to one target, after an uninstall has taken
 * the blocks away. A section left with no placements at all is dropped, and its
 * cached copy with it -- nothing would ever put it back.
 */
export async function forgetContext(
  bundleName: string,
  targetId: TargetId,
  scope: Scope,
  cwd: string,
): Promise<void> {
  const ledger = await readContextLedger(scope, cwd);
  if (ledger.sections.length === 0) return;

  const cacheRoot = contextCacheDir(scope, cwd);
  const keep: ContextSection[] = [];
  let changed = false;

  for (const section of ledger.sections) {
    if (section.bundle !== bundleName) {
      keep.push(section);
      continue;
    }

    const placements = section.placements.filter((placement) => placement.target !== targetId);
    if (placements.length === section.placements.length) {
      keep.push(section);
      continue;
    }

    changed = true;
    if (placements.length > 0) {
      keep.push({ ...section, placements });
      continue;
    }

    const cached = fromPosix(cacheRoot, section.file);
    await removeFile(cached);
    await pruneEmptyDirs(path.dirname(cached), cacheRoot);
  }

  if (!changed) return;

  ledger.sections = keep;
  await writeContextLedger(scope, cwd, ledger);
  if (keep.length === 0) {
    await removeFile(contextLedgerFile(scope, cwd));
    await removeDirIfEmpty(cacheRoot);
  }
}

// ---------------------------------------------------------------------------
// Reading it back out
// ---------------------------------------------------------------------------

export interface ContextItem {
  section: ContextSection;
  placement: ContextPlacement;
  /**
   * Every target this one block belongs to. Usually one, but OpenCode and Pi
   * share `AGENTS.md`, and the block written there answers to both -- so both
   * installations' receipts have to move together when it comes or goes.
   */
  targets: TargetId[];
  /** The cached body, or undefined when the copy has gone missing. */
  body?: string;
}

/** Every section that belongs in one instruction file, in the order it belongs. */
export interface ContextFile {
  /** The target whose mapping named this file; see `targets` for all of them. */
  target: TargetId;
  targets: TargetId[];
  scope: Scope;
  /** Scope-root-relative POSIX path. */
  path: string;
  /** The root that `path` is relative to; nothing above it is ever pruned. */
  scopeRoot: string;
  absolutePath: string;
  items: ContextItem[];
}

export interface ContextSelection {
  /** Bundle names; empty or absent means every tracked bundle. */
  bundles?: string[];
  targets?: TargetId[];
}

/**
 * Group the cached sections by the file they live in. Two targets writing the
 * same `AGENTS.md` share one group, so a section is never written twice.
 */
export async function contextFiles(
  scope: Scope,
  cwd: string,
  selection: ContextSelection = {},
): Promise<ContextFile[]> {
  const ledger = await readContextLedger(scope, cwd);
  const cacheRoot = contextCacheDir(scope, cwd);
  const wantedBundles = selection.bundles?.length ? new Set(selection.bundles) : undefined;
  const wantedTargets = selection.targets?.length ? new Set(selection.targets) : undefined;

  const groups = new Map<string, ContextFile>();

  for (const section of sortSections(ledger.sections)) {
    if (wantedBundles && !wantedBundles.has(section.bundle)) continue;

    const body = await readTextIfExists(fromPosix(cacheRoot, section.file));

    for (const placement of section.placements) {
      if (wantedTargets && !wantedTargets.has(placement.target)) continue;

      const scopeRoot = getTarget(placement.target).scopeRoot(scope, cwd);
      const absolutePath = fromPosix(scopeRoot, placement.path);
      const key = absolutePath.toLowerCase();

      let group = groups.get(key);
      if (!group) {
        group = {
          target: placement.target,
          targets: [],
          scope,
          path: placement.path,
          scopeRoot,
          absolutePath,
          items: [],
        };
        groups.set(key, group);
      }
      if (!group.targets.includes(placement.target)) group.targets.push(placement.target);

      // The same section can reach one file through two targets (OpenCode and
      // Pi both write AGENTS.md); it is still one block, owned by both.
      const already = group.items.find((item) => item.placement.blockId === placement.blockId);
      if (already) {
        if (!already.targets.includes(placement.target)) already.targets.push(placement.target);
        continue;
      }

      group.items.push({
        section,
        placement,
        targets: [placement.target],
        ...(body === undefined ? {} : { body }),
      });
    }
  }

  return [...groups.values()];
}

/** The bundles that have cached context in a scope. */
export async function trackedBundles(scope: Scope, cwd: string): Promise<string[]> {
  const ledger = await readContextLedger(scope, cwd);
  return [...new Set(ledger.sections.map((section) => section.bundle))].sort();
}

// ---------------------------------------------------------------------------
// The three operations
// ---------------------------------------------------------------------------

export type ContextOutcome =
  /** Was not there, and now is. */
  | 'appended'
  /** Was there, and was written again from the cache. */
  | 'rewritten'
  /** Its marker block is already in the file; left alone. */
  | 'present'
  /** No marker, but the text is there verbatim; left alone rather than doubled. */
  | 'unmarked'
  | 'removed'
  /** Nothing to remove, or nothing cached to write. */
  | 'missing';

export interface ContextItemResult {
  item: ContextItem;
  outcome: ContextOutcome;
}

export interface ContextFileResult {
  file: ContextFile;
  results: ContextItemResult[];
  changed: boolean;
  /** Non-blank lines of foreign content `override` dropped. */
  discardedLines?: number;
  /** The file held nothing else and was deleted. */
  deleted?: boolean;
}

export interface ContextApplyOptions {
  dryRun?: boolean;
  /** Write every section, without first checking whether it is already there. */
  force?: boolean;
}

/**
 * Put back whatever is missing.
 *
 * A section already inside its marker block is left exactly as it is, edits and
 * all -- hcm does not overwrite what somebody has since improved. `--force`
 * says to write them all from the cache regardless, which is also how you undo
 * an agent's edit to the text inside the markers.
 */
export async function appendContext(
  file: ContextFile,
  options: ContextApplyOptions = {},
): Promise<ContextFileResult> {
  const original = (await readTextIfExists(file.absolutePath)) ?? '';
  let content = original;
  const results: ContextItemResult[] = [];

  for (const item of file.items) {
    if (item.body === undefined) {
      results.push({ item, outcome: 'missing' });
      continue;
    }

    const present = hasBlock(content, 'markdown', item.placement.blockId);

    if (!options.force) {
      if (present) {
        results.push({ item, outcome: 'present' });
        continue;
      }
      if (containsBody(content, item.body)) {
        results.push({ item, outcome: 'unmarked' });
        continue;
      }
    }

    content = upsertBlock(content, 'markdown', item.placement.blockId, item.body);
    results.push({ item, outcome: present ? 'rewritten' : 'appended' });
  }

  const changed = content !== original;
  if (changed && !options.dryRun) await writeText(file.absolutePath, content);

  return { file, results, changed };
}

/**
 * Clear the file and lay the sections down in order.
 *
 * Everything hcm did not write is discarded -- that is the point: an agent's
 * rewrite is exactly what you are throwing away. Blocks belonging to other
 * bundles, or to rules rather than context, are kept and moved below the
 * sections, because they have receipts of their own and losing them would only
 * make `hcm status` report damage.
 */
export async function overrideContext(
  file: ContextFile,
  options: ContextApplyOptions = {},
): Promise<ContextFileResult> {
  const original = (await readTextIfExists(file.absolutePath)) ?? '';
  const { blocks, discardedLines } = keepOnlyBlocks(original, 'markdown');

  const ours = new Set(file.items.map((item) => item.placement.blockId));
  const results: ContextItemResult[] = [];

  let content = '';
  for (const item of file.items) {
    if (item.body === undefined) {
      results.push({ item, outcome: 'missing' });
      // Anything we cannot rewrite has to survive as it stands, or override
      // would quietly delete a section it has no copy of.
      const stranded = blocks.find((block) => block.id === item.placement.blockId);
      if (stranded) content = `${content}${stranded.text}\n\n`;
      continue;
    }
    const present = blocks.some((block) => block.id === item.placement.blockId);
    content = upsertBlock(content, 'markdown', item.placement.blockId, item.body);
    results.push({ item, outcome: present ? 'rewritten' : 'appended' });
  }

  for (const block of blocks) {
    if (ours.has(block.id)) continue;
    content = content === '' ? `${block.text}\n` : `${content.replace(/\s*$/, '')}\n\n${block.text}\n`;
  }

  const changed = content !== original;
  const deleted = changed && isEffectivelyEmpty(content);

  if (changed && !options.dryRun) {
    if (deleted) await deleteInstructionFile(file);
    else await writeText(file.absolutePath, content);
  }

  return { file, results, changed, discardedLines, ...(deleted ? { deleted: true } : {}) };
}

/**
 * Take the sections out again, leaving everything else -- including a file the
 * user wrote and we only appended to. A file left holding nothing goes too,
 * which is what `hcm uninstall` does with the same blocks.
 */
export async function removeContext(
  file: ContextFile,
  options: ContextApplyOptions = {},
): Promise<ContextFileResult> {
  const original = await readTextIfExists(file.absolutePath);

  if (original === undefined) {
    return {
      file,
      results: file.items.map((item) => ({ item, outcome: 'missing' as const })),
      changed: false,
    };
  }

  let content = original;
  const results: ContextItemResult[] = [];

  for (const item of file.items) {
    const next = removeBlock(content, 'markdown', item.placement.blockId);
    if (next === undefined) {
      results.push({ item, outcome: 'missing' });
      continue;
    }
    content = next;
    results.push({ item, outcome: 'removed' });
  }

  const changed = content !== original;
  const deleted = changed && isEffectivelyEmpty(content);

  if (changed && !options.dryRun) {
    if (deleted) await deleteInstructionFile(file);
    else await writeText(file.absolutePath, content);
  }

  return { file, results, changed, ...(deleted ? { deleted: true } : {}) };
}

/** Take away a file we emptied, and any directory we emptied along with it. */
async function deleteInstructionFile(file: ContextFile): Promise<void> {
  await removeFile(file.absolutePath);
  await pruneEmptyDirs(path.dirname(file.absolutePath), file.scopeRoot);
}

/**
 * Bring the install receipts back in line with what is now in the file, so
 * `hcm status` neither reports a block we deliberately removed as damage nor
 * stays quiet about one we just put back.
 *
 * Only outcomes that settle the question are acted on. `missing` means we had
 * nothing to write and looked no further; `unmarked` means the markers really
 * are gone, which is drift `hcm status` should keep reporting.
 */
const RECEIPT_PRESENCE: Partial<Record<ContextOutcome, boolean>> = {
  appended: true,
  rewritten: true,
  present: true,
  removed: false,
};

export async function syncBlockReceipts(
  scope: Scope,
  cwd: string,
  results: ContextFileResult[],
): Promise<void> {
  const changes = results.flatMap((result) =>
    result.results
      .filter(({ outcome }) => RECEIPT_PRESENCE[outcome] !== undefined)
      .flatMap(({ item, outcome }) =>
        item.targets.map((target) => ({
          id: installationId(item.section.bundle, target, scope),
          block: { path: item.placement.path, blockId: item.placement.blockId },
          present: RECEIPT_PRESENCE[outcome] as boolean,
        })),
      ),
  );
  if (changes.length === 0) return;

  await mutateInstallations(scope, cwd, (installations) => {
    let changed = false;
    for (const change of changes) {
      if (setBlockReceipt(installations, change.id, change.block, change.present)) changed = true;
    }
    return changed;
  });
}

/** Record that a section has just been written where the ledger says it goes. */
export async function touchPlacements(
  scope: Scope,
  cwd: string,
  results: ContextFileResult[],
): Promise<void> {
  const written = new Set<string>();
  for (const result of results) {
    for (const { item, outcome } of result.results) {
      if (outcome === 'appended' || outcome === 'rewritten') {
        written.add(`${item.section.bundle} ${item.section.name} ${item.placement.blockId}`);
      }
    }
  }
  if (written.size === 0) return;

  const ledger = await readContextLedger(scope, cwd);
  const now = new Date().toISOString();
  let changed = false;

  for (const section of ledger.sections) {
    for (const placement of section.placements) {
      if (!written.has(`${section.bundle} ${section.name} ${placement.blockId}`)) continue;
      placement.updatedAt = now;
      changed = true;
    }
  }

  if (changed) await writeContextLedger(scope, cwd, ledger);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export type ContextPresence = 'present' | 'unmarked' | 'absent';

/** What the file says about a section right now, ignoring the ledger. */
export async function inspectContext(
  file: ContextFile,
): Promise<{ item: ContextItem; presence: ContextPresence }[]> {
  const content = (await readTextIfExists(file.absolutePath)) ?? '';
  return file.items.map((item) => ({
    item,
    presence: hasBlock(content, 'markdown', item.placement.blockId)
      ? 'present'
      : item.body !== undefined && containsBody(content, item.body)
        ? 'unmarked'
        : 'absent',
  }));
}

/**
 * True when the section's text is in the file without our markers around it --
 * an agent that rewrote the file but kept what it found. Appending again would
 * only say the same thing twice.
 *
 * The comparison ignores blank lines and trailing spaces, and very short
 * sections are not tested at all: "## Conventions" appearing somewhere is no
 * evidence that the section survived.
 */
function containsBody(content: string, body: string): boolean {
  const needle = normaliseProse(body);
  if (needle.length < 40) return false;
  return normaliseProse(content).includes(needle);
}

function normaliseProse(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim();
}

/** Where the cached copy of a section lives on disk. */
export function cachedSectionPath(scope: Scope, cwd: string, section: ContextSection): string {
  return fromPosix(contextCacheDir(scope, cwd), section.file);
}
