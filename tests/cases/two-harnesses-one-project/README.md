# Test case: two-harnesses-one-project

## What this proves

One bundle installed into **two harnesses in the same folder** produces two
disjoint sets of files and two separate installation records. Neither harness
sees the other's files, and neither record claims the other's items.

**Unit under test:** `src/commands/install.ts::installCommand`
**Layer:** use case over an injected project directory
**Requirement:** "One folder, several harnesses" in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | two `install` steps, one per harness | `-t claude-code`, then `-t copilot` |
| `inputs/bundles/review-kit/` | the bundle | one resource of every kind |

The project starts empty, so every file in `outputs/tree/` came from one of the
two installs.

### Why each row exists

Two steps rather than one `-t claude-code copilot`, deliberately: installing
*separately* is the case where the second install could tread on the first, and
it is the one people actually run when they add a harness months later.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 16 files: 8 for Claude Code, 8 for Copilot | path order |
| `outputs/state.json` | the ledger, normalised | by installation id |

**Normalised away:** `installedAt`, and the absolute path of the local source
(kept as the bundle's directory name).

## Baseline provenance

- [x] **Computed by hand** — 8 + 8, the two file lists being exactly those in
  `claude-code-every-kind` and `copilot-every-kind`, which derive them from the
  "Where things land" table.

## Walkthrough

### The rules, stated once

1. An installation is identified by `<bundle>@<target>@<scope>`, so the same
   bundle in two harnesses is **two** records, not one record with two targets.
2. Each harness has its own roots, so the two file sets do not intersect.

### The count

| From | Files |
| --- | --- |
| Claude Code | `.claude/` (6) + `.mcp.json` + `CLAUDE.md` = 8 |
| Copilot | `.github/` (7) + `.vscode/mcp.json` = 8 |
| **Total** | **16** |

Count them in `outputs/tree/`. There is no overlap: Claude Code's context went
to `CLAUDE.md` and Copilot's to `.github/copilot-instructions.md`; their MCP
servers went to `.mcp.json` and `.vscode/mcp.json` — two different files holding
the same server.

### The ledger

`outputs/state.json` holds exactly two installations:

- `review-kit@claude-code@project`
- `review-kit@copilot@project`

Each lists only its own receipts. That separation is what makes
`uninstall-one-harness-of-two` next door possible at all.

## Why this proves the code is correct

- **It pins:** that two installs into one folder are two records, and that the
  16 files are 8 + 8 with nothing shared and nothing lost.
- **It would catch:** a second install overwriting the first's record, a harness
  writing into another's directory, and the Copilot install disturbing
  `CLAUDE.md`.
- **It does not cover:** harnesses that genuinely *do* share a file — Claude
  Code and Pi both write `.mcp.json`, which is its own concern.

## How to run and debug

```bash
make test-case CASE=two-harnesses-one-project
make debug-case CASE=two-harnesses-one-project
```

**Start here:** breakpoint in `src/core/state.ts`, in `upsertInstallation`, and
watch it called twice with two different ids.
