# Test case: dependency-kept-with-keep-orphans

## What this proves

`--keep-orphans` leaves the dependency installed, along with its skill and its
permissions - and the departing bundle still takes its own contributions with it.

**Unit under test:** `src/commands/uninstall.ts::uninstallCommand`
**Layer:** use case over an injected project directory
**Requirement:** "Dependencies: bundles that build on other bundles"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | register the dependency, then act | see below |
| `inputs/bundles/sprint-kit/` | the dependent | requires `team-conventions` |
| `inputs/bundles/team-conventions/` | the dependency | the shared background |

### The two bundles

They are a deliberate pair, and three things about them matter:

| | `sprint-kit` | `team-conventions` |
| --- | --- | --- |
| subagent | `sprint-planner` | `ticket-triager` |
| skill | `jira-board` | `jira-board` - **the same skill, byte for byte** |
| settings | one `allow` entry | one `allow` entry, **one of them shared** |

The duplicated skill and the overlapping allow-list are not accidents of the
fixture. They are how a dependency tree actually looks - two bundles that assume
the same background ship some of it twice - and every case in this family turns
on them.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 3 files | path order |
| `outputs/state.json` | one installation - the dependency | by installation id |

## Baseline provenance

- [x] **Computed by hand** - four files minus sprint-kit's own subagent, with the
  shared skill and one of the two permission entries surviving on
  `team-conventions`' claim.

## Walkthrough

### The three that stay

| File | Whose claim keeps it |
| --- | --- |
| `.claude/agents/ticket-triager.md` | `team-conventions` |
| `.claude/skills/jira-board/SKILL.md` | `team-conventions` - the **second** claim |
| `.claude/settings.json` | `team-conventions`' two allow entries |

### The one that goes

`.claude/agents/sprint-planner.md`. `--keep-orphans` is about the *dependency*,
not about the bundle you actually asked to remove.

### The shared skill is the whole point

It stays, and it stays **unchanged**. When `sprint-kit`'s claim was released,
one claim remained, so the file was not touched. This is the middle of the
sequence the other cases show the ends of:

| Claims on `jira-board/SKILL.md` | State |
| --- | --- |
| 2 | one file on disk (`dependency-installed-automatically`) |
| 1 | still one file, unchanged (**here**) |
| 0 | gone (`dependency-removed-when-orphaned`) |

### The settings file

The two bundles contribute overlapping allow-lists:

| Entry | sprint-kit | team-conventions |
| --- | --- | --- |
| `Bash(git log:*)` | yes | yes |
| `Bash(npm test:*)` | yes | - |
| `WebFetch(domain:jira.example.com)` | - | yes |

A full install merges them to **three** entries. After this uninstall, exactly
one is gone - `Bash(npm test:*)`, the only one sprint-kit contributed alone.
`Bash(git log:*)` survives on team-conventions' claim even though sprint-kit
also contributed it, which is the array counterpart of the shared skill above.

```bash
diff tests/cases/dependency-kept-with-keep-orphans/outputs/tree/.claude/settings.json \\
     tests/cases/dependency-installed-automatically/outputs/tree/.claude/settings.json
```

## Why this proves the code is correct

- **It pins:** that `--keep-orphans` spares only the orphan, that a shared file
  survives on its remaining claim, and that a partly-shared array loses exactly
  the unshared entry.
- **It would catch:** a flag that also spared the named bundle, a shared skill
  deleted while still claimed, and an allow-list emptied wholesale.
- **It does not cover:** several orphans at once, or an orphan chain.

## How to run and debug

```bash
make test-case CASE=dependency-kept-with-keep-orphans
make debug-case CASE=dependency-kept-with-keep-orphans
```

**Start here:** breakpoint in `src/core/state.ts`, in `collectClaims`.
