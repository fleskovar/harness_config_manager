import { HcmError } from '../core/errors.js';
import type { TargetId } from '../core/types.js';
import { claudeCode } from './claude-code.js';
import { copilot } from './copilot.js';
import { opencode } from './opencode.js';
import { pi } from './pi.js';
import { reasonix } from './reasonix.js';
import type { Target } from './types.js';

export const TARGETS: Target[] = [claudeCode, copilot, reasonix, opencode, pi];

export const TARGET_IDS: TargetId[] = TARGETS.map((target) => target.id);

/**
 * Names for a harness that are not its id.
 *
 * Ids are what the ledger records and what `hcm targets` prints, so they stay
 * exactly as they are -- but nobody wants to type `claude-code` five times on
 * one command line. Only names that could not mean anything else are here;
 * everything else is left to the prefix matching below, which grows a new
 * shorthand for free whenever a harness is added.
 */
const TARGET_ALIASES: Record<string, TargetId> = {
  claude: 'claude-code',
  cc: 'claude-code',
  gh: 'copilot',
  'github-copilot': 'copilot',
  oc: 'opencode',
};

/**
 * Turn whatever the user typed into a target id.
 *
 * Exact ids first, then the aliases, then any unambiguous prefix -- so `-t
 * claude pi`, `-t reason op` and `-t claude-code` all say what they look like
 * they say. A prefix matching two harnesses is an error naming both rather
 * than a guess: `-t c` could be Claude Code or Copilot, and picking one would
 * write a bundle into the wrong harness.
 */
export function resolveTargetId(value: string): TargetId {
  const wanted = value.trim().toLowerCase();

  const exact = TARGET_IDS.find((id) => id === wanted);
  if (exact) return exact;

  const alias = TARGET_ALIASES[wanted];
  if (alias) return alias;

  const prefixed = TARGET_IDS.filter((id) => id.startsWith(wanted));
  if (prefixed.length === 1) return prefixed[0] as TargetId;

  if (prefixed.length > 1) {
    throw new HcmError(
      `"${value}" matches more than one harness: ${prefixed.join(', ')}`,
      'Type enough of the name to tell them apart.',
    );
  }

  throw new HcmError(
    `Unknown target "${value}"`,
    `Known targets: ${TARGET_IDS.join(', ')}, or "all".\n` +
      'If that was meant to be a bundle, note that bundle names come before ' +
      '--target, which takes every value after it.',
  );
}

/**
 * The adapter for a target. Accepts the same shorthands `resolveTargetId` does,
 * so a name from the command line and an id from the ledger both work here.
 */
export function getTarget(id: string): Target {
  const resolved = resolveTargetId(id);
  return TARGETS.find((candidate) => candidate.id === resolved) as Target;
}

export type { Target } from './types.js';
