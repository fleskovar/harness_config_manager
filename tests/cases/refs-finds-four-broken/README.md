# Test case: refs-finds-four-broken

## What this proves

`hcm refs check` finds the four references in `broken-refs-kit` that point at
nothing, suggests the file each one meant with the best candidate first, and
says nothing about the many paths in the bundle that only *look* like broken
references.

**Unit under test:** `src/core/refs.ts::scanReferences`
**Layer:** pure analysis over a bundle directory
**Requirement:** "References: written once, repointed on the way in"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | one `refs` step, default scope | no install at all |
| `inputs/bundles/broken-refs-kit/` | a bundle with four planted mistakes | 10 files |

### Why each row exists

Each broken reference is a different *kind* of mistake, written in a different
*form*, and each has exactly one sensible answer:

| Where | It says | Written as | It meant | The mistake |
| --- | --- | --- | --- | --- |
| `commands/review-pr.md` | `context/conventions.md` | a **link** | `context/10-conventions.md` | a numeric prefix forgotten |
| `mcp/formatter.json` | `../assets/format.sh` | a **config value**, explicitly relative | `../assets/format-code.sh` | a shortened filename |
| `skills/release-audit/SKILL.md` | `./checklist.md` | **inline code**, explicitly relative | `./release-checklist.md` | a sibling that was renamed |
| `subagents/code-reviewer.md` | `rules/typescrpt.md` | a **link** | `rules/typescript.md` | a typo |

The four forms are the point. Two are links, whose target markdown has already
declared to be a path. Two are ordinary text that carries an explicit `./` or
`../`, which is the only mark an author can make to say "this is a path, not the
name of a thing".

The bundle also contains paths that must **not** be reported — a URL, a shell
command in a fenced block, and, above all, sentences that merely *name* files:

| Where | It says | Why it is silent |
| --- | --- | --- |
| `skills/release-audit/SKILL.md` | `` `audit-summary.md` `` | a sentence about a file the skill creates |
| `skills/release-audit/SKILL.md` | `` `reports/dependency-tree.txt` `` | the same, with a directory in front |
| `skills/release-audit/SKILL.md` | `` `package.json` ``, `` `tsconfig.json` `` | files in whatever project the skill runs against |
| `commands/review-pr.md` | `https://example.com/style/guide.md` | somebody else's to resolve |
| `README.md` | the filenames in its table | prose about the bundle |

They are the control, and their absence from `report.json` is as much the
assertion as the four presences.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/report.json` | the scope, and the four with suggestions | by file, then by reference |
| `outputs/tree/` | empty — nothing is installed | — |

## Baseline provenance

- [x] **Computed by hand** — the tables above are the derivation, and they are
  the same ones in `tests/fixtures/README.md`, written before the checker was
  run.

## Walkthrough

### Reading `report.json`

`scope` first: all three flags false, which is the default — links, wikilinks
and explicitly relative paths. Then four entries, each with the file, the
reference as written, the syntax it was written in, and the candidates in rank
order. Check each against the first table above.

The third is the interesting one. `./checklist.md` in
`skills/release-audit/SKILL.md` gets **two** candidates:

1. `./release-checklist.md` — the right answer
2. `../../rules/typescript.md` — a wrong one, offered anyway

Three things follow. The ranking works: the sibling file with the closely
matching name comes first. The fix keeps the `./` the author wrote — a
suggestion of `release-checklist.md` would repair the line and simultaneously
drop it out of every later check, because a bare filename is not in scope. And
the checker does not pretend to certainty: it offers what it found, in order,
and leaves the choice to a person. `hcm refs fix` applies the unambiguous ones
and leaves an undecided entry alone.

### What is absent

No entry for any of the URLs, prose filenames or command lines in the bundle.
Two lines of `SKILL.md` are worth opening the file for:

```markdown
A file will be created named `audit-summary.md`, and a second one under
`reports/dependency-tree.txt`.
```

Both of those are complete, true sentences that name a file. Neither points at
anything. A checker that reported them would be wrong about the bundle and would
train its user to skim the report — which is the whole argument for the default
scope. `refs-ignores-prose-filenames` is the case that shows the same text under
`--all-paths`, where they *are* reported.

### Suggestions are written as references, not as paths

`report.json` records what the reference **should say**, not where the file is
on this machine. An absolute path would be different on every machine and would
make this baseline useless. It also records it in the *form* the reference was
written in: `../assets/format-code.sh` keeps the `../`, and a wikilink would get
a bare name.

## Why this proves the code is correct

- **It pins:** the four detections across four syntaxes, the ranking of
  candidates, the preservation of an explicit `./`, and the silence about
  non-references.
- **It would catch:** a missed break, a false positive on a URL or on prose that
  names a file, a suggestion that dropped the `./`, and a ranking change that
  put `rules/typescript.md` first.
- **It does not cover:** `hcm refs fix` applying the repairs
  (`tests/refs-fix.test.ts`), `--links` or wikilink resolution
  (`refs-checks-links-and-wikilinks`), or `--all-paths` and `--strict`
  (`refs-ignores-prose-filenames`).

## How to run and debug

```bash
make test-case CASE=refs-finds-four-broken
make debug-case CASE=refs-finds-four-broken
```

Or by hand, which prints the same four:

```bash
npx tsx src/cli.ts refs check --path tests/cases/refs-finds-four-broken/inputs/bundles/broken-refs-kit
```

**Start here:** breakpoint in `src/core/refs.ts`, in `isInScope` to see what is
admitted, then in `suggestFixes` to see how each candidate is ranked.
