# Test case: dependency-installed-automatically

## What this proves

Installing `sprint-kit` installs `team-conventions` first, without being asked
to; the skill both bundles ship is written **once** and claimed by both; and
their two allow-lists are added together without repeating the entry they share.

**Unit under test:** `src/core/deps.ts::resolveDependencyGraph` and
`src/commands/install.ts`
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
| `outputs/tree/**` | 4 files | path order |
| `outputs/state.json` | two installations, one marked `auto` | by installation id |

## Baseline provenance

- [x] **Computed by hand** - two subagents, one shared skill, one merged
  settings file.

## Walkthrough

### The four files, derived

| File | From |
| --- | --- |
| `.claude/agents/sprint-planner.md` | sprint-kit |
| `.claude/agents/ticket-triager.md` | team-conventions |
| `.claude/skills/jira-board/SKILL.md` | **both** - one copy |
| `.claude/settings.json` | both, merged |

Four, not five: the skill appears once. Two bundles shipping the same file is
not a conflict and not a duplicate - it is one file with two claims on it.

### The order, and why it matters

`team-conventions` is installed **first**. By the time `sprint-kit` is planned,
the skill is already on disk and already claimed, so `sprint-kit` finds an
identical item with an existing claim and **shares** it rather than colliding
with it. Reverse the order and the sharing would still work, but only because
the same rule applies in both directions.

### The allow-list

`.claude/settings.json` holds `permissions.allow` with the union of the two
bundles' entries, and the entry they share appears **once**. An array in a
settings fragment is appended to, and an item another installation already
contributed is claimed rather than added again.

### The ledger

Two installations. `team-conventions` carries `"auto": true` - it was pulled in
rather than asked for, which is what lets `dependency-removed-when-orphaned`
take it away later. `sprint-kit` records the dependency it resolved, with the
version that satisfied the range.

## Why this proves the code is correct

- **It pins:** dependency-first ordering, one copy of a shared file with two
  claims, a merged allow-list with no duplicate, and the `auto` flag.
- **It would catch:** a dependency not installed at all, the shared skill
  written twice or reported as a conflict, a duplicated permission entry, and a
  dependency recorded as if the user had asked for it.
- **It does not cover:** what happens on removal, which is the next four cases.

## How to run and debug

```bash
make test-case CASE=dependency-installed-automatically
make debug-case CASE=dependency-installed-automatically
```

**Start here:** breakpoint in `src/core/deps.ts`, in `resolveDependencyGraph`,
then in `src/core/planner.ts` where `action.share` is set.
