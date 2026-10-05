# Test case: copilot-cli-every-kind

## What this proves

The same bundle as the other five `*-every-kind` cases, installed into **GitHub
Copilot CLI** — the harness that shares most of its repository layout with
another harness, and the only one with **no home for a command**.

Its whole reason for existing is the pair of comparisons at the bottom: against
`copilot-every-kind`, which reads five of the same files, and against
`claude-code-every-kind`, which files a command as a command.

**Unit under test:** `src/commands/install.ts::installCommand`, through
`src/targets/copilot-cli.ts`
**Layer:** use case over an injected project directory
**Requirement:** the "Where things land" table in the top-level `README.md`, and
"What each target does with the edges"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | the command being run | one `install` step, `-t copilot-cli` |
| `inputs/bundles/sample-kit/` | the bundle | 8 files, one resource of each of the 8 kinds |

Byte-for-byte the same `sample-kit` as its five siblings:

```bash
diff -r tests/cases/copilot-every-kind/inputs tests/cases/copilot-cli-every-kind/inputs
```

should print nothing but the `case.json` target.

### Why each row exists

The rows carrying the CLI-specific weight are the **command** (which has no
directory of its own here and becomes a skill), the **MCP server** (which goes
to the one file Copilot in the IDE does not read) and the **skill**, which the
command now has to share a directory with.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | every file in the project after the install | path order |

**Canonical form:** files as written, `\n` line endings, `.github/mcp.json`
pretty-printed by hcm's JSON writer.
**Normalised away:** `.hcm/`.

## Baseline provenance

