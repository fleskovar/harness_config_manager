# Test case: parameter-fills-the-templates

## What this proves

`--param` fills every placeholder the bundle declares, in every kind of file
that can hold one - and a parameter marked `secret` is used but never written to
the ledger.

**Unit under test:** `src/core/parameters.ts::applyParameters`, through
`buildPlan`
**Layer:** use case over an injected project directory
**Requirement:** "Parameters: values filled in at install time"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | one `install` with three `--param`s | `-t claude-code` |
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

### Why each row exists

The bundle mentions its parameters in **every** place a placeholder can appear,
because substitution happens per payload kind and each kind is a separate branch:

| Where | File | Proves |
| --- | --- | --- |
| a markdown **body** | `subagents/reviewer.md` | the ordinary case |
| markdown **frontmatter** | the same file's `description` | frontmatter is rendered too |
| a **context block** | `context/10-identity.md` | blocks, not just files |
| a **skill's supporting file** | `skills/onboarding/welcome.md` | files copied verbatim are still rendered |
| a **JSON string value** | `mcp/reporter.json` args and env | values inside config |
| a **settings value** | `settings/settings.json` | merged documents |
| a **text asset** | `assets/run-tests.sh` | assets, when they are text |
| an **escape** | `subagents/reviewer.md` ends with `<%%AGENT_NAME%>` | the literal survives |

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 10 files, every placeholder filled | path order |
| `outputs/state.json` | the values recorded - **minus the secret** | by installation id |

## Baseline provenance

- [x] **Computed by hand** - the values are `TEAM=Platform`, `AGENT_NAME=Ada`,
  `API_TOKEN=hunter2`, and everything else takes its declared default.

## Walkthrough

### The values used

| Parameter | Value | From |
| --- | --- | --- |
| `TEAM` | `Platform` | `--param` |
| `AGENT_NAME` | `Ada` | `--param` |
| `API_TOKEN` | `hunter2` | `--param` |
| `TONE` | `direct` | its default |
| `PYTEST_ARGS` | `-q` | its default |
| `CLAUDE_MODEL` | `sonnet` | its default |

### Reading the output

- `CLAUDE.md`: *You are a coding agent called **Ada**, working on a project
  owned by the **Platform** team. Write in a **direct** style.* Three parameters
  in two sentences, two supplied and one defaulted.
- `.claude/agents/reviewer.md`: the frontmatter reads
  `description: Reviews changes on behalf of the Platform team` - proof that
  frontmatter is rendered, not just bodies.
- `.claude/skills/onboarding/welcome.md`: `# Welcome to Platform`. This file has
  no frontmatter and is copied byte-for-byte by the skill mapping; it is
  rendered anyway.
- `.mcp.json`: `"--team", "Platform"` in the args, and
  `"REPORTER_TOKEN": "hunter2"` in the env.
- `.claude/run-tests.sh`: `exec pytest -q "$@"` - a shell script, rendered
  because it is text. A PNG in the same directory would not be.
- The last line of `.claude/agents/reviewer.md` reads
  `documenting this feature: <%AGENT_NAME%>` - the escaped `<%%` came through as
  a literal placeholder rather than being filled.

### The secret

`outputs/state.json` records five parameters and **not** `API_TOKEN`. The value
reached `.mcp.json`; it simply was not written down. The project-scope ledger
lives in `.hcm/state.json` next to the code, and a token in there is a token in
the repository.

The cost is stated rather than hidden: `hcm update` cannot reuse what it never
stored, so a secret has to be supplied again.

## Why this proves the code is correct

- **It pins:** substitution in all seven payload shapes, the escape sequence,
  defaults filling what was not supplied, and secrets being used but not
  recorded.
- **It would catch:** frontmatter or supporting files left unrendered, a JSON
  value missed, an escaped placeholder being filled anyway, and a secret leaking
  into the ledger.
- **It does not cover:** binary assets (covered by a unit test), or values that
  differ per harness.

## How to run and debug

```bash
make test-case CASE=parameter-fills-the-templates
make debug-case CASE=parameter-fills-the-templates
```

**Start here:** breakpoint in `src/core/parameters.ts`, in `applyParameters`.
