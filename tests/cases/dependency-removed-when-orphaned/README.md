# Test case: dependency-removed-when-orphaned

## What this proves

Uninstalling `sprint-kit` takes `team-conventions` with it, once nothing needs
it any more - and the shared skill and the shared permission go too, because the
last claim on them has gone.

**Unit under test:** `src/commands/uninstall.ts::pruneOrphans`
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
| `outputs/tree/` | **empty** | - |
| `outputs/state.json` | `installations: []` | - |

## Baseline provenance

- [x] **Computed by hand** - the project was empty before; both bundles are gone;
  therefore nothing is left.

## Walkthrough

### Why the dependency goes

`team-conventions` was recorded with `"auto": true` - nobody asked for it by
name. When the only bundle that required it is removed, it is an orphan, and an
orphan is removed too. Had it been installed explicitly at some point, that flag
would be absent and it would stay.

### Why the shared items go

The skill `jira-board` is claimed by **two** installations. Removing the first
leaves one claim and the file stays. Removing the second leaves none, so it
goes. Same for the shared entry in `permissions.allow`.

Both removals happen in this one command, which is why the end state is empty
rather than "one skill and one permission left over".

### The order

`sprint-kit` is removed first, then the orphan check runs and takes
`team-conventions`. Doing it the other way round would hit the guard in
`dependency-blocks-its-removal`.

### The contrast

`dependency-kept-with-keep-orphans` is this exact command with one flag added,
and it ends with three files. Reading the two together is the fastest way to see
what the flag is for.

## Why this proves the code is correct

- **It pins:** orphan pruning, and claim-counted removal of shared items.
- **It would catch:** a dependency left behind for ever, a shared file deleted
  while another bundle still claimed it, and a shared permission entry left in
  `settings.json` after both owners had gone.
- **It does not cover:** an explicitly-installed bundle that also happens to be
  a dependency, which must not be pruned.

## How to run and debug

```bash
make test-case CASE=dependency-removed-when-orphaned
make debug-case CASE=dependency-removed-when-orphaned
```

**Start here:** breakpoint in `src/commands/uninstall.ts`, in `pruneOrphans`.
