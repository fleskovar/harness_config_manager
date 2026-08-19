# Test case: refs-ignores-prose-filenames

## What this proves

A skill's prose names six files. Exactly two of them are references. `hcm refs
check` reports the one that is broken and says nothing about the four that were
never references at all — and `--all-paths` and `--strict` show, side by side,
exactly what the default scope stepped over and why you would not want it back.

**Unit under test:** `src/core/refs.ts::isInScope`
**Layer:** pure analysis over a bundle directory
**Requirement:** "References: written once, repointed on the way in"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | the same bundle scanned under three scopes | no install at all |
| `inputs/bundles/scaffold-kit/` | one skill, six filenames in its prose | 4 files |

### Why each row exists

`skills/scaffold/SKILL.md` names six files. Read it and sort them yourself
before opening `outputs/`:

| It says | Written as | Is it a reference? |
| --- | --- | --- |
| `` `service.yaml` `` | inline code, bare | **No** — "a file will be created named…" |
| `` `build/manifest.json` `` | inline code, implicit path | **No** — the same sentence, with a directory |
| `` `logs/scaffold.txt` `` | inline code, implicit path | **No** — where the run log lands |
| `` `package.json` ``, `` `tsconfig.json` `` | inline code, bare | **No** — the target project's, not this bundle's |
| `` `./checklist.md` `` | inline code, **explicitly relative** | **Yes** — and it resolves |
| `[the naming conventions](context/naming.md)` | a **link** | **Yes** — and it is **broken** |
| `templates/service.yaml` | inside a fenced block | **No** — an example command |

Three of the "no" rows have a `/` in them. That is deliberate: a separator used
to be treated as proof of intent, and it is not. `build/manifest.json` in a
sentence about writing a file is a sentence, not a claim about this tree.

The two "yes" rows are the two forms that mark a reference: an explicit `./`,
and a link whose target markdown has already declared to be a path.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/report.json` | the default scope — **one** broken reference | by file, then by position |
| `outputs/report-all-paths.json` | `--all-paths` — **two** | the same |
| `outputs/report-strict.json` | `--strict` — **four** | the same |
| `outputs/tree/` | empty — nothing is installed | — |

## Baseline provenance

- [x] **Computed by hand** — the table above is the derivation, sorted before
  the checker was run.

## Walkthrough

### `report.json` — the default

One entry: `context/naming.md`, a link, suggesting
`context/naming-conventions.md`. That is a real mistake, and it is the only one.

`./checklist.md` is in scope and resolves, so it does not appear. The four prose
filenames are not in scope at all, so they cannot appear whether they resolve or
not.

### `report-all-paths.json` — the ladder's first rung

Two entries. `build/manifest.json` joins the report, with **no suggestions** —
there is nothing in the bundle remotely like it, because it is not a file the
bundle has anything to do with.

That entry is the bug this scope rule was written for. A checker that prints it
is telling the author their skill is broken when their skill is fine, and the
next twenty reports get skimmed instead of read.

`logs/scaffold.txt` does *not* appear here even under `--all-paths`: it is a
bare-ish path with nothing similar in the tree, so it is weak, and a weak
reference with no fix to offer is held back until `--strict`. `service.yaml` is
held back for the same reason.

### `report-strict.json` — everything

Four entries: `service.yaml` and `logs/scaffold.txt` join the other two. This is
the loudest the checker gets, and it is the old default plus the old `--strict`.

Note what is *still* absent at maximum volume: `package.json`, `tsconfig.json`
and the `templates/service.yaml` inside the fenced code block. Those are filtered
by rules that have nothing to do with scope — a well-known-filenames list and the
fence mask — and they hold at every setting.

### The `scope` block

Each report leads with the scope it ran under, so a baseline can never be read
against the wrong one. `report-strict.json` records `allPaths: true` as well as
`strict: true`: `--strict` implies `--all-paths`, and the record says what the
scan *did*, not what was typed.

## Why this proves the code is correct

- **It pins:** that a bare filename and an implicit path are not references, that
  an explicit `./` and a link target are, and the exact contents of all three
  rungs of the scope ladder.
- **It would catch:** a regression that let prose back into the default report,
  a `--all-paths` that stopped finding implicit paths, a `--strict` that stopped
  reporting suggestion-less weak references, and a scope record that lied about
  `--strict` implying `--all-paths`.
- **It does not cover:** suggestion ranking (`refs-finds-four-broken`),
  wikilinks or `--links` (`refs-checks-links-and-wikilinks`), or applying a fix.

## How to run and debug

```bash
make test-case CASE=refs-ignores-prose-filenames
make debug-case CASE=refs-ignores-prose-filenames
```

Or by hand, three times, which is the whole case:

```bash
KIT=tests/cases/refs-ignores-prose-filenames/inputs/bundles/scaffold-kit
npx tsx src/cli.ts refs check --path $KIT
npx tsx src/cli.ts refs check --path $KIT --all-paths
npx tsx src/cli.ts refs check --path $KIT --strict
```

**Start here:** breakpoint in `src/core/refs.ts`, in `isInScope`. Every one of
the differences between the three reports is decided on those three lines.
