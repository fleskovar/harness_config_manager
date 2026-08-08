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
