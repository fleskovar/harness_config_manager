/** An error that should be shown to the user as a clean message, not a stack trace. */
export class HcmError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'HcmError';
    this.hint = hint;
  }
}

export class ConflictError extends HcmError {
  readonly conflicts: { path: string; detail: string; owner?: string }[];

  constructor(message: string, conflicts: { path: string; detail: string; owner?: string }[]) {
    super(message, 'Re-run with --force to overwrite, or uninstall the owning bundle first.');
    this.name = 'ConflictError';
    this.conflicts = conflicts;
  }
}
