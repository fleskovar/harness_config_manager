# Human-readable cases

Real bundles in, real project trees out, and a `README.md` that walks you from
one to the other.

The rest of the suite is written for the machine. **This layer is written for
you.** Open a case's `inputs/`, read its `README.md`, work out what should come
out — then open `outputs/` and check. If you can do that without running
anything, the case is doing its job.

```text
tests/cases/claude-code-every-kind/
    inputs/
        case.json                  the commands to run, in order
        bundles/sample-kit/...     the bundle they install
    outputs/
        tree/...                   every file in the project afterwards
    README.md                      the walkthrough
```

Two jobs, and the second is the one people underestimate:

1. **Proof.** `outputs/` is the baseline, and the case fails the moment
   behaviour drifts from it.
2. **Documentation that cannot go stale.** A developer meeting hcm for the first
   time reads a case README, opens the two folders, then steps a debugger
   through it. Prose documentation rots silently; a case that rots turns the
   build red.

These do **not** replace the unit tests next door in `tests/*.test.ts`. A rule
with ten branches gets ten unit tests and one case — the case is there to say
what the rule *is*, in a form a person can check.

## Running one

```bash
make test-cases                              # all of them
make test-case CASE=claude-code-every-kind   # one
make debug-case CASE=claude-code-every-kind  # one, under the debugger
npm run case -- claude-code-every-kind        # one, printed, no debugger
npm run case -- claude-code-every-kind --keep # ...and leave the project on disk
```

`debug-case` and `case` go through `tests/run-case.ts`, which has no test
framework in the call stack: a breakpoint in `src/` is three frames from the
top. That is the fastest way to learn a part of hcm you have not read yet.

## Adding one

**Adding a case is adding a folder.** `tests/case-runner.test.ts` discovers them
from disk and is never edited for a new case.

1. `mkdir -p tests/cases/<name>/inputs/bundles`
2. Put the bundle(s) in `inputs/bundles/<bundle-name>/`, and anything the
   project already had in `inputs/project/`.
3. Write `inputs/case.json` (below).
4. Generate the baseline once — `UPDATE_BASELINES=1 make test-case CASE=<name>`
   — then **read every line of it** and satisfy yourself it is what the
   requirement says, not merely what the code did.
5. Write `README.md` from
   `.claude/skills/human-readable-tests/template.md`. The walkthrough is the
   point; a case without one fails its own "is documented" check.
6. **Break the implementation and watch it go red**, then undo. A baseline you
   have not seen fail proves nothing.

### `inputs/case.json`

```json
{
  "describes": "one line, used as the test name",
  "recordState": false,
  "steps": [
    { "install": "review-kit", "targets": ["claude-code"] }
  ]
}
```

`steps` run in order. Every verb is one hcm command with its flags, or one edit
to the project between commands:

| Step | Runs |
| --- | --- |
| `{ "install": "kit" \| ["a","b"] }` | `hcm install`. Flags: `targets`, `scope`, `flavors`, `params`, `paramsFiles`, `onConflict`, `resolve`, `noDeps`, `force`, `dryRun`, `register` |
| `{ "update": "kit" \| null }` | `hcm update`; `null` means the bare `hcm update`. Flags: `targets`, `scope`, `flavors`, `params`, `reconfigure`, `force`, `dryRun` |
| `{ "uninstall": "kit" }` | `hcm uninstall`. Flags: `targets`, `scope`, `force`, `cascade`, `keepOrphans`, `ignoreDependents`, `dryRun` |
| `{ "context": "append" \| "override" \| "remove" }` | `hcm context …`. Flags: `bundles`, `targets`, `scope`, `force`, `dryRun` |
| `{ "validate": "kit" }` | `hcm validate` → `outputs/report.json` |
| `{ "refs": "kit" }` | `hcm refs check` → `outputs/report.json`. Flags: `links`, `allPaths`, `strict`, and `as` to name the output document |
| `{ "register": "kit", "dev": true }` | `hcm registry add` |
| `{ "replaceBundle": "kit", "with": "kit-v2" }` | an upstream release: same name, new files |
| `{ "writeFile": "CLAUDE.md", "from": "rewritten.md" }` | an agent rewrites a file (`from` names a file in `inputs/`) |
| `{ "appendFile": ".claude/agents/x.md", "text": "…" }` | somebody edits a file by hand |

