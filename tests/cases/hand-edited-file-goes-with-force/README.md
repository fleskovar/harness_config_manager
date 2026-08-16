# Test case: hand-edited-file-goes-with-force

## What this proves

The retry that says `--force` removes the edited file too, and leaves the
project empty - so a blocked uninstall is a pause, not a dead end.

**Unit under test:** `src/commands/uninstall.ts::rollbackInstallation`
**Layer:** use case over an injected project directory
**Requirement:** "How rollback stays exact" in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | install, edit, uninstall, uninstall `--force` | 4 steps |
| `inputs/bundles/review-kit/` | the bundle | one resource of every kind |

### Why each row exists

The third step is the *blocked* uninstall from
`hand-edited-file-blocks-uninstall`, kept here on purpose: `--force` has to work
as a **retry**, against a project where seven of the eight items have already
gone and the record is the only thing that still knows about the eighth.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/` | **empty** | - |
| `outputs/state.json` | `installations: []` | - |

## Baseline provenance

- [x] **Computed by hand** - the first uninstall leaves one file and the record;
  the forced one removes both.

## Walkthrough

1. After step 3 the project holds exactly `.claude/agents/code-reviewer.md`, and
   the ledger still holds the installation. That is
   `hand-edited-file-blocks-uninstall`, verbatim.
2. Step 4 runs the same uninstall with `--force`. The seven items already gone
   are reported `missing` and skipped - removing something twice is not an
   error, which is what makes a retry safe.
3. The edited file still hashes differently, but `--force` says to remove it
   anyway. It goes, and `.claude/agents/`, `.claude/skills/` and `.claude/` are
   pruned behind it.
4. The record is then dropped, because this time the rollback completed.

### The claim this case makes, and its limit

`--force` discards local edits. That is the *point* of the flag and the reason
it is not the default: the previous case is what happens without it, and the
warning it prints names this command as the way through.

## Why this proves the code is correct

- **It pins:** that `--force` overrides the hash check, that an already-removed
  item is not an error on a retry, and that the record is dropped only once the
  removal is complete.
- **It would catch:** a `--force` that still refused, a retry that failed on the
  seven missing items before reaching the eighth, and a record left behind after
  a successful forced removal.
- **It does not cover:** whether the user was warned - that is log output, not a
  file.

## How to run and debug

```bash
make test-case CASE=hand-edited-file-goes-with-force
make debug-case CASE=hand-edited-file-goes-with-force
```

**Start here:** breakpoint in `src/core/rollback.ts` and compare the two runs:
step 3 and step 4 take different branches on the same receipts.
