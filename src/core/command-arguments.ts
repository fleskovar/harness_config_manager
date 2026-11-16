/**
 * Command arguments: the values a user gives each time a command runs.
 *
 * A command is a prompt template. Its body can name the text typed after the
 * command -- `$ARGUMENTS` for all of it, `$1`, `$2` for one word each:
 *
 *     # commands/migration-plan.md
 *     Write a migration plan for the `$1` module to version `$2`.
 *
 * hcm does not replace these. The harness replaces them each time the command
 * runs, and not every harness does it:
 *
 *   Claude Code, OpenCode, Reasonix, Pi   replace `$ARGUMENTS` and `$1`
 *   Copilot (IDE)                         uses `${input:name}` instead
 *   Copilot CLI                           installs the command as a skill, and
 *                                         documents no argument substitution
 *
 * On the last two the model gets the literal text `$1`. The install does not
 * fail, so the problem is easy to miss. This module finds it, for `hcm
 * validate` and for `hcm install` before anything is asked or written.
 *
 * `<%NAME%>` placeholders are a different thing: hcm fills them at install
 * time, the same way on every harness. See `core/parameters.ts`.
 */

import { inFlavors } from './flavors.js';
import type { LoadedBundle, TargetId } from './types.js';
import { getTarget, TARGET_IDS } from '../targets/index.js';

/** The harnesses that do not replace `$ARGUMENTS` or `$1` in a command. */
export const TARGETS_WITHOUT_COMMAND_ARGUMENTS: readonly TargetId[] = ['copilot', 'copilot-cli'];

/**
 * `$ARGUMENTS`, or `$` and a number from 1. Not `$0`, which is not an
 * argument, and not `$ARGUMENTSX`, which is a different name.
 */
const ARGUMENT_TOKEN = /\$(ARGUMENTS|[1-9][0-9]*)(?![A-Za-z0-9_])/g;

/** One command that uses arguments, and the harnesses that will not fill them. */
export interface CommandArgumentIssue {
  bundle: string;
  bundlePath: string;
  /** The tokens the body uses, each one time, in the order they first appear. */
  tokens: string[];
  targets: TargetId[];
}

/** The argument tokens in a command body, each one time, in order. */
export function argumentTokens(body: string): string[] {
  const tokens = [...body.matchAll(ARGUMENT_TOKEN)].map((match) => match[0]);
  return [...new Set(tokens)];
}

/**
 * The commands of `bundle` that use arguments and install into a harness of
 * `targets` that does not replace them.
 *
 * `targets` is what the run installs into. A harness that the manifest does
 * not declare gets nothing from the bundle, so it is never part of an issue.
 * `flavors` is the flavor selection of the run; empty means the whole bundle.
 */
export function commandArgumentIssues(
  bundle: LoadedBundle,
  targets: readonly TargetId[],
  flavors: readonly string[] = [],
): CommandArgumentIssue[] {
  const declared = bundle.manifest.targets;
  const affected = targets
    .map((id) => getTarget(id).id)
    .filter((id) => TARGETS_WITHOUT_COMMAND_ARGUMENTS.includes(id))
    .filter((id) => !declared || declared.length === 0 || declared.includes(id));
  if (affected.length === 0) return [];

  const issues: CommandArgumentIssue[] = [];
  for (const resource of bundle.resources) {
    if (resource.kind !== 'command' || !inFlavors(resource, [...flavors])) continue;
    const tokens = argumentTokens(resource.body ?? '');
    if (tokens.length === 0) continue;
    issues.push({
      bundle: bundle.manifest.name,
      bundlePath: resource.bundlePath,
      tokens,
      targets: [...new Set(affected)],
    });
  }
  return issues;
}

/** The same check for `hcm validate`: every harness the bundle can go into. */
export function commandArgumentWarnings(bundle: LoadedBundle): string[] {
  return commandArgumentIssues(bundle, TARGET_IDS).map(describeCommandArgumentIssue);
}

/** One line that says which file, which tokens, which harnesses and what to do. */
export function describeCommandArgumentIssue(issue: CommandArgumentIssue): string {
  const tokens = issue.tokens.join(', ');
  const harnesses = issue.targets.map((id) => getTarget(id).title).join(' and ');
  const verb = issue.targets.length === 1 ? 'does' : 'do';
  return (
    `${issue.bundlePath}: uses ${tokens}, which ${harnesses} ${verb} not replace; ` +
    'the command gets the literal text there'
  );
}
