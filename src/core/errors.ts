/** An error that should be shown to the user as a clean message, not a stack trace. */
export class HcmError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'HcmError';
    this.hint = hint;
  }
}

/** The user chose "abort" at a conflict prompt. Nothing has been written. */
export class AbortedError extends HcmError {
  constructor(message = 'Installation aborted') {
    super(message, 'Nothing was written.');
    this.name = 'AbortedError';
  }
}

export class ConflictError extends HcmError {
  readonly conflicts: { path: string; detail: string; owner?: string }[];

  constructor(message: string, conflicts: { path: string; detail: string; owner?: string }[]) {
    super(
      message,
      'Re-run interactively to decide item by item, or pass --on-conflict skip|overwrite ' +
        '(--force is the same as --on-conflict overwrite).',
    );
    this.name = 'ConflictError';
    this.conflicts = conflicts;
  }
}