Add `"fails": true` to a command step that is *supposed* to be refused. Its
message goes to `outputs/error.txt`, and the tree that follows proves the
refusal was total.

Set `"recordState": true` when the case is about **who owns what** rather than
what the files say; the ledger is then written to `outputs/state.json`, with
timestamps and absolute paths normalised out.

### What goes in `outputs/`

| File | When |
| --- | --- |
| `tree/**` | always — every file in the project afterwards |
| `state.json` | `recordState: true` — the installation ledger, normalised |
| `report.json` | a `validate` or `refs` step ran |
| `report-*.json` | a `refs` step named its output with `as`, so one case can show two scopes side by side |
| `error.txt` | a step was marked `fails` |

`tree/` is **exhaustive**: a file absent from it must be absent from the
project. That is what lets one comparison replace a dozen assertions — and it is
why the narrative these cases were converted from ("the rule's globs became
`paths`") lives in the README. The tree already proves it; the README says why.

`.hcm/` is excluded from `tree/`: it is hcm's own bookkeeping, and it holds
timestamps and absolute paths that have no business in a baseline.

## The rules these cases follow

- **Human-solvable.** A developer who has never seen the code can read
  `inputs/`, apply the rules in the README, and arrive at `outputs/`. If a case
  needs volume to show its behaviour, it needs a different kind of test.
- **Every row earns its place.** Each resource in a case's bundle demonstrates
  one thing, and the README says which. A resource you cannot justify is one to
  delete.
- **One behaviour per folder.** `flavor-narrows-to-python` and
  `flavor-widens-back-to-all`, not `flavors`.
- **Deterministic.** No clock, no network, no absolute path, no `~/.hcm`. Every
  ambient input is a file in `inputs/`; `HCM_HOME` is redirected into a scratch
  directory for the run. A case gives the same answer on any machine in any
  month.
- **Provenance is written down.** Every README ticks one of: computed by hand
  from the requirement, taken from a named oracle, or generated and then
  reviewed line by line. "Whatever the code printed" is not on the list.

## Regenerating a baseline

```bash
UPDATE_BASELINES=1 make test-case CASE=<name>   # one
make bless                                       # all of them
```

1. **A regenerated baseline is a diff a human reads, line by line, before it is
   committed.** If you cannot explain every changed line, stop.
2. **Never regenerate to make a red build green.** A case that turns red is
   either a real regression or a genuine requirement change — and the second is
   a product decision.
3. **A requirement change gets a new case**, not an overwritten one, whenever
   the old behaviour still holds for other inputs.
4. **The regenerating commit changes baselines and nothing else**, so review can
   see it.

## What is *not* here

Behaviour that is not case-shaped stays in `tests/*.test.ts`:

| Lives in a unit test | Why |
| --- | --- |
| `semver.test.ts` | range parsing — a table of pairs, not a project tree |
| `json-merge.test.ts`, `blocks.test.ts`, `toml.ts` | pure functions over strings and documents |
| `refmap.test.ts`, `refs.test.ts` | the reference algebra, exercised across hundreds of inputs |
| `conflicts.test.ts` | resolver interactions, where the assertion is "it asked me this" |
| `github-source.test.ts` | network shapes, faked at the boundary |
| `registry.test.ts` | id allocation and the store |

See `.claude/skills/human-readable-tests/SKILL.md` for the practice this layer
comes from, and `tests/fixtures/README.md` for the shared fixtures the unit
tests still use.
