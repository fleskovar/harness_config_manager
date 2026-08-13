/**
 * Which harnesses is this folder actually used by, and does a command have to
 * say which one it means?
 *
 * A project folder is not one harness's. The same directory can hold
 * `.claude/`, `.reasonix/` and `.pi/` side by side, because the person working
 * in it uses all three. Everything hcm records is already per-target -- an
 * installation is keyed `bundle@target@scope` -- but the *commands* used to
 * assume otherwise: `hcm install my-kit` with no `-t` meant all five harnesses,
 * and `hcm uninstall my-kit` meant every one it could find.
 *
 * That default is fine in a folder set up for one harness and wrong in a folder
 * set up for three, where it silently touches harnesses the user was not
 * thinking about. So: work out which harnesses are here, and when an operation
 * would span more than one of them, make the user say which.
 *
 * Presence is read from two places, because either alone is incomplete:
 *
 *   markers  directories and files only that harness uses (`core/targets`
 *            declares them). This is what finds a harness hcm never installed
 *            into -- the usual case, since people set their harnesses up first.
 *   ledger   what hcm has installed here. This is what finds a harness whose
 *            own files have not been created yet.
 */

import { resolveRequireTarget } from './config.js';
import { HcmError } from './errors.js';
import { fromPosix, pathExists } from './fsx.js';
import { readState } from './state.js';
import type { Scope, TargetId } from './types.js';
import { getTarget, resolveTargetId, TARGET_IDS, TARGETS } from '../targets/index.js';

/** The word `-t` accepts for "every harness", the explicit form of the old default. */
export const ALL_TARGETS = 'all';

export interface HarnessPresence {
  target: TargetId;
  /** The harness's root for the scope this was detected at. */
  root: string;
  /** Scope-root-relative paths found on disk. Empty when only the ledger knew. */
  markers: string[];
  /** hcm has an installation recorded for this harness in this scope. */
  installed: boolean;
}

/**
 * The harnesses in use at `scope`, in the order `hcm targets` lists them.
 *
 * Only a harness with real evidence is included -- an empty project has none,
 * which is what keeps the ambiguity gate below quiet in a fresh checkout.
 */
export async function detectHarnesses(scope: Scope, cwd: string): Promise<HarnessPresence[]> {
  const state = await readState(scope, cwd);
  const installed = new Set(state.installations.map((record) => record.target));

  const found: HarnessPresence[] = [];

  for (const target of TARGETS) {
    const root = target.scopeRoot(scope, cwd);
    const markers: string[] = [];

    for (const marker of target.markers(scope)) {
      // `.` is the scope root itself: for a harness whose user-scope root is
      // its own config directory, the directory existing *is* the evidence.
      const candidate = marker === '.' ? root : fromPosix(root, marker);
      if (await pathExists(candidate)) markers.push(marker);
    }

    if (markers.length === 0 && !installed.has(target.id)) continue;
    found.push({ target: target.id, root, markers, installed: installed.has(target.id) });
  }

  return found;
}

/** "Claude Code, Pi and Reasonix" -- for messages about what was found. */
export function describeHarnesses(found: HarnessPresence[]): string {
  const titles = found.map((harness) => getTarget(harness.target).title);
  if (titles.length <= 1) return titles.join('');
  return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
}

/** Why hcm thinks a harness is here, for `hcm targets` and `hcm status`. */
export function describeEvidence(harness: HarnessPresence): string {
  const parts = [
    // `.` is the root itself, which is only informative spelled out.
    ...harness.markers.map((marker) => (marker === '.' ? harness.root : marker)),
    ...(harness.installed ? ['installed by hcm'] : []),
  ];
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Expanding what `-t` was given
// ---------------------------------------------------------------------------

/**
 * Turn the raw `-t` values into target ids: several harnesses at once, each
 * named by id, alias or unambiguous prefix, with `all` meaning every one.
 *
 *   -t pi                       -> [pi]
 *   -t claude pi                -> [claude-code, pi]
 *   -t all                      -> every harness
 *
 * `all` is how you ask for the blanket behaviour once the gate below starts
 * asking: it means the same thing as naming every harness, and it is recorded
 * as an answer rather than an absence of one.
 *
 * Duplicates are dropped rather than refused -- `-t pi -t pi` and `-t claude
 * claude-code` are the same request said twice, and installing twice into one
 * harness is not a thing anybody means.
 */
export function expandTargets(values: readonly string[] | undefined): TargetId[] | undefined {
  if (!values || values.length === 0) return undefined;
  if (values.includes(ALL_TARGETS)) return [...TARGET_IDS];
  // resolveTargetId rejects anything unknown, which is what makes this the one
  // place a target name has to be validated.
  return [...new Set(values.map((value) => resolveTargetId(value)))];
}

// ---------------------------------------------------------------------------
// The ambiguity gate
// ---------------------------------------------------------------------------

export interface TargetChoice {
  /** What `-t` said, expanded. Undefined means the user did not say. */
  chosen?: TargetId[];
  /** Every harness the command would touch if nothing narrowed it. */
  affected: TargetId[];
  /** The command line to put in the error, without the `-t` part. */
  command: string;
  scope: Scope;
  cwd: string;
}

/**
 * Refuse an operation that would silently span harnesses the user did not name.
 *
 * Deliberately narrow, so it never gets in the way of an unambiguous command:
 * it fires only when the folder is set up for more than one harness *and* this
 * particular operation would affect more than one. Uninstalling a bundle that
 * only ever went into Claude Code needs no `-t` however many harnesses are
 * configured alongside it.
 *
 * Returns the harnesses found, so callers can go on to report the file overlaps
 * between them without detecting twice.
 */
export async function requireTargetChoice(choice: TargetChoice): Promise<HarnessPresence[]> {
  const found = await detectHarnesses(choice.scope, choice.cwd);
  if (choice.chosen && choice.chosen.length > 0) return found;

  const policy = await resolveRequireTarget();
  if (policy === 'never') return found;
  if (policy === 'auto' && found.length < 2) return found;
  if (choice.affected.length < 2) return found;

  const affected = choice.affected.join(', ');
  const first = choice.affected[0] as TargetId;

  throw new HcmError(
    found.length > 1
      ? `This folder is set up for more than one harness (${describeHarnesses(found)}), ` +
          `so "${choice.command}" needs to be told which one to act on`
      : `"${choice.command}" would affect ${choice.affected.length} harnesses and ` +
          'requireTarget is set to "always"',
    [
      `It would otherwise affect: ${affected}`,
      `Name one or more:  ${choice.command} -t ${first}`,
      `Or every harness:  ${choice.command} -t ${ALL_TARGETS}`,
    ].join('\n'),
  );
}

/**
 * Installing into every harness in a folder that only uses one is not ambiguous
 * -- there is nothing to ask -- but it is almost certainly not what was meant,
 * so say what is about to happen rather than refusing it.
 */
export function warnIfWiderThanTheFolder(
  found: HarnessPresence[],
  chosen: TargetId[] | undefined,
  affected: TargetId[],
  command: string,
  warn: (message: string) => void,
): void {
  if (chosen && chosen.length > 0) return;
  if (found.length !== 1 || affected.length < 2) return;

  const only = found[0] as HarnessPresence;
  const title = getTarget(only.target).title;
  warn(
    `installing into ${affected.length} harnesses; only ${title} is set up in this folder ` +
      `-- "${command} -t ${only.target}" installs just there`,
  );
}
