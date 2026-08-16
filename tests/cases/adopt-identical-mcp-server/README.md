# Test case: adopt-identical-mcp-server

## What this proves

An item that is already there and already correct is **adopted**: hcm records
that it depends on it, does not rewrite it, and does not claim ownership of it.
The file is not even reformatted.

**Unit under test:** `src/core/planner.ts::detectConflicts`
**Layer:** use case over an injected project directory
**Requirement:** "When something is already there" in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | one `install` step | `-t claude-code` |
| `inputs/bundles/review-kit/` | the bundle | one resource of every kind |
| `inputs/project/.mcp.json` | what the project already had | one server, ours |

### The project before

`inputs/project/` is a project that already has an `.mcp.json` holding **exactly
the server review-kit would write** - same command, same args - but written by
somebody else, with four-space indentation and the keys in the other order.

The different formatting is the whole reason the case exists: comparing text
would call this a conflict. hcm compares the *value*.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 8 files - 7 written, 1 adopted | path order |
| `outputs/state.json` | the ledger, with one receipt marked `preexisting` | by installation id |

## Baseline provenance

- [x] **Computed by hand** - the install writes the seven items review-kit owns
  and leaves the eighth exactly as the project fixture has it.

## Walkthrough

### The rule, stated once

Three outcomes are possible when an item is already present, and only one of
them is a conflict:

| Found | Outcome |
| --- | --- |
| the same value, claimed by nobody | **adopt** - record it, do not write it, do not own it |
| the same value, claimed by another bundle | **share** - claim it too |
| a different value | **conflict** - ask |

### The adoption

1. The planner reads `.mcp.json`, takes the value at `mcpServers.filesystem`,
   and hashes it. The hash matches what review-kit would write, because hashing
   is over the canonical value and not the text.
2. Nobody else claims it, so the action is marked `adopt`.
3. The executor writes nothing. Compare `outputs/tree/.mcp.json` with
   `inputs/project/.mcp.json`: **byte for byte identical**, four-space
   indentation and reversed key order intact.
4. The receipt records `"preexisting": true`. Find it in
   `outputs/state.json` - it is the `json-value` receipt for `.mcp.json`.

### What that flag buys

An adopted item is not hcm's to remove. `adopted-item-survives-uninstall` next
door is the other half of this behaviour, and the flag written here is the only
reason it can behave differently from `uninstall-leaves-project-empty`.

### The rest of the bundle

All seven other items install normally. Adoption is per item, not per install.

## Why this proves the code is correct

- **It pins:** value-based comparison rather than text-based, the untouched
  bytes of a file hcm decided not to write, and the `preexisting` flag.
- **It would catch:** a reformatted `.mcp.json` (which would be a spurious diff
  in someone's repository), a spurious conflict on key order, and a missing
  `preexisting` flag - which would only show up much later, as an uninstall
  deleting something it never installed.
- **It does not cover:** the same value claimed by *another bundle*, which is
  sharing rather than adoption.

## How to run and debug

```bash
make test-case CASE=adopt-identical-mcp-server
make debug-case CASE=adopt-identical-mcp-server
```

**Start here:** breakpoint in `src/core/planner.ts`, in `detectConflicts`, on
the `json-value` branch, and watch `action.adopt` be set.
