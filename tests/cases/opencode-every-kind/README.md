# Test case: opencode-every-kind

## What this proves

The same bundle as the other four `*-every-kind` cases, installed into
**OpenCode** — the harness where a rule is *two* writes, a subagent's tool
allowlist has no faithful translation and is dropped, and one JSON file holds
the MCP servers, the settings and the rule registration together.

**Unit under test:** `src/commands/install.ts::installCommand`, through
`src/targets/opencode.ts`
**Layer:** use case over an injected project directory
**Requirement:** the "Where things land" table in the top-level `README.md`, and
"What each target does with the edges"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | the command being run | one `install` step, `-t opencode` |
| `inputs/bundles/sample-kit/` | the bundle | 8 files, one resource of each of the 8 kinds |

The same `sample-kit` as its four siblings, so the trees can be diffed against
each other.

### Why each row exists

The rows carrying the OpenCode-specific weight are the **rule** (which produces
a file *and* a config entry), the **subagent** (whose `tools` are dropped) and
the **MCP server** (whose shape is unlike every other harness's).

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | every file in the project after the install | path order |

**Canonical form:** files as written, `\n` line endings, `opencode.json`
pretty-printed by hcm's JSON writer.
**Normalised away:** `.hcm/`.

## Baseline provenance

- [x] **Computed by hand** from the requirement — the "Where things land" table
  and OpenCode's documented config schema (<https://opencode.ai/docs/config/>).

## Walkthrough

### The rules, stated once

1. **OpenCode's roots:** agents in `.opencode/agents/`, skills in
   `.opencode/skills/<name>/`, commands in `.opencode/commands/`, rules in
   `.opencode/rules/`, context in `AGENTS.md` at the project root, and
   everything configurable in `opencode.json`.
2. **A rule is two writes.** OpenCode has no glob-scoped rule format, but it
   does load extra instruction files listed in `instructions`. So a rule becomes
   a file *and* one entry appended to that array.
3. **An array in config is appended to, never replaced** — which is what lets
   two bundles each register their own rules in the same `opencode.json` and
   each remove only its own on uninstall.

### `subagents/code-reviewer.md` → `.opencode/agents/code-reviewer.md`

1. `mode: subagent` is **added**: OpenCode distinguishes a primary agent from a
   subagent with this key, and hcm's `subagents/` directory says which this is.
2. `model: sonnet` survives. So does `color: blue` — OpenCode *has* a colour,
   which is why the same key that is dropped for Claude Code and Copilot is kept
   here. Two harnesses, opposite answers, same bundle line.
3. `tools` is **dropped entirely**. OpenCode gates tools through a `permission`
   object keyed by its own categories (`edit`, `bash`, `read`), not by tool
   name, so a canonical allowlist of `Read, Grep, Bash,
   mcp__filesystem__read_text_file` has no faithful translation. Dropping it is
   the honest answer: a wrong `permission` block would be worse than none.
   Grep `outputs/tree/.opencode/agents/code-reviewer.md` for `tools` — nothing.

### `rules/typescript.md` → `.opencode/rules/typescript.md` **and** `opencode.json`

This is rule 2, and the only place in the five cases where one bundle file
produces two writes into two different files:

1. The file: `.opencode/rules/typescript.md`, its `appliesTo` globs rendered as
   a line of prose above the rule text, since OpenCode's loader cannot enforce
   them.
2. The registration: `instructions: [".opencode/rules/typescript.md"]` in
   `opencode.json` — a **project-root-relative** path, because that is what
   OpenCode resolves `instructions` against, not a path relative to the config
   file.

### `context/*.md` → `AGENTS.md`

1. Two marker blocks in filename order, at the project root.
2. `AGENTS.md` is a **shared** file: Pi reads the same one. Compare
   `outputs/tree/AGENTS.md` here with `pi-every-kind/outputs/tree/AGENTS.md` —
   the context blocks are identical. That sharing is why uninstalling from
   OpenCode in a folder that also has Pi leaves the file in place.

### `mcp/filesystem.json` → `opencode.json` → `mcp.filesystem`

The most heavily reshaped payload in the five cases. The bundle says:

```json
{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  "env": { "FS_LOG": "warn" } }
```

and OpenCode wants:

1. `"type": "local"` — added, the counterpart of Copilot's `"stdio"`.
2. `command` and `args` **merged into one array**:
   `["npx", "-y", "@modelcontextprotocol/server-filesystem", "."]`. Every other
   harness keeps them apart.
3. `env` renamed to `environment`.

### `settings/settings.json` → `opencode.json` → `permissions`

Merged into the same file as the MCP server and the rule registration. Three
resources of three different kinds, one destination file — and each one's keys
are owned separately, which is what makes an item-level uninstall from a shared
config file possible at all.

### `skills/dependency-audit/` and `commands/review-pr.md`

Filed at `.opencode/skills/dependency-audit/` and
`.opencode/commands/review-pr.md`, references repointed by the usual rule. The
skill's ``../../agents/code-reviewer.md`` matches Claude Code's exactly — both
harnesses put agents two levels up from a skill directory, under `agents/`.

## Why this proves the code is correct

- **It pins:** the two-write rule mapping and the project-root-relative form of
  the `instructions` entry, `mode: subagent` being added, `tools` being dropped
  while `color` is kept, the three-part MCP reshaping (`type`, merged command
  array, `environment`), and three kinds sharing `opencode.json`.
- **It would catch:** a rule file written without its `instructions` entry (or
  the entry written relative to `.opencode/`), `tools` leaking through into a
  file OpenCode would reject, `args` left separate from `command`, and
  `instructions` being replaced rather than appended.
- **It does not cover:** two bundles appending to `instructions` at once — that
  is `shared-settings-array` — or the `AGENTS.md` overlap with Pi, which is
  `agents-md-shared-with-pi`.

## How to run and debug

```bash
make test-case CASE=opencode-every-kind
make debug-case CASE=opencode-every-kind
```

**Start here:** breakpoint in `src/targets/opencode.ts`, in `actions()`, and
watch the `rule` branch return **two** actions.

## When to change this case

- **A red run is a regression until proven otherwise.**
- Adding a resource kind means adding it to all five `*-every-kind` cases.
- **Regenerating** (`UPDATE_BASELINES=1 npm run test:cases`) is a diff a human
  reads line by line, in a commit that changes baselines and nothing else.
