# Test case: parameter-per-harness-values

## What this proves

One parameter takes a **different value in each harness**, and a parameter
narrowed to one harness still fills its placeholder in the others - from its
default, so no file is left with a hole.

**Unit under test:** `src/core/parameters.ts::resolveParameters` and
`withDefaults`
**Layer:** use case over an injected project directory
**Requirement:** "Parameters: values filled in at install time"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | one `install` into two harnesses, with scoped `--param`s | `-t claude-code copilot` |
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

The scoped assignments are the subject:

```
--param TEAM=Platform
--param branded-kit@claude-code:AGENT_NAME=Ada
--param branded-kit@copilot:AGENT_NAME=Cop
```

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 20 files: 10 per harness | path order |
| `outputs/state.json` | two installations with **different** parameters | by installation id |

## Baseline provenance

- [x] **Computed by hand** - the same bundle rendered twice with one value
  different.

## Walkthrough

### The same sentence, twice, differently

- `outputs/tree/CLAUDE.md`: *You are a coding agent called **Ada**...*
- `outputs/tree/.github/copilot-instructions.md`: *You are a coding agent called
  **Cop**...*

Same bundle file, same install command, two values. `TEAM` is unscoped, so both
say `Platform`.

### `CLAUDE_MODEL` - the narrowed one

Declared `targets: [claude-code]`, so it is only ever **asked** for on Claude
Code. But `context/10-identity.md` is a common file and both harnesses get it,
so what does Copilot's copy say?

Both files read *Prefer the **sonnet** model for routine work.*

Applicability decides what is **asked for**, not what is **substituted**. A
narrowed parameter still has a default, and that default fills the placeholder
everywhere. Had it no default, the placeholder would install verbatim in
Copilot - which is precisely the mistake `hcm validate` reports.

### The two records

`outputs/state.json` holds two installations with different parameter maps:

| | claude-code | copilot |
| --- | --- | --- |
| `AGENT_NAME` | `Ada` | `Cop` |
| `TEAM` | `Platform` | `Platform` |
| `CLAUDE_MODEL` | `sonnet` | **absent** |

`CLAUDE_MODEL` is recorded only against the harness it belongs to. It was used
in Copilot's files - from its default - but it was not *settled* there, and a
default belongs to the manifest rather than to the installation.

### Why answers are per-harness for this parameter only

A global parameter is answered once per run and reused across harnesses, so an
interactive install asks for `TEAM` once. A parameter that names harnesses is a
fact *about* a harness, so it is asked once per harness. That distinction is
what makes the scoped `--param` syntax meaningful.

## Why this proves the code is correct

- **It pins:** `bundle@harness:` scoping, per-harness records, and a narrowed
  parameter defaulting rather than leaving a hole.
- **It would catch:** one harness's value leaking into the other, a
  `<%CLAUDE_MODEL%>` left standing in Copilot's copy, and `CLAUDE_MODEL`
  recorded against a harness that never asked for it.
- **It does not cover:** flavor-scoped parameters, or interactive prompting.

## How to run and debug

```bash
make test-case CASE=parameter-per-harness-values
make debug-case CASE=parameter-per-harness-values
```

**Start here:** breakpoint in `src/core/parameters.ts`, in `overridesFor`, then
in `withDefaults`.
