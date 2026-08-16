# Test case: context-append-is-idempotent

## What this proves

Running `hcm context append` twice changes nothing the second time. It is a
repair, and a repair you can run on a schedule without watching it.

**Unit under test:** `src/core/context.ts::appendContext`
**Layer:** use case over an injected project directory
**Requirement:** "Context: sections that survive being overwritten"

## Inputs

Identical to `context-append-restores-lost-section` but with a fourth step: a
second `context append`. Read that case first.

| File | What it is |
| --- | --- |
| `inputs/case.json` | install, overwrite `CLAUDE.md`, append, **append again** |
| `inputs/bundles/review-kit/` | the bundle |
| `inputs/rewritten-CLAUDE.md` | what the agent left behind |

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 8 files, byte-identical to the single-append case | path order |

## Baseline provenance

- [x] **Computed by hand** - the second run has nothing to do, so the output is
  the first run's.

## Walkthrough

### The assertion, in one command

```bash
diff -r tests/cases/context-append-is-idempotent/outputs/tree \
        tests/cases/context-append-restores-lost-section/outputs/tree
```

No output. That is the case.

### What the second run finds

| Section | State on the second run | Outcome |
| --- | --- | --- |
| `10-conventions` | its marker block is there - the first run wrote it | `present`, left alone |
| `20-pull-requests` | still unmarked prose | `unmarked`, left alone |

Neither is rewritten. In particular the first is left **exactly as it is**, edits
and all: a section inside its markers is somebody's to improve, and `append` does
not overwrite what it finds. `--force` is how you say otherwise.

### Why this is worth a case rather than a line in a unit test

Idempotence is the property that makes this command safe to put in a hook or a
cron job, which is how it is actually used. It is also the property most easily
lost by a well-meaning change - a refactor that "simplified" the present/unmarked
distinction into "write it if the markers are missing" would pass every other
context case and fail only this one, by doubling the file on every run.

## Why this proves the code is correct

- **It pins:** that a second append is a no-op for both the marked and the
  unmarked section.
- **It would catch:** an append that rewrote blocks it found, and one that
  duplicated the unmarked section on every subsequent run.
- **It does not cover:** `--force`, which deliberately does rewrite.

## How to run and debug

```bash
make test-case CASE=context-append-is-idempotent
make debug-case CASE=context-append-is-idempotent
```

**Start here:** breakpoint in `src/core/context.ts`, in `appendContext`, and
compare the `results` of the two runs.
