# Test case: dependency-from-a-relative-source

## What this proves

A `source` in a manifest that is a **relative path** is read against the
manifest that wrote it — not against the directory `hcm` happens to be run in.
`sprint-kit` is installed into a project two folders away from both bundles, and
its dependency is still found.

**Unit under test:** `src/core/deps.ts::fromDeclaredSource` and
`declaredSources`
**Layer:** use case over an injected project directory
**Requirement:** "Where a dependency is looked for" — registry, sibling, then
the `source` the dependency itself names

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | one install, nothing registered | see below |
| `inputs/bundles/sprint-kit/` | the dependent | requires `team-conventions` |
| `inputs/bundles/shared/team-conventions/` | the dependency | **one level down** |

### The layout is the point

```text
bundles/
    sprint-kit/            hcm.yaml -> source: ../shared/team-conventions
    shared/
        team-conventions/  the dependency
```

Three routes to a dependency are ruled out on purpose, so only the fourth is
left:

| Route | Why it cannot fire here |
| --- | --- |
| already in this run | only `sprint-kit` was named |
| the registry | nothing is registered — no `register` step |
| a sibling in the same collection | `shared/` holds no manifest, so `team-conventions` is not an immediate child of `bundles/` |
| **its `source`** | **the one that has to work** |

The install runs with the project directory as the working directory, and the
project is `workspace/project` — nowhere near `workspace/bundles`. Reading
`../shared/team-conventions` from there lands on a folder that does not exist.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 4 files | path order |
| `outputs/state.json` | two installations, the dependency marked `auto` | by installation id |

## Baseline provenance

- [x] **Computed by hand** — the same four files as
  `dependency-installed-automatically`, since only the *route* to the dependency
  differs.

## Walkthrough

### What resolution does

`sprint-kit` declares `source: ../shared/team-conventions`. That path is joined
to the bundle's own directory, `workspace/bundles/sprint-kit`, giving
`workspace/bundles/shared/team-conventions` — the dependency. It is loaded,
ordered first, and installed first.

Had the path been joined to the working directory instead, it would have named
`workspace/shared/team-conventions`, and the install would have stopped with
*"sprint-kit" requires the bundle "team-conventions", which hcm cannot find*.

### The four files

| File | From |
| --- | --- |
| `.claude/agents/sprint-planner.md` | sprint-kit |
| `.claude/agents/ticket-triager.md` | team-conventions |
| `.claude/skills/jira-board/SKILL.md` | **both** — one copy, two claims |
| `.claude/settings.json` | both, merged, the shared entry once |

### The ledger

`team-conventions` carries `"auto": true` — nobody asked for it by name.
`sprint-kit` records the dependency it resolved, with the version that satisfied
`^1.0.0`.

## Why this proves the code is correct

- **It pins:** a relative `source` is manifest-relative, and a dependency found
  that way installs exactly like one found any other way.
- **It would catch:** resolving the path against the working directory (the
  install fails outright), and resolving it against the wrong base — a store
  snapshot's directory, say — which would also fail to find the bundle.
- **It does not cover:** GitHub sources, absolute-path sources, or the
  registry route, which the unit tests in `tests/dependencies.test.ts` cover.

## How to run and debug

```bash
make test-case CASE=dependency-from-a-relative-source
make debug-case CASE=dependency-from-a-relative-source
```

**Start here:** breakpoint in `src/core/deps.ts`, in `declaredSources`, and look
at the bases it builds for the requiring bundle.
