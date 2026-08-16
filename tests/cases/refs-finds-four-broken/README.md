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
| `inputs/case.json` | one `refs` step | no install at all |
| `inputs/bundles/broken-refs-kit/` | a bundle with four planted mistakes | 10 files |

### Why each row exists

Each broken reference is a different *kind* of mistake, and each has exactly one
sensible answer:

| Where | It says | It meant | The mistake |
| --- | --- | --- | --- |
| `commands/review-pr.md` | `context/conventions.md` | `context/10-conventions.md` | a numeric prefix forgotten |
| `mcp/formatter.json` | `assets/format.sh` | `assets/format-code.sh` | a shortened filename, inside a **config value** |
| `skills/release-audit/SKILL.md` | `checklist.md` | `skills/release-audit/release-checklist.md` | a sibling that was renamed |
| `subagents/code-reviewer.md` | `rules/typescrpt.md` | `rules/typescript.md` | a typo |

The bundle also contains paths that must **not** be reported - a URL, a glob, a
shell command, a code sample. They are the control, and their absence from
`report.json` is as much the assertion as the four presences.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/report.json` | the four, with suggestions | by file, then by reference |
| `outputs/tree/` | empty - nothing is installed | - |

## Baseline provenance

- [x] **Computed by hand** - the table above is the derivation, and it is the
  same one in `tests/fixtures/README.md`, written before the checker was run.

## Walkthrough

### Reading `report.json`

Four entries, each with the file, the reference as written, and the candidates
in rank order. Check each against the table above.

The third is the interesting one. `checklist.md` in
`skills/release-audit/SKILL.md` gets **two** candidates:

1. `skills/release-audit/release-checklist.md` - the right answer
2. `rules/typescript.md` - a wrong one, offered anyway

Two things follow. The ranking works: the sibling file with the closely matching
name comes first. And the checker does not pretend to certainty - it offers what
it found, in order, and leaves the choice to a person. `hcm refs fix` applies
the unambiguous ones and leaves an undecided entry alone.

### What is absent

No entry for any of the URLs, globs or command lines in the bundle. A reference
is only reported when it looks like a path to a file *and* fails to resolve;
`looksLikePath` and the confidence rules are what keep this report to four lines
instead of forty.

### Suggestions are written as references, not as paths

`report.json` records what the reference **should say**, not where the file is
on this machine. An absolute path would be different on every machine and would
make this baseline useless.

## Why this proves the code is correct

- **It pins:** the four detections, the ranking of candidates, and the silence
  about non-references.
- **It would catch:** a missed break, a false positive on a URL or a glob, and a
  ranking change that put `rules/typescript.md` first.
- **It does not cover:** `hcm refs fix` applying the repairs, or `--strict`.

## How to run and debug

```bash
make test-case CASE=refs-finds-four-broken
make debug-case CASE=refs-finds-four-broken
```

Or by hand, which prints the same four:

```bash
npx tsx src/cli.ts refs check --path tests/cases/refs-finds-four-broken/inputs/bundles/broken-refs-kit
```

**Start here:** breakpoint in `src/core/refs.ts`, in `suggestFixes`.
