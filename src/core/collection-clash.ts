/**
 * Clashes between collection names in the registry.
 *
 * A collection name groups registered bundles, so that
 * `hcm registry remove --collection <name>` removes all of them. That is only
 * safe while one name means one group. A registration that asks for a name
 * that bundles of a *different* source already use is a clash, and the user
 * decides:
 *
 *   join    put the new bundles in the existing collection
 *   rename  put them in a collection with another name -- `<name>-2` unless
 *           the user types one. Recorded, so a later registration from the
 *           same source gets the same name without a question.
 *   abort   register nothing
 *
 * It is not a clash when:
 *   - the source already has bundles in the collection (it joined before),
 *   - the sources differ only in the ref (`acme/kits#v1`, `acme/kits#v2`),
 *   - one source is inside the other (`./kits` and `./kits/alpha`),
 *   - the only bundles in the way are the ones that this registration replaces.
 *
 * The decision is made before anything is written.
 */

import path from 'node:path';
import { isUsableCollectionName } from './collection.js';
import { AbortedError, HcmError } from './errors.js';
import { describeSource } from './github.js';
import { color, log } from './logger.js';
import { isInteractive, select, text } from './prompt.js';
import type { BundleSource, CollectionMembership, RegistryEntry } from './types.js';

/** What to do about a clash. `prompt` asks at a terminal, and stops without one. */
export type CollectionClashPolicy = 'prompt' | 'join' | 'rename' | 'abort';

export const COLLECTION_CLASH_POLICIES: readonly CollectionClashPolicy[] = [
  'prompt',
  'join',
  'rename',
  'abort',
];

export type CollectionClashChoice = 'join' | 'rename' | 'abort';

export interface CollectionClashResolution {
  choice: CollectionClashChoice;
  /** The new collection name. Required for `rename`. */
  name?: string;
}

/** One clash, as put to the user. */
export interface CollectionClash {
  /** The collection name that the registration asks for. */
  requested: string;
  /** The name as the registry has it, which can differ in case. */
  existing: string;
  /** The source of the registration. */
  source: BundleSource;
  /** The registered bundles that hold the name, from other sources. */
  holders: RegistryEntry[];
  /** A free name for `rename`. */
  suggestedName: string;
  /** Why a typed name cannot be used, or undefined when it can. */
  problemWith: (name: string) => string | undefined;
}

export type CollectionClashResolver = (clash: CollectionClash) => Promise<CollectionClashResolution>;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** A source as a path-like key, without the ref. Case is ignored where the host ignores it. */
function sourceParts(source: BundleSource): { root: string; subdir: string } {
  const trimSlashes = (value: string) => value.replace(/^\/+|\/+$/g, '');

  if (source.type === 'local') {
    const resolved = path.resolve(source.path);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    return { root: 'local', subdir: trimSlashes(key.split(path.sep).join('/')) };
  }
  if (source.type === 'github') {
    return {
      root: `github:${source.owner}/${source.repo}`.toLowerCase(),
      subdir: trimSlashes(source.subdir ?? ''),
    };
  }
  const url = source.url.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  return { root: `git:${url}`, subdir: trimSlashes(source.subdir ?? '') };
}

/** True when `inner` is `outer`, or a folder inside it. The ref is ignored. */
function isWithin(inner: BundleSource, outer: BundleSource): boolean {
  const a = sourceParts(inner);
  const b = sourceParts(outer);
  if (a.root !== b.root) return false;
  return b.subdir === '' || a.subdir === b.subdir || a.subdir.startsWith(`${b.subdir}/`);
}

/** True when two sources are the same, or one is inside the other. */
export function sameCollectionSource(a: BundleSource, b: BundleSource): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The bundles that hold `name` for another source, or none when the
 * registration is free to use the name. `replacing` holds the names of the
 * bundles that the registration writes, which are about to change anyway.
 */
export function findCollectionClash(
  entries: readonly RegistryEntry[],
  name: string,
  source: BundleSource,
  replacing: ReadonlySet<string>,
): RegistryEntry[] {
  const members = entries.filter(
    (entry) => entry.collection && sameName(entry.collection.name, name),
  );

  // A source with a bundle in the collection already joined it.
  if (members.some((entry) => sameCollectionSource(entry.collection!.source, source))) return [];

  return members.filter((entry) => !replacing.has(entry.name));
}

