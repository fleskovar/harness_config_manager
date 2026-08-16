# Test case: dependency-blocks-its-removal

## What this proves

Removing a bundle that something else still depends on is **refused**, and
nothing is written. A dependency taken out from under its dependent leaves a
breakage `hcm status` cannot see, because every item the dependent owns is still
exactly where it left it.

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

The final step uninstalls **`team-conventions`** - the dependency - and is
marked `fails`.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 4 files - the full install, untouched | path order |
| `outputs/error.txt` | the refusal, naming who still needs it | - |

## Baseline provenance

- [x] **Computed by hand** - the refusal writes nothing, so the baseline is the
  state after `dependency-installed-automatically`.

## Walkthrough

1. The uninstall names `team-conventions`.
2. `withDependents` looks for installations that recorded it as a dependency, in
   the same scope and target, and finds `sprint-kit`.
3. The run stops before anything is removed. `outputs/error.txt`:

   ```
   Other installed bundles still depend on this one: team-conventions (claude-code) is required by sprint-kit
   ```

   The message names both bundles and the harness, because in a multi-harness
   folder the answer can differ per harness.
4. `outputs/tree/` is byte-identical to
   `dependency-installed-automatically/outputs/tree/`:

   ```bash
   diff -r tests/cases/dependency-blocks-its-removal/outputs/tree \
           tests/cases/dependency-installed-automatically/outputs/tree
   ```

### The two ways through

The error is a fork, not a wall:

- `--cascade` removes the dependents as well - `dependency-cascade-removes-dependent`.
- `--ignore-dependents` removes it anyway and leaves them broken, deliberately.

### Why "in the same scope and target"

Dependency satisfaction is per installation, and an installation is
`bundle@target@scope`. `team-conventions` in the user scope does not satisfy
`sprint-kit` in the project scope, so the check is made at that granularity
rather than by name alone.

## Why this proves the code is correct

- **It pins:** the dependents check, that the refusal is total, and that the
  message names the dependent and the harness.
- **It would catch:** a removal that silently broke its dependents, and one that
  removed some items before discovering the problem.
- **It does not cover:** a chain of three bundles, which the `--cascade` path
  unwinds breadth-first.

## How to run and debug

```bash
make test-case CASE=dependency-blocks-its-removal
make debug-case CASE=dependency-blocks-its-removal
```

**Start here:** breakpoint in `src/core/state.ts`, in `findDependents`.
