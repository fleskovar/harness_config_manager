/**
 * Terminal questions.
 *
 * Deliberately tiny and dependency-free: a numbered menu and a line of text.
 * Everything that asks something goes through here so that non-interactive
 * runs have exactly one place to be detected and refused.
 */

import readline from 'node:readline';
import { AbortedError } from './errors.js';
import { color } from './logger.js';

export interface Choice<T extends string> {
  /** Value returned when this line is picked. */
  value: T;
  label: string;
  detail?: string;
}

/** True when there is a human on the other end of both stdin and stdout. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// ---------------------------------------------------------------------------
// Reading lines
// ---------------------------------------------------------------------------

/**
 * One reader for the whole process, with a queue in front of it.
 *
 * Both halves matter. A fresh interface per question throws away whatever is
 * already buffered on stdin, and a bare `rl.question` loses any line that
 * arrives before its listener is attached -- which is exactly what happens when
 * the answers are piped in rather than typed. Queueing makes a two-part
 * question (choose "rename", then type the name) work either way.
 */
let reader: readline.Interface | undefined;
let pending: string[] = [];
let waiting: ((line: string | undefined) => void) | undefined;
let ended = false;

function open(): void {
  if (reader) return;

  // terminal:false leaves echo and line editing to the terminal itself, so
  // typed and piped input behave identically.
  reader = readline.createInterface({ input: process.stdin, terminal: false });
  ended = false;

  reader.on('line', (line: string) => {
    const resolve = waiting;
    if (resolve) {
      waiting = undefined;
      resolve(line);
    } else {
      pending.push(line);
    }
  });

  reader.on('close', () => {
    ended = true;
    const resolve = waiting;
    if (resolve) {
      waiting = undefined;
      resolve(undefined);
    }
  });
}

/** Release stdin so the process can exit. Safe to call when nothing was asked. */
export function closePrompt(): void {
  reader?.close();
  reader = undefined;
  waiting = undefined;
  pending = [];
  ended = false;
}

