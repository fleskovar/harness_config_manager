# Test case: uninstall-leaves-project-empty

## What this proves

Install into an empty project and uninstall again, and the project is **empty** —
not "empty except for a stray directory", and not "empty except for a
`CLAUDE.md` holding two blank lines".

**Unit under test:** `src/commands/uninstall.ts::uninstallCommand`
**Layer:** use case over an injected project directory
**Requirement:** "How rollback stays exact" in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | install, then uninstall | `-t claude-code` |
| `inputs/bundles/review-kit/` | the bundle | one resource of every kind |

### Why each row exists

Every kind, because each kind is removed a *different way* and any one of them
could leave a trace: a **file** is deleted, a **JSON key** is removed from a
document, a **marker block** is cut out of a text file, and an emptied
**directory** is pruned.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/` | **empty** — the strongest baseline in the suite | — |
| `outputs/state.json` | `installations: []` | — |

An empty `outputs/tree/` is not a missing baseline: the runner compares the file
*list* first, so a single stray file fails this case and names itself.

## Baseline provenance

- [x] **Computed by hand** — the requirement is "hcm removes exactly what it
  installed". The project had nothing before, so it must have nothing after.

## Walkthrough

### The four removals

1. **Files** — the six under `.claude/` are deleted, each checked against the
   hash in its receipt first.
2. **A JSON value** — `mcpServers.filesystem` is removed from `.mcp.json`. That
   leaves `{"mcpServers":{}}`, which is *effectively empty*, so the file is
   deleted rather than left as a shell.
3. **Marker blocks** — the two context sections are cut out of `CLAUDE.md`,
   which then holds nothing but whitespace, so it goes too.
4. **Directories** — `.claude/agents/`, `.claude/commands/`, `.claude/rules/`,
   `.claude/skills/dependency-audit/`, `.claude/skills/` and finally `.claude/`
   are pruned in turn, each only once it is empty.

None of that is prefix matching. Every deletion is one receipt being honoured,
which is exactly why the same code leaves a *hand-written* `CLAUDE.md` alone —
see `hand-written-context-survives`, where the correct answer is emphatically
not "empty".

### The ledger

`installations: []`. The record is removed rather than emptied, so `hcm status`
has nothing to report and a later reinstall starts clean.

## Why this proves the code is correct

- **It pins:** that all four removal mechanisms run to completion, and that
  emptied files and directories are pruned rather than left behind.
- **It would catch:** an orphaned `.claude/` directory, a `.mcp.json` reduced to
  `{}` but not deleted, a `CLAUDE.md` left holding blank lines, and a ledger
  entry that survives its own uninstall.
- **It does not cover:** a project that had files of its own before hcm arrived.

## How to run and debug

```bash
make test-case CASE=uninstall-leaves-project-empty
make debug-case CASE=uninstall-leaves-project-empty
```

**Start here:** breakpoint in `src/core/fsx.ts`, in `pruneEmptyDirs` — the step
that turns "all six files deleted" into "no `.claude/` at all".