/** The first `<name>-<n>` that no registered bundle uses as its collection name. */
export function suggestCollectionName(name: string, entries: readonly RegistryEntry[]): string {
  const taken = new Set(
    entries.flatMap((entry) => (entry.collection ? [entry.collection.name.toLowerCase()] : [])),
  );
  for (let n = 2; ; n += 1) {
    const candidate = `${name}-${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface MembershipRequest {
  /** The collection name that the registration asks for. */
  requested: string;
  /** The source of the registration. */
  source: BundleSource;
  /** The registry as it is now. */
  entries: readonly RegistryEntry[];
  /** The names of the bundles that the registration writes. */
  replacing: ReadonlySet<string>;
  policy?: CollectionClashPolicy;
  /** Replaces the prompt and the policy. For tests. */
  resolver?: CollectionClashResolver;
}

/**
 * The collection that the bundles of a registration go into. Asks, or applies
 * the policy, when the requested name clashes. Throws when the user aborts,
 * or when there is a clash and nobody to ask.
 */
export async function resolveMembership(request: MembershipRequest): Promise<CollectionMembership> {
  const { requested, source, entries, replacing } = request;

  // An earlier rename for this source and this request still applies.
  const renamed = entries.find(
    (entry) =>
      entry.collection?.requested !== undefined &&
      sameName(entry.collection.requested, requested) &&
      sameCollectionSource(entry.collection.source, source),
  )?.collection;
  if (renamed) return { name: renamed.name, source, requested: renamed.requested };

  const holders = findCollectionClash(entries, requested, source, replacing);
  if (holders.length === 0) return { name: requested, source };

  const clash: CollectionClash = {
    requested,
    existing: holders[0]!.collection!.name,
    source,
    holders,
    suggestedName: suggestCollectionName(requested, entries),
    problemWith: (name) => problemWithName(name, source, entries, replacing),
  };

  const resolution = await pickResolver(request, clash)(clash);

  if (resolution.choice === 'abort') {
    throw new AbortedError(`Aborted: the collection name "${requested}" is in use`);
  }

  if (resolution.choice === 'join') {
    log.info(color.dim(`Joined the collection "${clash.existing}" (${describeHolders(holders)}).`));
    return { name: clash.existing, source };
  }

  const name = resolution.name ?? clash.suggestedName;
  const problem = clash.problemWith(name);
  if (problem) throw new HcmError(`Cannot use the collection name "${name}": ${problem}`);

  log.info(
    color.dim(`Registered in the collection "${name}", because "${requested}" is in use.`),
  );
  return { name, source, requested };
}

/** Why a new collection name cannot be used, or undefined when it can. */
function problemWithName(
  name: string,
  source: BundleSource,
  entries: readonly RegistryEntry[],
  replacing: ReadonlySet<string>,
): string | undefined {
  if (!isUsableCollectionName(name)) {
    return 'use letters, digits, dots, dashes and underscores, and start with a letter or a digit';
  }
  const holders = findCollectionClash(entries, name, source, replacing);
  if (holders.length > 0) return `it is in use too (${describeHolders(holders)})`;
  return undefined;
}

/** "2 bundles from C:\kits: alpha, beta" -- one part for each source. */
export function describeHolders(holders: readonly RegistryEntry[]): string {
  const bySource = new Map<string, string[]>();
  for (const entry of holders) {
    const where = describeSource(entry.collection!.source);
    bySource.set(where, [...(bySource.get(where) ?? []), entry.name]);
  }
  return [...bySource]
    .map(([where, names]) => `${names.length === 1 ? 'bundle' : 'bundles'} ${names.join(', ')} from ${where}`)
    .join('; ');
}

function pickResolver(request: MembershipRequest, clash: CollectionClash): CollectionClashResolver {
  if (request.resolver) return request.resolver;

  const policy = request.policy ?? 'prompt';
  if (policy === 'prompt' && isInteractive()) return promptResolver;
  if (policy === 'join' || policy === 'rename') return async () => ({ choice: policy });

  throw new HcmError(
    `The collection name "${clash.requested}" is in use by ${describeHolders(clash.holders)}`,
    'Run the command at a terminal to choose, or give --on-collection-clash join|rename|abort. ' +
      'Nothing was registered.',
  );
}

/** Ask the user at the terminal. */
export const promptResolver: CollectionClashResolver = async (clash) => {
  log.plain('');
  log.warn(
    `The collection name "${clash.requested}" is in use by ${describeHolders(clash.holders)}.`,
  );

  const choice = await select<CollectionClashChoice>(
    `What do you want to do with the bundles from ${describeSource(clash.source)}?`,
    [
      {
        value: 'join',
        label: 'join',
        detail: `put them in "${clash.existing}" too; removing the collection then removes both groups`,
      },
      {
        value: 'rename',
        label: 'rename',
        detail: `put them in a collection with another name, for example "${clash.suggestedName}"`,
      },
      { value: 'abort', label: 'abort', detail: 'register nothing' },
    ],
    'rename',
  );

  if (choice !== 'rename') return { choice };

  const answer = await text(`collection name ${color.dim(`[${clash.suggestedName}]`)}`, (value) =>
    value === '' ? undefined : clash.problemWith(value),
  );
  return { choice, name: answer === '' ? clash.suggestedName : answer };
};
