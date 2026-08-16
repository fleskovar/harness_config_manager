# Test case: context-remove-then-append

## What this proves

`hcm context remove` takes the sections out but **keeps the cached copies**, so
`append` can put them back. Remove is reversible; uninstall is not.

**Unit under test:** `src/core/context.ts::removeContext` and `appendContext`
**Layer:** use case over an injected project directory
**Requirement:** "Context: sections that survive being overwritten"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | install, `context remove`, `context append` | 3 steps |
| `inputs/bundles/review-kit/` | the bundle | two context sections |

No rewritten file here: this case is about hcm's own two commands, with no agent
involved.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 8 files - the full install, `CLAUDE.md` restored | path order |

## Baseline provenance

- [x] **Computed by hand** - a round trip must be the identity, so the baseline
  is the install verbatim.

## Walkthrough

### The state in the middle

After step 2 the project holds seven files, not eight: `CLAUDE.md` held nothing
but the two blocks, so removing them left it effectively empty and it was
deleted. Run the first two steps to see it:

```bash
npm run case -- context-remove-then-append --keep
```

The cached sections under `.hcm/context/review-kit/` are **still there**. That
is the difference between `context remove` and `hcm uninstall`, which drops the
cache with the installation.

### After step 3

`CLAUDE.md` is back, with both blocks, in order - recreated from the cache
rather than from the bundle, which was never re-read.

```bash
diff tests/cases/context-remove-then-append/outputs/tree/CLAUDE.md \
     tests/cases/claude-code-every-kind/outputs/tree/CLAUDE.md
```

The two differ only in the bundle name inside the block ids (`review-kit` versus
`sample-kit`); the structure is identical.

### The receipts follow

Both commands keep the install receipts in step with the file: `remove` drops
the block receipts, `append` puts them back. Otherwise `hcm status` would report
damage after a deliberate removal, or stay quiet after a restoration - and the
next uninstall would try to remove a block that is not there.

### What this is for

Turning a bundle's standing instructions off for a while without uninstalling
it - the skills, commands and MCP servers stay, only the always-loaded text
goes.

## Why this proves the code is correct

- **It pins:** that the cache outlives `remove`, that an emptied instruction
  file is deleted and recreated, and that a remove/append round trip is the
  identity.
- **It would catch:** a `remove` that deleted the cached copies, an `append`
  that could not recreate a deleted file, and receipts left out of step.
- **It does not cover:** removing one bundle's sections while another's stay.

## How to run and debug

```bash
make test-case CASE=context-remove-then-append
make debug-case CASE=context-remove-then-append
```

**Start here:** breakpoint in `src/core/context.ts`, in `syncBlockReceipts`.
