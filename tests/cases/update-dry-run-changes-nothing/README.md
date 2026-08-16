# Test case: update-dry-run-changes-nothing

## What this proves

`hcm update --dry-run` reports what it *would* do and leaves version 1 exactly
where it was - no file moved, no block rewritten, no ledger entry touched.

**Unit under test:** `src/commands/update.ts::updateCommand`
**Layer:** use case over an injected project directory
**Requirement:** "Updating" in the top-level `README.md`

## Inputs

Identical to `update-to-a-new-version` in every respect but one: the final step
carries `"dryRun": true`. Read that case first - this one exists to prove the
flag, and the pair of them is the assertion.

| File | What it is |
| --- | --- |
| `inputs/case.json` | register `--dev`, install v1, publish v2, update `--dry-run` |
| `inputs/bundles/review-kit/` | version 1.0.0 |
| `inputs/bundles/review-kit-v2/` | version 2.0.0 |

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 8 files - **v1's**, unchanged | path order |
| `outputs/state.json` | version `1.0.0` | by installation id |

## Baseline provenance

- [x] **Computed by hand** - a dry run changes nothing, so the baseline is the
  v1 install verbatim.

## Walkthrough

The comparison that carries this case is against its sibling, and it is worth
running by hand:

```bash
diff -r tests/cases/update-dry-run-changes-nothing/outputs/tree \
        tests/cases/update-to-a-new-version/outputs/tree
```

Three differences print, and they are exactly the three changes v2 makes:

1. `.claude/agents/code-reviewer.md` here, `change-reviewer.md` there.
2. `CLAUDE.md` still holds `## Pull requests` here; there it does not.
3. `checklist.md` lacks the "New in v2" line here; there it has it.

**None** of them happened. That is the whole case: the update ran, worked out
its plan, printed it, and touched nothing.

### The part that is easy to get wrong

A dry-run update has two halves, and both must be inert:

1. The **rollback** half must not remove v1's items even though it reports them.
2. The **install** half must not write v2's, even though the plan is complete
   enough to describe them.

Getting the first right and the second wrong would leave the project holding
neither version, which is why `outputs/state.json` still saying `1.0.0` matters
as much as the tree does.

## Why this proves the code is correct

- **It pins:** that `--dry-run` reaches both halves of an update, and that the
  ledger is not written either.
- **It would catch:** a dry run that rolled back for real and then declined to
  reinstall - the worst possible failure, since it would leave the project with
  nothing at all.
- **It does not cover:** what the dry run *prints*, which is not a baseline
  worth pinning to the byte.

## How to run and debug

```bash
make test-case CASE=update-dry-run-changes-nothing
make debug-case CASE=update-dry-run-changes-nothing
```

**Start here:** breakpoint in `src/core/executor.ts`, in `applyPlan` - on a dry
run it should never be reached.
