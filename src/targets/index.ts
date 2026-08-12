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

export function getTarget(id: string): Target {
  const target = TARGETS.find((candidate) => candidate.id === id);
  if (!target) {
    throw new HcmError(`Unknown target "${id}"`, `Known targets: ${TARGET_IDS.join(', ')}`);
  }
  return target;
}

export type { Target } from './types.js';
