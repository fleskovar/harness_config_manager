# Test case: conflict-abort-writes-nothing

## What this proves

`--on-conflict abort` refuses the whole install. Not "installs the parts that
fit" - **nothing**, so a refused install never leaves a project half-configured.

**Unit under test:** `src/core/conflicts.ts::resolvePlanConflicts`
**Layer:** use case over an injected project directory
**Requirement:** "When something is already there" in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | one `install`, `onConflict: abort`, marked `fails` | 1 step |
| `inputs/bundles/review-kit/` | the bundle | one resource of every kind |
| `inputs/project/` | a project that already disagrees | 2 files |

### The project before

`inputs/project/` holds a real setup that disagrees with the bundle:

| What it has | Why it is there |
| --- | --- |
| `.mcp.json` -> `filesystem` pointed at `/srv/docs` | the **collision**: same name, different value |
| `.mcp.json` -> `postgres` | an unrelated server that must survive whatever is decided |
| `CLAUDE.md`, hand-written | notes a person wrote, which must survive too |

### Why each row exists

**One** colliding item out of eight. Seven of review-kit's items would install
without any trouble at all - and the point of the case is that they do not,
because the run is refused as a whole.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 2 files - the project's own, unchanged | path order |
| `outputs/error.txt` | the refusal | - |

## Baseline provenance

- [x] **Computed by hand** - the requirement is that nothing is written, so the
  baseline is the input project verbatim.

## Walkthrough

1. Planning finds one conflict: `mcpServers.filesystem` is already set to a
   different value.
2. The policy is `abort`, so `resolvePlanConflicts` raises before the executor
   is reached. `outputs/error.txt` holds the message:

   ```
   1 conflict(s) installing "review-kit" into Claude Code
   ```

3. Because planning happens entirely in memory and nothing is written until the
   plan is resolved, the project is untouched. `outputs/tree/` holds exactly the
   two files `inputs/project/` had, byte for byte:

   ```bash
   diff -r tests/cases/conflict-abort-writes-nothing/inputs/project \
           tests/cases/conflict-abort-writes-nothing/outputs/tree
   ```

4. In particular there is **no `.claude/` directory**. Not an empty one - none.
   That absence is what the case is really about: a partially-created directory
   tree would be the visible symptom of a plan that started executing before it
   was fully resolved.

### Why abort is the default without a terminal

There is nobody to ask in a script or in CI, and the two silent alternatives are
both bad: skipping hides that the bundle did not fully install, overwriting
destroys a value somebody chose. Stopping is the only answer that cannot be
wrong.

## Why this proves the code is correct

- **It pins:** plan-then-execute ordering, and that a refusal is total.
- **It would catch:** an installer that wrote resources as it planned them, and
  one that treated a conflict in one resource as a reason to skip only that one.
- **It does not cover:** the three ways *through* a conflict - skip, overwrite
  and rename, each of which has its own case.

## How to run and debug

```bash
make test-case CASE=conflict-abort-writes-nothing
make debug-case CASE=conflict-abort-writes-nothing
```

**Start here:** breakpoint in `src/core/conflicts.ts`, in `pickResolver`.
