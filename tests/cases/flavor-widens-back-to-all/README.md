# Test case: flavor-widens-back-to-all

## What this proves

`hcm update --flavor all` widens a narrowed installation back to the whole
bundle, and stops recording a narrowing at all.

**Unit under test:** `src/commands/update.ts::updateCommand`
**Layer:** use case over an injected project directory
**Requirement:** "Flavors: installing part of a bundle"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | register `--dev`, install `--flavor python`, update `--flavor all` | 3 steps |
| `inputs/bundles/polyglot-kit/` | one kit, two languages | 12 resources |

### The bundle

`polyglot-kit` is one kit covering two languages. Its README is the answer key;
the shape that matters here is:

| Belongs to | Resources |
| --- | --- |
| **common** | code-reviewer, review-pr, pr-checklist, 10-conventions, settings |
| **python** | python-typer, pytest-runner, rules/python.md, mcp/pyright.json, assets/python/lint.sh |
| **csharp** | csharp-analyzer, rules/csharp.md |

Five common, five Python, two C#. A resource joins a flavor either through its
own frontmatter or through an `includes` pattern in the manifest, and both
routes are represented.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 13 files - the whole bundle | path order |
| `outputs/state.json` | **no** `flavors` key | by installation id |

## Baseline provenance

- [x] **Computed by hand** - eleven files from the Python install, plus the two
  C# resources.

## Walkthrough

### Why `all` needs a word of its own

Omitting `--flavor` on an update means *keep what was recorded* - that is what
makes `hcm update` safe to run over a folder of narrowed installations. So there
has to be something else to say for "widen this back", and `all` is it. It is
reserved: a bundle may not define a flavor called `all`.

### The two files that appear

```bash
diff -r tests/cases/flavor-narrows-to-python/outputs/tree \
        tests/cases/flavor-widens-back-to-all/outputs/tree
```

Two files are here that were not there:

- `.claude/agents/csharp-analyzer.md`
- `.claude/rules/csharp.md`

Everything else is byte-identical, including the Python half - widening adds,
it does not rebuild differently.

### The record

The `flavors` key is **absent**, not `[]` and not `["python", "csharp"]`.
Absent is what every record written before flavors existed says, and it has to
keep meaning "all of it". Writing the two names instead would be wrong the day
the bundle gains a third.

### Where the widening happens

`expandFlavors` reads `["all"]` as `undefined` - no narrowing - and the update
passes that through to the plan. The rollback half removes the eleven items the
old record claimed; the install half plans all thirteen.

## Why this proves the code is correct

- **It pins:** `all` as the widening word, the two C# resources arriving, and
  the `flavors` key being dropped rather than filled in.
- **It would catch:** an update that silently kept the narrowing, one that
  recorded `["all"]` as if it were a flavor name, and a widened install that
  rewrote the Python half differently.
- **It does not cover:** narrowing further, which is the case next door.

## How to run and debug

```bash
make test-case CASE=flavor-widens-back-to-all
make debug-case CASE=flavor-widens-back-to-all
```

**Start here:** breakpoint in `src/core/flavors.ts`, in `expandFlavors`.
