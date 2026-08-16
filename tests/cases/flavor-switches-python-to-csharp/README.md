# Test case: flavor-switches-python-to-csharp

## What this proves

`hcm update --flavor csharp` over an installation that was narrowed to Python
swaps the halves over: the C# resources arrive **and the Python ones go**.

**Unit under test:** `src/commands/update.ts::updateCommand`
**Layer:** use case over an injected project directory
**Requirement:** "Flavors: installing part of a bundle"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | register `--dev`, install `--flavor python`, update `--flavor csharp` | 3 steps |
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
| `outputs/tree/**` | 7 files: 5 common + 2 C# | path order |
| `outputs/state.json` | `flavors: ["csharp"]` | by installation id |

## Baseline provenance

- [x] **Computed by hand** - five common resources plus the two C# ones.

## Walkthrough

### The count, derived

| Source | Files |
| --- | --- |
| common | 5 |
| csharp: csharp-analyzer, rules/csharp.md | 2 |
| **Total** | **7** |

Seven, down from eleven. Four Python files went, two C# files arrived, and the
five common ones stayed.

### Why the Python half actually leaves

Because an update is **rollback-then-install**. The rollback half removes
everything the old record claimed - which is the eleven Python-and-common items
- and the install half then plans the seven the new selection contains.

There is no "diff the two flavor selections" logic anywhere, and that is the
point: the same mechanism that handles a new version removing a subagent handles
a narrowing that drops one.

`.mcp.json` is instructive here. It was created by the Python install (from
`mcp/pyright.json`) and is **absent** from `outputs/tree/`: its only key was
released on rollback, the file emptied, and it was deleted. The C# half has no
MCP server to put back.

### The warning this case exists to make unnecessary

`hcm install --flavor csharp` over the same installation would *not* do this -
it would write the C# half and leave the Python half stranded, because an
install has no rollback step. hcm warns when it sees that and names
`hcm update --flavor` as the way to swap properly. This case is that way
working.

## Why this proves the code is correct

- **It pins:** that changing a flavor selection on update removes what dropped
  out, including emptied files, and records the new selection.
- **It would catch:** an update that left the Python resources beside the C#
  ones, an orphaned `.mcp.json`, and a stale `flavors` record.
- **It does not cover:** widening, which is the case next door.

## How to run and debug

```bash
make test-case CASE=flavor-switches-python-to-csharp
make debug-case CASE=flavor-switches-python-to-csharp
```

**Start here:** breakpoint in `src/commands/update.ts`, in `reinstall`.
