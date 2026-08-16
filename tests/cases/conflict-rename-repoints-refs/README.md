# Test case: conflict-rename-repoints-refs

## What this proves

Answering a conflict with **rename** installs the bundle's item under a new name
*and* rewrites the bundle's own instructions to match - so the agent is told to
use the server that actually exists.

**Unit under test:** `src/core/conflicts.ts` + `src/core/rename.ts`
**Layer:** use case over an injected project directory
**Requirement:** "When something is already there" in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | install with `resolve: rename -> review-files` | 1 step |
| `inputs/bundles/review-kit/` | the bundle | one resource of every kind |
| `inputs/project/` | a project that already disagrees | 2 files |

### The project before

`inputs/project/` holds a real setup that disagrees with the bundle:

| What it has | Why it is there |
| --- | --- |
| `.mcp.json` -> `filesystem` pointed at `/srv/docs` | the **collision**: same name, different value |
| `.mcp.json` -> `postgres` | an unrelated server that must survive whatever is decided |
| `CLAUDE.md`, hand-written | notes a person wrote, which must survive too |

`resolve` in `case.json` stands in for a person answering the prompt: it is the
answer, fixed, so the case is deterministic.

### Why each row exists

Renaming is offered for **MCP servers only**, because a server is addressed by
name and the bundle's own text can be rewritten to match. The subagent is the
row that proves the second half: it mentions the server *twice*, in two
different syntaxes.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 8 files | path order |

## Baseline provenance

- [x] **Computed by hand** - the project keeps its server, the bundle gets one
  under the chosen name, and every mention in the bundle follows.

## Walkthrough

### Three servers, not two

`outputs/tree/.mcp.json` holds:

| Server | Whose | Value |
| --- | --- | --- |
| `filesystem` | the project's | `/srv/docs`, untouched |
| `postgres` | the project's | untouched |
| `review-files` | the bundle's | `.`, under the chosen name |

Nothing was displaced. That is what makes rename the answer people actually want
when the collision is a *name* clash rather than a disagreement.

### Both mentions follow

`outputs/tree/.claude/agents/code-reviewer.md` mentions the server twice, and
both had to change:

1. In the tool allowlist, as a namespace prefix:
   `tools: Read, Grep, Bash, mcp__review-files__read_text_file`
2. In the prose: ``Read files through the `review-files` MCP server``

The second is the one that matters. A rename that fixed only the machine-readable
half would leave the agent's own instructions naming a server that does not
exist - and nothing would ever report it, because prose is not validated.

### Where the rename does *not* reach

The renamed resource's own actions are regenerated under the new name, and the
*other* resources have their references rewritten. The two are deliberately
separate: rewriting the renamed resource as well would rename its own mentions
of itself.

## Why this proves the code is correct

- **It pins:** that renaming adds rather than displaces, and that both the
  namespaced and the prose mention of a server follow the new name.
- **It would catch:** a rename that overwrote the project's server anyway, one
  that renamed the JSON key but left the instructions stale, and one that
  rewrote only the `mcp__` prefix.
- **It does not cover:** renaming a kind that is not addressed by name, which
  hcm does not offer.

## How to run and debug

```bash
make test-case CASE=conflict-rename-repoints-refs
make debug-case CASE=conflict-rename-repoints-refs
```

**Start here:** breakpoint in `src/core/rename.ts`, in `rewriteReferences`.
