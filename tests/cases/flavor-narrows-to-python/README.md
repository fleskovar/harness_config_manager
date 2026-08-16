# Test case: flavor-narrows-to-python

## What this proves

`--flavor python` installs the common part **plus** the Python part, and leaves
the C# part on the shelf entirely.

**Unit under test:** `src/core/flavors.ts::inFlavors`, through `buildPlan`
**Layer:** use case over an injected project directory
**Requirement:** "Flavors: installing part of a bundle"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | one `install`, `--flavor python` | 1 step |
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
| `outputs/tree/**` | 11 files | path order |
| `outputs/state.json` | the ledger, recording `flavors: ["python"]` | by installation id |

## Baseline provenance

- [x] **Computed by hand** - five common resources plus five Python ones, which
  come to eleven files because `pytest-runner` is a skill of two.

## Walkthrough

### The two rules, stated once

1. A resource in **no** flavor is *common*: it installs whatever you asked for.
2. A resource in **at least one** flavor installs only when one of its flavors
   was asked for.

Everything else follows, including why a bundle that has never heard of flavors
installs in full - it is all rule 1.

### The count, derived

| Source | Files |
| --- | --- |
| common: code-reviewer, review-pr, settings, pr-checklist SKILL, 10-conventions -> CLAUDE.md | 5 |
| python: python-typer, rules/python.md, mcp/pyright.json -> `.mcp.json`, lint.sh | 4 |
| python: pytest-runner - a skill, so SKILL.md **and** failure-modes.md | 2 |
| **Total** | **11** |

### What is absent, and why that is the assertion

- `.claude/agents/csharp-analyzer.md`
- `.claude/rules/csharp.md`

Neither is in `outputs/tree/`, and because the tree is exhaustive their absence
is checked rather than merely unasserted.

### Narrowing happens in the *plan*

Nothing is installed and then deleted. The C# resources never enter the plan, so
the receipts claim only the eleven items above - which is why uninstalling a
narrowed install leaves nothing behind, and why nothing downstream of the
planner needs to know flavors exist at all.

### The record

`flavors: ["python"]` is stored. `hcm update` will reinstall the same subset
without being told again - see `flavor-widens-back-to-all` for how to change it.

## Why this proves the code is correct

- **It pins:** both selection rules, that a flavored skill brings its supporting
  files, that `includes` patterns work for the kinds with no frontmatter (mcp,
  assets, rules), and that the choice is recorded.
- **It would catch:** a common resource dropped by narrowing, a C# resource
  installed anyway, a flavored skill installed without its second file, and a
  forgotten `flavors` record.
- **It does not cover:** installing two flavors at once, or a bundle with no
  flavors at all.

## How to run and debug

```bash
make test-case CASE=flavor-narrows-to-python
make debug-case CASE=flavor-narrows-to-python
```

**Start here:** breakpoint in `src/core/flavors.ts`, in `inFlavors`.
