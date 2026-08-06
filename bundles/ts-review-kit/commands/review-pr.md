---
description: Review the current branch against the base branch and summarise the findings
argumentHint: "[base-branch]"
allowedTools:
  - Read
  - Grep
  - Glob
  - Bash
---

Review this branch against `$ARGUMENTS` (default `main` when no base is given).

1. `git diff $ARGUMENTS...HEAD --stat` for the shape of the change.
2. `git diff $ARGUMENTS...HEAD` for the detail.
3. Read the files around each hunk before judging it.

Produce:

- A two-sentence summary of what the branch does.
- Findings ranked by severity, each with file, line and a suggested fix.
- Anything the change forgot: tests, docs, migrations, error handling.
