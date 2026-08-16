# Test case: parameter-remembered-across-update

## What this proves

`hcm update` renders the new version with the values the old installation
recorded, without being told again. An update that silently renamed the agent
would be worse than no update at all.

**Unit under test:** `src/commands/update.ts` -> `installInto` ->
`resolveParameters`
**Layer:** use case over an injected project directory
**Requirement:** "Parameters: values filled in at install time"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | register `--dev`, install with `--param`s, update with **none** | 3 steps |
| `inputs/bundles/branded-kit/` | a bundle full of placeholders | 9 resources |

### The bundle

`branded-kit` is finished at install time: its files hold `<%PLACEHOLDERS%>` and
its manifest declares what fills them. Its README is the answer key; the
parameters are:

| Parameter | Default | Scope |
| --- | --- | --- |
| `AGENT_NAME` | `Claude` | global |
| `TEAM` | - **required** | global |
| `TONE` | `direct` | global, one of direct/formal/playful |
| `PYTEST_ARGS` | `-q` | flavor `python` |
| `CLAUDE_MODEL` | `sonnet` | harness `claude-code` |
| `API_TOKEN` | `unset` | global, **secret** |

The update step carries no `--param` at all. That absence is the case.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 10 files, still rendered with the original values | path order |
| `outputs/state.json` | the same parameters, still recorded | by installation id |

## Baseline provenance

- [x] **Computed by hand** - the same bundle, the same values, so the same
  output as `parameter-fills-the-templates` minus the supplied `API_TOKEN`.

## Walkthrough

### The assertion

`outputs/tree/CLAUDE.md` still reads *You are a coding agent called **Ada**,
working on a project owned by the **Platform** team*, after an update that was
given neither value.

### Where the values came from

1. The install recorded `AGENT_NAME=Ada` and `TEAM=Platform` on the installation
   record.
2. The update **rolls the installation back first**, which removes that record -
   so by the time the reinstall runs, there is nothing on disk to read them
   from.
3. So `updateCommand` reads them before the rollback and hands them to
   `installInto` as `recordedParameters`.

That ordering is the whole mechanism, and it is the thing most likely to break:
a refactor that moved the lookup after the rollback would silently fall back to
defaults, and the agent would quietly become "Claude" again.

### The secret, and the honest gap

`API_TOKEN` was supplied at install time but never recorded. This update was
given no value for it, so it falls back to its declared default `unset`, and
`.mcp.json` reads `"REPORTER_TOKEN": "unset"`.

That is the documented cost of `secret: true`, visible here in a baseline rather
than only in prose. Had `API_TOKEN` no default, the update would have stopped
and asked - which is the safer failure and the reason to give secrets a default
only when an inert one exists.

### Precedence

Recorded values sit below `--param`, the environment, and this run's answers, so
they are used exactly when nothing else has an opinion. `hcm update --param
AGENT_NAME=Grace` overrides one and leaves the rest.

## Why this proves the code is correct

- **It pins:** that recorded values survive rollback-then-install, and what
  happens to a secret across an update.
- **It would catch:** an update that re-rendered from defaults, one that read
  the record after deleting it, and one that dropped the recorded values from
  the new record.
- **It does not cover:** `--reconfigure`, or a parameter newly added by the new
  version.

## How to run and debug

```bash
make test-case CASE=parameter-remembered-across-update
make debug-case CASE=parameter-remembered-across-update
```

**Start here:** breakpoint in `src/commands/update.ts`, in `reinstall`, on the
line that passes `recordedParameters`.
