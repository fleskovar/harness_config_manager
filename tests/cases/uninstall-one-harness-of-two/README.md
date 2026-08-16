# Test case: uninstall-one-harness-of-two

## What this proves

`hcm uninstall -t claude-code`, in a folder where the same bundle is also
installed for Copilot, removes **exactly** the Claude Code items and leaves
every Copilot file untouched.

**Unit under test:** `src/commands/uninstall.ts::uninstallCommand`
**Layer:** use case over an injected project directory
**Requirement:** "How rollback stays exact" in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | install twice, then uninstall one | `-t claude-code`, `-t copilot`, uninstall `-t claude-code` |
| `inputs/bundles/review-kit/` | the bundle | one resource of every kind |

### Why each row exists

The state this case starts from is `two-harnesses-one-project`'s output — 16
files, two records. Read that case first; this one is what happens next.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 8 files, all Copilot's | path order |
| `outputs/state.json` | one installation left | by installation id |

## Baseline provenance

- [x] **Computed by hand** — 16 − 8. The 8 that go are exactly Claude Code's
  list from `claude-code-every-kind`; the 8 that stay are exactly Copilot's.

## Walkthrough

### The rules, stated once

1. Uninstall works from **receipts**, not from a rule about which paths belong
   to which harness. It removes the items one record claims, and nothing else.
2. A file or directory emptied by that removal goes too; one still holding
   something stays.

### What goes

Every item in the `review-kit@claude-code@project` record:

- The six files under `.claude/` — after which `.claude/` holds nothing and is
  pruned, along with `agents/`, `commands/`, `rules/` and `skills/` inside it.
- `.mcp.json` — the whole file, because the only key in it was the
  `mcpServers.filesystem` this record claimed.
- The two marker blocks in `CLAUDE.md` — after which the file holds nothing but
  whitespace, so it goes too.

### What stays

All 8 Copilot files, byte-for-byte as the Copilot install wrote them. In
particular `.vscode/mcp.json` still holds a `filesystem` server: it is a
*different file*, claimed by a *different record*, and the fact that it holds a
server of the same name is beside the point.

### The ledger

One installation left, `review-kit@copilot@project`. The Claude Code record is
gone entirely rather than emptied, so `hcm status` has nothing to say about it.

## Why this proves the code is correct

- **It pins:** that removal is scoped by record, that emptied files and
  directories are pruned, and that the surviving harness is untouched.
- **It would catch:** an uninstall that matched paths by prefix and took
  `.github/` with it, one that left an empty `.claude/` behind, and one that
  deleted `.vscode/mcp.json` because it also holds a `filesystem` server.
- **It does not cover:** a file two harnesses genuinely share, where the first
  uninstall must *leave* it for the second — that is a different rule and a
  different case.

## How to run and debug

```bash
make test-case CASE=uninstall-one-harness-of-two
make debug-case CASE=uninstall-one-harness-of-two
```

**Start here:** breakpoint in `src/core/rollback.ts`, in `rollback`, and watch
it iterate the receipts of one record only.
