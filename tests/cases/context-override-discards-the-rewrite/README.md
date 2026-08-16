# Test case: context-override-discards-the-rewrite

## What this proves

`hcm context override` throws the agent's rewrite away and lays the sections
down in order. Discarding what hcm did not write is the *point* of the command,
not a side effect.

**Unit under test:** `src/core/context.ts::overrideContext`
**Layer:** use case over an injected project directory
**Requirement:** "Context: sections that survive being overwritten"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | install, overwrite `CLAUDE.md`, `context override --force` | 3 steps |
| `inputs/bundles/review-kit/` | the bundle | two context sections |
| `inputs/rewritten-CLAUDE.md` | what the agent left behind | prose, no markers |

### The rewrite

`inputs/rewritten-CLAUDE.md` is `CLAUDE.md` as a coding agent leaves it after
rewriting the file from scratch. Two things about it matter, and they are
different on purpose:

| Section | What the agent did |
| --- | --- |
| `10-conventions` | **deleted entirely** - markers and text both |
| `20-pull-requests` | **kept the prose, dropped the markers** |

That asymmetry is the whole context family. An agent that rewrites a file does
not do one thing to it uniformly, and hcm has to tell the two apart.

`--force` is passed because the command discards content hcm did not write and
asks first when there is a terminal; the case has none.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/CLAUDE.md` | **both** sections, in order, and nothing else | - |

## Baseline provenance

- [x] **Computed by hand** - the cached sections, in bundle order, with the
  agent's prose gone.

## Walkthrough

### Reading `outputs/tree/CLAUDE.md`

Two marker blocks and nothing else:

```
<!-- hcm:begin review-kit/10-conventions -->
## Review conventions
...
<!-- hcm:end review-kit/10-conventions -->

<!-- hcm:begin review-kit/20-pull-requests -->
## Pull requests
...
<!-- hcm:end review-kit/20-pull-requests -->
```

Three things to check:

1. The agent's notes about `src/server/` and `npm run build` are **gone**.
2. `20-pull-requests` is back **inside its markers**. `append` left it as bare
   prose; `override` rebuilds the file, so it is properly delimited again.
3. `10-` before `20-`: the file is laid down in bundle order, not in whatever
   order the agent happened to leave things.

That third point is what `override` is for. `append` can only add to the end, so
a file an agent has reordered stays reordered; `override` restores the intended
sequence.

### What survives a rebuild

Blocks belonging to **other** bundles, and blocks that are not context sections,
are kept and moved below. They have receipts of their own, and discarding them
would only make `hcm status` report damage. This case has none of them - the
distinction is unit-tested - but the rule is why `override` is not simply "write
the cache over the file".

### The blunt instrument warning

This is the destructive one of the three. It is the right answer when an agent
has mangled the instruction file and you want the shipped text back; it is the
wrong answer when the agent added something worth keeping.

## Why this proves the code is correct

- **It pins:** foreign content being discarded, sections restored in bundle
  order, and an unmarked section regaining its markers.
- **It would catch:** an override that kept the agent's prose, one that wrote
  the sections in ledger order, and one that left the unmarked section bare.
- **It does not cover:** other bundles' blocks surviving the rebuild.

## How to run and debug

```bash
make test-case CASE=context-override-discards-the-rewrite
make debug-case CASE=context-override-discards-the-rewrite
```

**Start here:** breakpoint in `src/core/context.ts`, in `keepOnlyBlocks`.
