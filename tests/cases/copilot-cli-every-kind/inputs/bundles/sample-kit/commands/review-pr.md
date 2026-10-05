---
description: Review the current branch against a base branch.
argumentHint: "[base-branch]"
allowedTools:
  - Read
  - Grep
  - Bash
---

Review this branch against `$ARGUMENTS` (default `main` when no base is given).

Work through `skills/dependency-audit/checklist.md` for anything that touches
dependencies, and hand security findings to `subagents/code-reviewer.md`.
