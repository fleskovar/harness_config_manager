# Test fixtures

Real bundles, checked in as files, shared by the unit tests.

These are the assets `tests/*.test.ts` build on. They are *not* where the
readable tests live — those are in [`tests/cases/`](../cases/README.md), where
each case owns its own copy of everything it needs and comes with a walkthrough.
The split is deliberate:

| | `tests/fixtures/` | `tests/cases/` |
| --- | --- | --- |
| Used by | the unit tests, many of them at once | one case folder each |
| Shared? | yes — one `review-kit` serves several files | no — every case has its own copy |
| Documented by | this file | each case's own `README.md` |
| Answers | "what does this function do with a real bundle?" | "what does hcm *do*, and why?" |

Nothing here is modified by the tests. Each one is copied into a temp directory
first, so you can run destructive commands against these files as often as you
like: `git checkout` puts them back.

## What is here

| Fixture | Used by | What it is |
| --- | --- | --- |
| `bundles/review-kit` | `audit`, `context-cache`, `refs-fix` | A healthy bundle: one resource of every kind, with references between them |
| `bundles/review-kit-v2` | `fixture-health` | The same bundle one version on — diff it against `review-kit` |
| `bundles/broken-refs-kit` | `refs-fix` | Four broken references, and a pile of paths that only look broken |
| `bundles/polyglot-kit` | `flavors` | One kit, two languages: five common resources, five Python, two C# |
| `bundles/branded-kit` | `parameters` | A kit finished at install time: six `<%PLACEHOLDERS%>`, one of each kind |
| `collections/sprint-collection` | `fixture-health`, `shared-settings-order` | `sprint-kit`, the `team-conventions` it requires, and a skill they both ship |
| `projects/agent-rewritten` | `context-cache` | `CLAUDE.md` as a coding agent leaves it after rewriting the file |

Each bundle has its own `README.md` acting as the answer key for what the tests
assert about it — `polyglot-kit`'s flavor table, `branded-kit`'s parameter table.

## Fixtures that moved into a case

Three fixtures used to live here and now live in the case folder that needs
them, because only one case needs each and a case that owns its inputs reads on
its own:

| Was | Now |
| --- | --- |
| `bundles/invalid-kit` | `tests/cases/validate-names-every-mistake/inputs/bundles/` |
| `projects/adopted-setup` | `tests/cases/adopt-identical-mcp-server/inputs/project/` |
| `projects/existing-setup` | `tests/cases/conflict-*/inputs/project/` |

`broken-refs-kit` is in both places: the unit tests here exercise `hcm refs fix`
against it, and `tests/cases/refs-finds-four-broken/` holds its own copy for the
`refs check` report.

## Solving the reference one by hand

```bash
npx tsx src/cli.ts refs check --path tests/fixtures/bundles/broken-refs-kit
```

Before you run it: open the bundle and find the references that point at
nothing. There are four, and each has one obvious answer.

| Where | It says | It meant | Why |
| --- | --- | --- | --- |
| `commands/review-pr.md`, line 8 | `context/conventions.md` | `context/10-conventions.md` | `context/` holds `10-conventions.md` and `20-pull-requests.md`; only one is about conventions |
| `mcp/formatter.json`, line 3 | `assets/format.sh` | `assets/format-code.sh` | `assets/` holds exactly one file |
| `skills/release-audit/SKILL.md`, line 7 | `checklist.md` | `skills/release-audit/release-checklist.md` | The skill's own directory holds `release-checklist.md` |
| `subagents/code-reviewer.md`, line 5 | `rules/typescrpt.md` | `rules/typescript.md` | A typo; `rules/` holds one file |

The same table, as a baseline you can diff against, is
`tests/cases/refs-finds-four-broken/outputs/report.json`.
