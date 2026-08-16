# Test case: dependency-cascade-removes-dependent

## What this proves

`--cascade` answers the refusal in `dependency-blocks-its-removal` by removing
the dependent as well, leaving the project empty.

**Unit under test:** `src/commands/uninstall.ts::withDependents`
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

The final step uninstalls **`team-conventions`** with `"cascade": true`.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/` | **empty** | - |
| `outputs/state.json` | `installations: []` | - |

## Baseline provenance

- [x] **Computed by hand** - both bundles go, and the project was empty before.

## Walkthrough

### The set is computed before anything is removed

1. `team-conventions` is named.
2. Its dependents are found - `sprint-kit` - and added to the set. Then *their*
   dependents are looked for, breadth-first, so a chain of three would unwind in
   one command. Here the search ends after one round.
3. Both records are then rolled back together.

### Why the order inside the removal matters less than it looks

Both installations are in the removal set, so when the shared skill is
considered, the claims held by *either* of them are discounted. The item ends
with no surviving claim and is removed once, cleanly.

Had they been removed as two separate commands, the first would have left the
skill in place on the second's claim - which is exactly
`dependency-kept-with-keep-orphans`. The difference between these two outcomes
is the `alsoRemoving` list, and this case is what proves it is honoured.

### The end state

Identical to `dependency-removed-when-orphaned`: an empty project and an empty
ledger. The two cases reach it from opposite directions - one by removing the
dependent and pruning the orphan, the other by removing the dependency and
cascading to the dependent - and both must arrive at the same place.

## Why this proves the code is correct

- **It pins:** breadth-first dependent collection, and that claims held by other
  installations in the same removal set do not keep an item alive.
- **It would catch:** a cascade that removed only the named bundle, and a shared
  item left behind because the run counted a claim it was itself about to drop.
- **It does not cover:** `--ignore-dependents`, the other answer to the same
  refusal.

## How to run and debug

```bash
make test-case CASE=dependency-cascade-removes-dependent
make debug-case CASE=dependency-cascade-removes-dependent
```

**Start here:** breakpoint in `src/commands/uninstall.ts`, in `withDependents`,
and watch the queue.
