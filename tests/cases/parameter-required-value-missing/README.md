# Test case: parameter-required-value-missing

## What this proves

A required parameter with nowhere to get a value stops the run **before anything
is written**, and the message names every way of supplying it.

**Unit under test:** `src/core/parameters.ts::resolveParameters`
**Layer:** use case over an injected project directory
**Requirement:** "Parameters: values filled in at install time"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | one `install` with **no** `--param`, marked `fails` | 1 step |
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

`TEAM` is the only parameter with no default, so it is the only thing this
install cannot work out for itself.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/` | **empty** | - |
| `outputs/error.txt` | the refusal, and how to answer it | - |

## Baseline provenance

- [x] **Computed by hand** - nothing can be rendered, so nothing is written.

## Walkthrough

### The refusal

```
"branded-kit" needs a value for the parameter "TEAM" (The team that owns this project)
```

The parameter's `description` is quoted into the message, which is the one place
a user meets it if they never open the manifest - a good reason to write one.

The hint that accompanies it names all four routes: `--param`, a
`--params-file`, `HCM_PARAM_TEAM`, or running in a terminal to be asked.

### Why the project is empty

Parameters are resolved **before** the plan is built, because the plan *is* the
rendered text. There is nothing to hash, compare or write until the values are
known, so a missing one stops the run at the earliest possible point rather than
part-way through.

`outputs/tree/` is empty: no `.claude/`, no `CLAUDE.md`, not even the resources
that mention no parameters at all.

### Why this is a refusal rather than a blank

The alternative - substituting the empty string - would produce *You are a
coding agent called Ada, working on a project owned by the  team*, which is
worse than a stop: it reads as finished, it installs cleanly, and nobody notices
until an agent acts on it. An optional parameter with no default does render as
nothing, but that is a choice the bundle author made explicitly.

### Where this does not fire

With a terminal attached, hcm asks instead. This case runs with none - as CI
does - which is why the refusal is the behaviour under test.

## Why this proves the code is correct

- **It pins:** resolution happening before planning, the refusal being total,
  and the description reaching the message.
- **It would catch:** an install that rendered `<%TEAM%>` as empty or verbatim,
  and one that wrote the parameterless resources before discovering the problem.
- **It does not cover:** the interactive path, which is covered by unit tests
  through an injected `ask`.

## How to run and debug

```bash
make test-case CASE=parameter-required-value-missing
make debug-case CASE=parameter-required-value-missing
```

**Start here:** breakpoint in `src/core/parameters.ts`, in `missingValue`.
