# Test case: adopted-item-survives-uninstall

## What this proves

Uninstalling leaves an adopted item exactly as it was found. hcm removes what it
installed - and it never installed this.

**Unit under test:** `src/core/rollback.ts::rollback`
**Layer:** use case over an injected project directory
**Requirement:** "When something is already there" in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | install, then uninstall | `-t claude-code` |
| `inputs/bundles/review-kit/` | the bundle | one resource of every kind |
| `inputs/project/.mcp.json` | what the project already had | one server, ours |

### The project before

`inputs/project/` is a project that already has an `.mcp.json` holding **exactly
the server review-kit would write** - same command, same args - but written by
somebody else, with four-space indentation and the keys in the other order.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/.mcp.json` | **one** file - the project's own, untouched | - |
| `outputs/state.json` | `installations: []` | - |

## Baseline provenance

- [x] **Computed by hand** - seven installed items are removed; the eighth was
  never hcm's.

## Walkthrough

### The comparison that carries this case

```bash
diff tests/cases/adopted-item-survives-uninstall/outputs/tree/.mcp.json \
     tests/cases/adopt-identical-mcp-server/inputs/project/.mcp.json
```

No output. The file came through an install and an uninstall unchanged, down to
its indentation.

### Why it survived

1. The receipt for `mcpServers.filesystem` carries `"preexisting": true`, set
   during the install (see `adopt-identical-mcp-server`).
2. Rollback skips preexisting receipts entirely. It does not compare, does not
   delete, does not rewrite.
3. Because the file still holds a key, it is not "effectively empty", so the
   file is not deleted either.

### The contrast worth drawing

`uninstall-leaves-project-empty` runs the same bundle through the same commands
and ends with **nothing**. The only difference is what the project had before,
and the two cases together define the rule: *hcm removes what it installed, no
more and no less.*

## Why this proves the code is correct

- **It pins:** that adoption survives a round trip, and that a file holding an
  adopted value is not pruned.
- **It would catch:** an uninstall that removed adopted items, and one that
  deleted the file once its own key was gone without noticing another remained.
- **It does not cover:** an adopted item that somebody edits between install and
  uninstall.

## How to run and debug

```bash
make test-case CASE=adopted-item-survives-uninstall
make debug-case CASE=adopted-item-survives-uninstall
```

**Start here:** breakpoint in `src/core/types.ts`, in `isPreexisting`, and see
who asks it.
