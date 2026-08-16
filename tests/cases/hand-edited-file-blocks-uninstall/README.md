# Test case: hand-edited-file-blocks-uninstall

## What this proves

A file edited after installation is **not** silently deleted by `hcm uninstall`.
It stays, the installation record stays with it, and everything untouched still
goes - so the operation is honest about what it could and could not do.

**Unit under test:** `src/commands/uninstall.ts::rollbackInstallation`
**Layer:** use case over an injected project directory
**Requirement:** "How rollback stays exact" in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | install, edit one file, uninstall | 3 steps |
| `inputs/bundles/review-kit/` | the bundle | one resource of every kind |

### Why each row exists

Exactly **one** file is edited, and the other seven items are left alone. That
asymmetry is the point: a rollback that refused to remove anything once it found
a single edit would be useless, and one that removed everything regardless would
lose work.

The edit is a comment appended to `.claude/agents/code-reviewer.md`:

```
<!-- A note somebody added locally. -->
```

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | **one** file: the edited agent | path order |
| `outputs/state.json` | the installation, still recorded | by installation id |

## Baseline provenance

- [x] **Computed by hand** - 8 items installed, 1 edited, 7 removable.

## Walkthrough

### The rule, stated once

Every file receipt holds the sha256 of what hcm wrote. On removal each item is
hashed again: matching means nobody has touched it and it is safe to delete;
differing means somebody has, and it is not hcm's to throw away.

### Item by item

1. `.claude/agents/code-reviewer.md` hashes differently now, so it is reported
   `modified` and **left**. It is the one file in `outputs/tree/`, and it still
   ends with the appended comment.
2. The other five files under `.claude/`, the `.mcp.json` key and both
   `CLAUDE.md` blocks hash as installed, so all of them go. `.mcp.json` and
   `CLAUDE.md` empty out and are deleted; the `.claude/` directories are pruned
   *except* `agents/`, which still holds the edited file.
3. So the project ends with exactly `.claude/agents/code-reviewer.md` and the
   directories above it, and nothing else.

### Why the record survives

`outputs/state.json` still holds `review-kit@claude-code@project`. That is
deliberate: the uninstall did not finish, so the record is kept and you can
retry. `hand-edited-file-goes-with-force` is that retry.

Had the record been dropped here, the edited file would be orphaned - claimed by
nothing, removable by nothing, and invisible to `hcm status`.

## Why this proves the code is correct

- **It pins:** hash-checked removal, per item rather than per install; that a
  blocked removal keeps the record; and that a directory holding a survivor is
  not pruned.
- **It would catch:** an uninstall that deleted by path without checking, one
  that gave up entirely on the first modified item, and one that dropped the
  record anyway and orphaned the file.
- **It does not cover:** the same guard on `hcm update`, which reaches this code
  through the same `rollbackInstallation`.

## How to run and debug

```bash
make test-case CASE=hand-edited-file-blocks-uninstall
make debug-case CASE=hand-edited-file-blocks-uninstall
```

**Start here:** breakpoint in `src/core/rollback.ts` where the receipt hash is
compared against the file on disk.
