# Test case: dependency-installed-by-name-stays-yours

## What this proves

A bundle you installed **by name** stays yours when a bundle installed later
turns out to require it. It is not relabelled as an automatic dependency, and
removing the bundle that needed it does not take it away with it.

**Unit under test:** `src/commands/install.ts::installInto` — the `auto` flag —
and `src/commands/uninstall.ts`, which reads it
**Layer:** use case over an injected project directory
**Requirement:** "Coming back out" — a dependency leaves when the last bundle
needing it does; "Installing a dependency by name makes it yours"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | register both, install both, remove one | see below |
| `inputs/bundles/team-conventions/` | the shared background | installed **first, by name** |
| `inputs/bundles/sprint-kit/` | requires `team-conventions@^1.0.0` | installed second |

The two bundles are the pair from `dependency-installed-automatically`: the same
`jira-board` skill byte for byte, and one overlapping `allow` entry.

### The order is the whole case

```json
{ "install": "team-conventions" }   // the user asks for it
{ "install": "sprint-kit" }         // ...and this one happens to need it
{ "uninstall": "sprint-kit" }       // ...and then goes away again
```

This is the everyday order: install the shared kit, then a kit built on it. The
reverse order — dependency first as a dependency, then installed by name — is
covered by the `promotes a dependency to a bundle of its own` unit test.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 3 files, all `team-conventions`' own | path order |
| `outputs/state.json` | **one** installation, with **no** `auto` flag | by installation id |

## Baseline provenance

- [x] **Computed by hand** — `team-conventions` installs three items; the
  uninstall of `sprint-kit` takes back only what `sprint-kit` added.

## Walkthrough

### What each step leaves behind

| After | Project holds | Ledger |
| --- | --- | --- |
| `install team-conventions` | triager, skill, one allow-list | one record, not `auto` |
| `install sprint-kit` | + planner, + one allow entry; the skill is **shared**, not copied | two records |
| `uninstall sprint-kit` | planner and its allow entry gone; the rest held | one record, still not `auto` |

### The flag

An installation is automatic only when it is being pulled in as a dependency
**and** was not already the user's. Reading a missing `auto` field as "automatic"
would demote every bundle installed by name the moment something required it —
and the next `hcm uninstall <dependent>` would delete it as an orphan, without
asking.

### The allow-list, on the way out

`.claude/settings.json` ends with `team-conventions`' own two entries.
`Bash(git log:*)` was contributed by both bundles, so removing `sprint-kit`
drops `sprint-kit`'s claim on it and leaves the entry: an array item goes only
when the last claim on it does.

### The skill

`.claude/skills/jira-board/SKILL.md` stays. `sprint-kit` shared it rather than
writing a second copy, so its removal releases a claim rather than a file.

## Why this proves the code is correct

- **It pins:** the `auto` flag is decided once, and never demotes an
  installation the user asked for.
- **It would catch:** `previous.auto ?? true` — reading an explicit
  installation as automatic — which ends with the user's bundle deleted by an
  unrelated uninstall, and shows up here as an empty `outputs/tree/`.
- **It does not cover:** promotion in the other direction, or what happens when
  two dependents share one dependency (`dependency-removed-when-orphaned`).

## How to run and debug

```bash
make test-case CASE=dependency-installed-by-name-stays-yours
make debug-case CASE=dependency-installed-by-name-stays-yours
```

**Start here:** breakpoint in `src/commands/install.ts` where `auto` is worked
out, then in `src/commands/uninstall.ts` where orphans are collected.
