# Test case: dependency-no-deps-flag

## What this proves

`--no-deps` installs only what was named. The dependency is not fetched, not
installed and not recorded - and the bundle that needed it is installed anyway,
incomplete, because that is what was asked for.

**Unit under test:** `src/commands/install.ts::installCommand`
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
| `outputs/state.json` | **one** installation | by installation id |

## Baseline provenance

- [x] **Computed by hand** - `dependency-installed-automatically` minus
  everything `team-conventions` contributed.

## Walkthrough

### The comparison that carries this case

```bash
diff -r tests/cases/dependency-no-deps-flag/outputs/tree \
        tests/cases/dependency-installed-automatically/outputs/tree
```

One file is missing here: `.claude/agents/ticket-triager.md`, the dependency's
subagent. And `.claude/settings.json` differs by one entry in `permissions.allow`.

Three files rather than four:

| File | Still here because |
| --- | --- |
| `.claude/agents/sprint-planner.md` | sprint-kit ships it |
| `.claude/skills/jira-board/SKILL.md` | **sprint-kit ships it too** |
| `.claude/settings.json` | sprint-kit's entry alone |

### The skill is the interesting row

It is still here. It is not a leftover from the dependency - `team-conventions`
was never installed - it is sprint-kit's own copy, which happens to be identical.
That is why the file count drops by one rather than two.

### What is *not* here

`outputs/state.json` holds one installation, and it has no `dependencies` entry
worth the name: nothing was resolved, so nothing was recorded. A later
`hcm install team-conventions` would fill the gap.

### The honest limitation

The installed `sprint-kit` may not work. `--no-deps` is for the case where you
know the dependency is already provided some other way; hcm warns and installs
what you asked for rather than second-guessing.

## Why this proves the code is correct

- **It pins:** that `--no-deps` suppresses the dependency entirely while still
  installing the named bundle, and that a file the dependent ships in its own
  right is unaffected.
- **It would catch:** a `--no-deps` that still installed the dependency, one
  that refused the install outright, and one that skipped the shared skill on
  the grounds that it "belongs to" the dependency.
- **It does not cover:** the warning printed, which is log output.

## How to run and debug

```bash
make test-case CASE=dependency-no-deps-flag
make debug-case CASE=dependency-no-deps-flag
```

**Start here:** breakpoint in `src/commands/install.ts`, in
`withoutDependencies`.
