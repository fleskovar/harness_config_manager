# Test case: update-to-a-new-version

## What this proves

`hcm update` installs what the new version **added** and removes what it
**dropped**. A new version is defined as much by what it took away as by what it
changed, so the renamed subagent and the deleted context section have to
disappear from the harness rather than sit there beside the new ones.

**Unit under test:** `src/commands/update.ts::updateCommand`
**Layer:** use case over an injected project directory
**Requirement:** "Updating" in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | register `--dev`, install v1, publish v2, update | 4 steps |
| `inputs/bundles/review-kit/` | version 1.0.0 | one resource of every kind |
| `inputs/bundles/review-kit-v2/` | version 2.0.0 | the same kit, one release on |

### Why each row exists

Diff the two bundles and the whole case follows from three differences, each
chosen to exercise a different kind of change:

| Change | Demonstrates |
| --- | --- |
| `subagents/code-reviewer.md` renamed to `change-reviewer.md` | a **rename** - the old file must go, not linger |
| `context/20-pull-requests.md` deleted | a **removal** inside a shared file, where nothing is deleted but a block |
| `skills/dependency-audit/checklist.md` gains a line | an ordinary **edit**, the easy case, present to prove the other two are not |

The bundle is registered with `--dev` so it is read from that directory every
time; "publishing v2" is then a matter of replacing the files there, which is
what the `replaceBundle` step does.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 8 files - the same count as v1, one of them renamed | path order |
| `outputs/state.json` | version `2.0.0` | by installation id |

## Baseline provenance

- [x] **Computed by hand** from the diff between the two input bundles.

## Walkthrough

### The rule, stated once

An update is **rollback-then-install**, not write-over-the-top. That single
decision is what makes all three changes below come out right, and it is why an
item you hand-edited still blocks an update the way it blocks an uninstall.

### The rename

1. Rollback removes `.claude/agents/code-reviewer.md`, because the v1 record
   claims it.
2. The install then writes `.claude/agents/change-reviewer.md` from v2.
3. So `outputs/tree/.claude/agents/` holds **one** file.
4. `.claude/commands/review-pr.md` now points at
   `../agents/change-reviewer.md` - the reference followed the rename, because
   references are remapped against *this* install's plan rather than stored.

### The deleted section

1. `CLAUDE.md` held two marker blocks. Rollback cut out both.
2. The install wrote back only `review-kit/10-conventions`, because that is all
   v2 ships.
3. So `outputs/tree/CLAUDE.md` contains `## Review conventions` and **no**
   `## Pull requests`, and no `review-kit/20-pull-requests` markers.

That is the case for rollback-then-install in one line: writing over the top
would have left the second block exactly where it was, with nothing in the new
version to overwrite it.

### The edit

`.claude/skills/dependency-audit/checklist.md` now ends with *New in v2: no
dependency is added in the same PR as a behaviour change.* No mechanism needed -
it is simply the new file.

### The ledger

`version` is `2.0.0`, and the receipts describe the v2 items. The record was
replaced, not appended to.

## Why this proves the code is correct

- **It pins:** that a rename leaves no orphan, that a dropped context section is
  cut from a file the bundle does not own outright, that references follow a
  rename, and that the recorded version moves.
- **It would catch:** an update that wrote v2 on top of v1 and left
  `code-reviewer.md` behind, a `CLAUDE.md` still holding the retired section,
  and a stale reference pointing at the old agent name.
- **It does not cover:** a `--dry-run` update, which is the case next door.

## How to run and debug

```bash
make test-case CASE=update-to-a-new-version
make debug-case CASE=update-to-a-new-version
```

**Start here:** breakpoint in `src/commands/update.ts`, in `reinstall`, and step
over the `rollbackInstallation` call to watch v1 leave before v2 arrives.