async function ask(question: string): Promise<string> {
  open();
  process.stdout.write(question);

  const buffered = pending.shift();
  if (buffered !== undefined) return buffered.trim();

  if (ended) throw new AbortedError('Aborted: no answer, and stdin has closed');

  const line = await new Promise<string | undefined>((resolve) => {
    waiting = resolve;
  });

  if (line === undefined) throw new AbortedError('Aborted: no answer, and stdin has closed');
  return line.trim();
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/**
 * Numbered single-choice menu. Repeats until the answer is one of the options;
 * an empty answer takes `defaultValue` when one is offered.
 */
export async function select<T extends string>(
  title: string,
  choices: Choice<T>[],
  defaultValue?: T,
): Promise<T> {
  process.stdout.write(`${title}\n`);

  for (const [index, choice] of choices.entries()) {
    const marker = choice.value === defaultValue ? color.bold('*') : ' ';
    const detail = choice.detail ? color.dim(` -- ${choice.detail}`) : '';
    process.stdout.write(`  ${marker}${index + 1}) ${choice.label}${detail}\n`);
  }

  const fallback =
    defaultValue === undefined
      ? ''
      : color.dim(` [${choices.findIndex((choice) => choice.value === defaultValue) + 1}]`);

  for (;;) {
    const answer = await ask(`${color.cyan('?')} choose 1-${choices.length}${fallback}: `);

    if (answer === '' && defaultValue !== undefined) return defaultValue;

    const byNumber = Number.parseInt(answer, 10);
    if (byNumber >= 1 && byNumber <= choices.length) return choices[byNumber - 1]!.value;

    // Accept the value itself too, so "skip" works as well as "1".
    const byName = choices.find((choice) => choice.value === answer.toLowerCase());
    if (byName) return byName.value;

    process.stdout.write(color.yellow('  not one of the options\n'));
  }
}

/**
 * Numbered multiple-choice menu: pick any number of the options, by number or
 * by value, separated by spaces or commas, with `all` for every one.
 *
 * `selected` is what is ticked when the menu opens and what an empty answer
 * takes -- which is how a question can carry a sensible default without the
 * default being applied silently. Repeats until the answer names something, so
 * an empty answer with nothing preselected asks again rather than returning a
 * selection of nothing.
 *
 * The result is in menu order however the answer was typed, so two people who
 * choose the same options get the same list.
 */
export async function multiSelect<T extends string>(
  title: string,
  choices: Choice<T>[],
  selected: readonly T[] = [],
): Promise<T[]> {
  const ticked = new Set<T>(selected);
  process.stdout.write(`${title}\n`);

  for (const [index, choice] of choices.entries()) {
    const mark = ticked.has(choice.value) ? color.bold('x') : ' ';
    const detail = choice.detail ? color.dim(` -- ${choice.detail}`) : '';
    process.stdout.write(`  [${mark}] ${index + 1}) ${choice.label}${detail}\n`);
  }

  const preset = choices
    .map((choice, index) => (ticked.has(choice.value) ? String(index + 1) : undefined))
    .filter((entry): entry is string => entry !== undefined);
  const fallback = preset.length > 0 ? color.dim(` [${preset.join(',')}]`) : '';

  for (;;) {
    const answer = await ask(
      `${color.cyan('?')} choose 1-${choices.length}, or "${ALL_CHOICES}"${fallback}: `,
    );

    if (answer === '' && ticked.size > 0) {
      return choices.filter((choice) => ticked.has(choice.value)).map((choice) => choice.value);
    }

    const picked = readSelection(answer, choices);
    if (picked) return picked;

    process.stdout.write(
      color.yellow('  pick one or more of the options, by number or by name\n'),
    );
  }
}

/** The word a multiple-choice menu accepts for "every option". */
export const ALL_CHOICES = 'all';

/**
 * Read a multiple-choice answer, or undefined when it names nothing or names
 * something that is not on the menu -- either way the question is asked again,
 * because a typo that quietly selected less than was meant is the one outcome
 * a menu must not have.
 */
export function readSelection<T extends string>(
  answer: string,
  choices: Choice<T>[],
): T[] | undefined {
  const tokens = answer.split(/[\s,]+/u).filter(Boolean);
  if (tokens.length === 0) return undefined;

  if (tokens.some((token) => token.toLowerCase() === ALL_CHOICES)) {
    return choices.map((choice) => choice.value);
  }

  const picked = new Set<T>();

  for (const token of tokens) {
    const byNumber = Number.parseInt(token, 10);
    if (String(byNumber) === token && byNumber >= 1 && byNumber <= choices.length) {
      picked.add((choices[byNumber - 1] as Choice<T>).value);
      continue;
    }

    const byName = choices.find((choice) => choice.value.toLowerCase() === token.toLowerCase());
    if (!byName) return undefined;
    picked.add(byName.value);
  }

  return choices.filter((choice) => picked.has(choice.value)).map((choice) => choice.value);
}

/** Yes or no, defaulting to the safe answer unless told otherwise. */
export async function confirm(question: string, defaultValue = false): Promise<boolean> {
  const answer = await select<'yes' | 'no'>(
    question,
    [
      { value: 'no', label: 'no', detail: 'leave the file as it is' },
      { value: 'yes', label: 'yes', detail: 'go ahead' },
    ],
    defaultValue ? 'yes' : 'no',
  );
  return answer === 'yes';
}

/**
 * Free-text answer, re-asked until `validate` accepts it. `validate` returns
 * an error message to reject, or undefined to accept.
 */
export async function text(
  question: string,
  validate: (value: string) => string | undefined,
): Promise<string> {
  for (;;) {
    const answer = await ask(`${color.cyan('?')} ${question}: `);
    const problem = validate(answer);
    if (!problem) return answer;
    process.stdout.write(color.yellow(`  ${problem}\n`));
  }
}