- [x] **Computed by hand** from the requirement — the "Where things land" table,
  plus GitHub's own documentation for the CLI: the config directory
  (<https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference>),
  custom agents, skills, instructions and MCP servers
  (<https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/overview>),
  and plugins, which is where the CLI's own slash commands live
  (<https://docs.github.com/en/copilot/concepts/agents/about-plugins>).

## Walkthrough

### The rules, stated once

1. **The CLI's repository roots:** agents in `.github/agents/`, skills in
   `.github/skills/<name>/`, instructions in `.github/instructions/`, context in
   `.github/copilot-instructions.md`, settings in
   `.github/copilot/settings.json`. Five directories the IDE reads too — so five
   files below are **identical** to `copilot-every-kind`'s, byte for byte.
2. **The MCP server is the exception.** The CLI reads `.github/mcp.json` in a
   repository and `mcp-config.json` in its home directory; the IDE reads
   `.vscode/mcp.json`. This is the one thing the two harnesses do not share, and
   it is why they are two adapters rather than one.
3. **There is no commands directory.** `.github/prompts/*.prompt.md` is an IDE
   feature, and the CLI's own slash commands ship inside plugins, under
   `com.github.copilot/commands/` — a package format, not a place to install one
   file into. A skill *is* invoked by name, so a command becomes a one-file
   skill.

### `commands/review-pr.md` → `.github/skills/review-pr/SKILL.md`

Rule 3, and the only place in the six cases where a command is not a command:

1. Not `.github/commands/review-pr.md` and not
   `.github/prompts/review-pr.prompt.md`. Both are absent from `outputs/tree/`,
   which is what makes their absence an assertion.
2. `name: review-pr` is **added** from the filename: a skill's frontmatter
   requires it, a command's does not.
3. `allowedTools` becomes `allowed-tools`, as a YAML list — the spelling the
   Agent Skills frontmatter uses.
4. `argumentHint: "[base-branch]"` is **dropped**. A skill has no field for it,
   and a key the CLI ignores is worse than an honest omission. Compare
   `claude-code-every-kind`, where the same line comes out as `argument-hint`.
5. The body is untouched: `$ARGUMENTS` still stands, because whatever the file
   is called, the model is the thing reading it.

### `subagents/code-reviewer.md` → `.github/agents/code-reviewer.agent.md`

Identical to `copilot-every-kind`, down to the byte: `.agent.md`, `name` added,
`tools` as a YAML list, `model: sonnet` kept, `color: blue` dropped. That is
rule 1 — the CLI and the IDE read the same agent file.

### `rules/typescript.md` → `.github/instructions/typescript.instructions.md`

Also identical to `copilot-every-kind`: `appliesTo` becomes one comma-separated
`applyTo` string, `"**/*.ts, **/*.tsx"`.

### `context/*.md` → `.github/copilot-instructions.md`

1. Two marker blocks in filename order, same file as the IDE's.
2. The CLI reads `AGENTS.md` as well, and calls it the *primary* instructions —
   so why not put them there? Because OpenCode and Pi read that same file, and a
   third harness in it would make every uninstall in a mixed folder a question
   about the other two. `copilot-instructions.md` is Copilot's own, and the CLI
   loads it in full. Compare `opencode-every-kind` and `pi-every-kind`, which do
   write `AGENTS.md` and do share it.

### `mcp/filesystem.json` → `.github/mcp.json`

Rule 2, and the smallest reshaping of the six cases:

1. `mcpServers` — the same key Claude Code uses, not the IDE's `servers`.
2. `command` and `args` stay apart, unlike OpenCode's single argv array.
3. `"type": "local"` is **added**. The IDE calls the same transport `stdio`;
   the CLI's word is `local`, and a remote server is `http` rather than `sse`.
4. No `tools` key. The CLI's own default is every tool, so writing `["*"]` would
   add a line that says nothing.

### `skills/dependency-audit/` and `settings/settings.json`

Filed at `.github/skills/dependency-audit/` and `.github/copilot/settings.json`,
both identical to `copilot-every-kind`. Note that the skill's neighbour in
`.github/skills/` is now `review-pr/`, which came from a *command* — which is
why `hcm validate` refuses a bundle holding a skill and a command of one name.

## Why this proves the code is correct

- **It pins:** a command landing in `skills/<name>/SKILL.md` with `name` added,
  `allowed-tools` as a list and `argumentHint` gone; the MCP server landing in
  `.github/mcp.json` under `mcpServers` with `type: local` and no `tools`; and
  the five files that must stay byte-identical to the IDE's.
- **It would catch:** a command written to `.github/commands/` or
  `.github/prompts/` (the tree is exhaustive, so either is a failure), a
  `SKILL.md` without its `name`, `stdio` copied over from the IDE adapter,
  `tools: ["*"]` invented, servers keyed under `servers`, and the MCP file
  drifting to `.vscode/mcp.json` where the CLI would never look.
- **It does not cover:** user scope, where the `.github` prefix goes and the
  filenames become `mcp-config.json` and `settings.json` — that is
  `tests/install-roundtrip.test.ts`; the *consequences* of sharing five files
  with the IDE, which is `tests/multi-harness.test.ts`; and the name collision
  between a command and a skill, which is `tests/name-collisions.test.ts`.

## How to run and debug

```bash
make test-case CASE=copilot-cli-every-kind
make debug-case CASE=copilot-cli-every-kind
```

**Start here:** breakpoint in `src/targets/copilot-cli.ts`, in `actions()`, and
watch the `command` branch return a path under `skills/`.

The two comparisons this case exists to make:

```bash
# What the CLI and the IDE disagree about -- four entries, no changed files
diff -r tests/cases/copilot-every-kind/outputs/tree \
        tests/cases/copilot-cli-every-kind/outputs/tree

# What a command costs when the harness has nowhere to put one
diff -r tests/cases/claude-code-every-kind/outputs/tree \
        tests/cases/copilot-cli-every-kind/outputs/tree
```

The first prints only `mcp.json`, `prompts/`, `skills/review-pr` and `.vscode` —
four files moved, **none rewritten**. That is rule 1 stated as a command.

## When to change this case

- **A red run is a regression until proven otherwise.**
- Adding a resource kind means adding it to all six `*-every-kind` cases.
- **Regenerating** (`UPDATE_BASELINES=1 npm run test:cases`) is a diff a human
  reads line by line, in a commit that changes baselines and nothing else.
