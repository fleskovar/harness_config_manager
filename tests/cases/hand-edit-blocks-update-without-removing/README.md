# Test case: hand-edit-blocks-update-without-removing

## What this proves

One hand-edited file stops `hcm update` from updating **that harness**, and it
stops it *before anything is removed*. The other harness in the same folder is
still updated in the same run.

This is the case for a defect. `hcm update` is rollback-then-install, and its
rollback used to behave the way `hcm uninstall`'s does: take away every item
that can be taken away, and report the one that cannot. Update then refuses to
install over a removal that did not finish - so a single edited file deleted
everything else Pi had and put nothing back, while the ledger went on claiming
all nine items. In a two-harness folder it looked like a success, because Claude
Code updated normally.

**Unit under test:** `src/commands/uninstall.ts::rollbackInstallation`, through
`src/commands/update.ts::updateCommand`
**Layer:** use case over an injected project directory
**Requirement:** "Updating" in the top-level `README.md` - *"Items you
hand-edited since install still block the way they do for `hcm uninstall`, so an
update never silently discards local changes."*

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | register `--dev`, install into two harnesses, edit one file, publish v2, update | 5 steps |
| `inputs/bundles/review-kit/` | version 1.0.0 | one resource of every kind |
| `inputs/bundles/review-kit-v2/` | version 2.0.0 | the same kit, one release on |

### Why each row exists

The two bundles are the pair from `update-to-a-new-version`, unchanged, so the
"what did v2 do" half of this case is already solved there:

| Change in v2 | What it should do to a harness that updates |
| --- | --- |
| `subagents/code-reviewer.md` renamed to `change-reviewer.md` | the old file goes, the new one arrives |
| `context/20-pull-requests.md` deleted | its marker block goes out of the instruction file |
| `skills/dependency-audit/checklist.md` gains a line | the file is rewritten |

Two harnesses, because that is the shape the defect was reported in and the
shape that hides it: **Claude Code** has nothing edited and must reach v2,
**Pi** has one edited file and must stay whole at v1.

The edited file is chosen on purpose. On Pi a subagent is filed as a skill, so
`.pi/skills/` holds both the skill and the subagent - and a rollback that ran
would empty that one directory of both. The edit itself is a comment appended
to `.pi/skills/dependency-audit/SKILL.md`:

```
<!-- A note somebody added locally. -->
```

`-t all` on the update step is `hcm update review-kit -t all`: every harness,
which is what makes one blocked harness a thing the run has to carry on past
rather than a thing it can stop at.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 6 files under `.claude/` and `.mcp.json`/`CLAUDE.md` at v2; 5 under `.pi/` and `AGENTS.md` at v1 | path order |
| `outputs/state.json` | two records: claude-code at 2.0.0, pi still at 1.0.0 | by installation id |

## Baseline provenance

- [x] **Computed by hand** - 8 items installed into Claude Code and 9 into Pi;
      8 replaced, 9 left alone.

## Walkthrough

### What each harness had after the install

Claude Code takes eight items: the subagent, the command, the rule and both
skill files as files, one `CLAUDE.md` block per context section, the settings
permission, and the MCP server in `.mcp.json`.

Pi takes nine. It has no per-file rule format and no agents directory, so two
things land elsewhere: the rule joins the context sections as a third `AGENTS.md`
block, and the subagent is filed as a skill at
`.pi/skills/code-reviewer/SKILL.md`. That is why the two counts differ.

### Claude Code, which is not blocked

Every one of its eight items still hashes to its receipt, so the rollback runs,
the record is dropped, and v2 is installed in its place. Reading the tree:

1. `.claude/agents/change-reviewer.md` exists and `code-reviewer.md` does not -
   the rename went through in both directions.
2. `CLAUDE.md` holds one block, `review-kit/10-conventions`. The
   `20-pull-requests` section was deleted upstream, so its block goes with it.
3. `.claude/skills/dependency-audit/checklist.md` ends with the v2 line.

### Pi, which is blocked

`.pi/skills/dependency-audit/SKILL.md` no longer hashes to its receipt, so it is
reported `modified`. That answer is now settled **before** the first item is
removed, and it applies to the whole installation:

1. Nothing under `.pi/` is deleted. `.pi/skills/code-reviewer/SKILL.md` is still
   there - the file the old behaviour lost.
2. Nothing is written either. `checklist.md` has no v2 line, and `AGENTS.md`
   still holds all three v1 blocks, `20-pull-requests` included.
3. The edit survives, comment and all. It was the point of refusing.
4. `outputs/state.json` still records `review-kit@pi@project` at version
   **1.0.0** with all nine receipts - and every one of those receipts names a
   file that is really there, which is the property the defect broke.

### Why `.mcp.json` and the settings look untouched

Both harnesses write the same MCP server to the same `.mcp.json`, and v2 does
not change it, so there is nothing to see either way. It is in the tree because
it is in the tree after any install of this bundle, not because this case has
anything to say about it.

## Why this proves the code is correct

- **It pins:** that a blocked update removes nothing at all; that the block is
  per installation, so one harness being blocked does not hold up another; and
  that a record left in the ledger still describes what is on disk.
- **It would catch:** the original defect exactly - a rollback that deletes what
  it can before discovering what it cannot, on a command that will not then
  reinstall. It would also catch an over-correction that let the update proceed
  and threw the local edit away, since the note would be gone from
  `.pi/skills/dependency-audit/SKILL.md`.
- **It does not cover:** `hcm update --force`, which is *meant* to replace the
  edited item, or `hcm uninstall`, which is meant to keep removing what it can -
  both are in `tests/update-blocked-rollback.test.ts`, and the uninstall side
  has its own case in `hand-edited-file-blocks-uninstall`.

## How to run and debug

```bash
make test-case CASE=hand-edit-blocks-update-without-removing
make debug-case CASE=hand-edit-blocks-update-without-removing
```

**Start here:** breakpoint on the `allOrNothing` pass in
`src/commands/uninstall.ts::rollbackInstallation`, then step into
`src/core/rollback.ts` where the receipt hash is compared against the file on
disk.
