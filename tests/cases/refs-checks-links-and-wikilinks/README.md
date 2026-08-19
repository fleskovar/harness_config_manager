# Test case: refs-checks-links-and-wikilinks

## What this proves

A wikilink is a **name**, not a path. `hcm refs check` resolves one the way
every tool that reads wikilinks does — by looking for a file of that name
anywhere in the same bundle — handles the `|alias`, `#heading` and `path/form`
variants, and offers a replacement written *as a wikilink* when one is broken.

And `--links` narrows the scan to the four link syntaxes, dropping inline code
and config values entirely.

**Unit under test:** `src/core/refs.ts::resolveRef`, `src/core/refs.ts::refPolicy`
**Layer:** pure analysis over a bundle directory
**Requirement:** "References: written once, repointed on the way in"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | the same bundle scanned twice, default then `--links` | no install at all |
| `inputs/bundles/handbook-kit/` | a handbook written in wikilinks | 8 files |

### Why each row exists

`skills/onboard/SKILL.md` holds one wikilink of every form:

| It says | The form | Resolves to |
| --- | --- | --- |
| `[[checklist]]` | plain, and a sibling | `skills/onboard/checklist.md` |
| `[[coding-standards\|our coding standards]]` | with an **alias** | `context/coding-standards.md` |
| `[[glossary#terms-of-art]]` | with a **heading** | `context/glossary.md` |
| `[[context/glossary]]` | with a **path** | `context/glossary.md` |
| `[[code-review]]` | plain | **nothing** — the file is `code-review-guide.md` |
| `[[on-call-rota]]` | plain | **nothing**, and nothing like it either |

Four of those six resolve, and only one of the four is in the directory the
SKILL.md is in. That is the assertion: name lookup, not path resolution. The
alias and the heading are not part of the name, and dropping them is what makes
rows two and three work.

`context/welcome.md` and `mcp/handbook.json` carry the other syntaxes, so the
`--links` comparison has something to remove:

| It says | Syntax | Kept by `--links`? |
| --- | --- | --- |
| `[the onboarding checklist](skills/onboard/checklist.md)` | link | yes — and it resolves |
| `[the glosary](context/glosary.md)` | link | yes — broken, a typo |
| `![the org chart](assets/org-chart.png)` | image | yes — broken |
| `` `./editor.json` `` | code | **no** |
| `"../assets/serve-handbook.js"` | config | **no** |

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/report.json` | default scope — **six** broken | by file, then by position |
| `outputs/report-links.json` | `--links` — **four**, the code and config ones gone | the same |
| `outputs/tree/` | empty — nothing is installed | — |

## Baseline provenance

- [x] **Computed by hand** — the two tables above are the derivation, written
  before the checker was run.

## Walkthrough

### The wikilinks that are absent

Start with what is *not* in `report.json`. Four of the six wikilinks resolved,
and three of those four sit in a directory the SKILL.md knows nothing about.
`[[coding-standards]]` did not become `skills/onboard/coding-standards.md` and
fail; it became "a file called coding-standards, somewhere in handbook-kit", and
found `context/coding-standards.md`.

`[[glossary#terms-of-art]]` resolves for the same reason once the heading is
dropped, and `[[coding-standards|our coding standards]]` once the alias is. Only
the part before the `|` and before the `#` is the name.

### `code-review` — a suggestion in the right shape

```json
{ "ref": "code-review", "syntax": "wikilink", "suggestions": ["code-review-guide"] }
```

`code-review-guide`, not `context/code-review-guide.md`. A suggestion has to be
usable where the broken reference was, and `[[context/code-review-guide.md]]`
would be a strange thing to write into a handbook. Every other entry in this
report suggests a path, because every other entry is a path.

### `on-call-rota` — broken with nothing to offer

Reported all the same. It is a wikilink, so it is a declared reference, so it is
in scope whatever it says — and there is genuinely no file like it. That is what
a real broken reference with no obvious repair looks like.

### `report-links.json` — what `--links` drops

Six becomes four. `./editor.json` (inline code) and `../assets/serve-handbook.js`
(a config value) are gone, and `mcp/handbook.json` is gone from the report
entirely — under `--links` a config file yields nothing at all, since none of
its syntaxes are links.

Both of those dropped references are explicitly relative and genuinely broken.
`--links` is a *narrowing*, not a fix: it is for the pass where you care about
the document's links and nothing else.

## Why this proves the code is correct

- **It pins:** name-based wikilink resolution, the alias and heading forms, the
  path form, wikilink-shaped suggestions, and exactly what `--links` removes.
- **It would catch:** a wikilink resolved only against the file's own directory,
  an alias or heading leaking into the name, a suggestion offered as a path
  where a name was needed, and a `--links` that let code or config through.
- **It does not cover:** cross-bundle wikilinks, which deliberately do *not*
  resolve (`tests/refs.test.ts`), or applying a wikilink fix, which rewrites the
  target and leaves the alias alone (also `tests/refs.test.ts`).

## How to run and debug

```bash
make test-case CASE=refs-checks-links-and-wikilinks
make debug-case CASE=refs-checks-links-and-wikilinks
```

Or by hand:

```bash
KIT=tests/cases/refs-checks-links-and-wikilinks/inputs/bundles/handbook-kit
npx tsx src/cli.ts refs check --path $KIT
npx tsx src/cli.ts refs check --path $KIT --links
```

**Start here:** breakpoint in `src/core/refs.ts`, in `findByName` — it fires
once per wikilink that neither root resolved, and it is the whole of the
difference between a wikilink and a path.
