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
import { isInteractive, multiSelect } from './prompt.js';
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
// Asking instead of assuming
// ---------------------------------------------------------------------------

/**
 * What a command needs answered when it was not told which harness to act on.
 *
 * `available` is what is worth offering -- the harnesses the bundles in this
 * run actually support, not all five. `preselected` is what the menu opens
 * with ticked and what an empty answer takes. `here` is the subset of those
 * this folder is already set up for, which is only there so the menu can say
 * why a line came ticked.
 */
export interface TargetQuestion {
  available: TargetId[];
  preselected: TargetId[];
  here: TargetId[];
}

/** Answers a `TargetQuestion`. The terminal does it; tests supply their own. */
export type TargetChooser = (question: TargetQuestion) => Promise<TargetId[]>;

/**
 * The harnesses this folder is already committed to, in `available` order.
 *
 * The ledger first: a harness hcm has installed into here is one the user has
 * decided about, and re-running `hcm install` almost always means "the same
 * places as last time". Only when nothing has been installed yet does harness
 * *presence* stand in for it -- a folder with a `.claude/` directory and an
 * empty ledger is a Claude Code folder, whoever created that directory.
 */
export async function initializedTargets(
  scope: Scope,
  cwd: string,
  available: readonly TargetId[],
): Promise<TargetId[]> {
  const offered = new Set(available);

  const state = await readState(scope, cwd);
  const installed = new Set(
    state.installations.map((record) => record.target).filter((id) => offered.has(id)),
  );
  if (installed.size > 0) return available.filter((id) => installed.has(id));

  const found = await detectHarnesses(scope, cwd);
  const present = new Set(found.map((harness) => harness.target));
  return available.filter((id) => present.has(id));
}

/**
 * Settle which harnesses to install into when `-t` did not say.
 *
 * The old answer was "every one of them", which is right in a folder that uses
 * one harness and wrong in a folder that uses three -- and `requireTargetChoice`
 * could only refuse the command, which is a poor thing to do to someone who is
 * sitting at a terminal and can simply be asked. So ask, with what the folder
 * is already set up for ticked.
 *
 * Returns undefined when there was no question to ask -- one harness on offer,
 * no terminal, `--no-prompt` -- and the caller carries on with the behaviour it
 * had before, `requireTargetChoice` gate included.
 */
export async function chooseTargets(options: {
  available: readonly TargetId[];
  scope: Scope;
  cwd: string;
  chooser?: TargetChooser;
  /** False never asks, however interactive the terminal is. */
  prompt?: boolean;
}): Promise<TargetId[] | undefined> {
  const available = [...options.available];
  if (available.length < 2) return undefined;

  // Checked before the chooser rather than alongside it: --no-prompt means no
  // question is asked, whoever would have answered it.
  if (options.prompt === false) return undefined;

  const chooser = options.chooser ?? (isInteractive() ? promptForTargets : undefined);
  if (!chooser) return undefined;

  const here = await initializedTargets(options.scope, options.cwd, available);
  const picked = await chooser({
    available,
    // A folder that is set up for nothing yet has no answer to give, so the
    // menu opens on the historical default -- every harness -- ticked and
    // visible rather than applied behind the user's back.
    preselected: here.length > 0 ? here : available,
    here,
  });

  // An empty answer is not a narrowing to nothing; it means the question did
  // not settle anything, and the caller's own default stands.
  return picked.length > 0 ? [...new Set(picked)] : undefined;
}

/** The terminal's answer: a ticked menu of the harnesses on offer. */
export const promptForTargets: TargetChooser = (question) =>
  multiSelect(
    'Which harness(es) should this install into?',
    question.available.map((id) => ({
      value: id,
      label: getTarget(id).title,
      ...(question.here.includes(id) ? { detail: 'already set up in this folder' } : {}),
    })),
    question.preselected,
  );

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
