# Test case: pi-every-kind

## What this proves

The same bundle as the other four `*-every-kind` cases, installed into **Pi** —
the harness with neither sub-agents nor a built-in MCP client, where a subagent
therefore becomes a *skill* and the MCP server is written on the convention an
extension will read.

**Unit under test:** `src/commands/install.ts::installCommand`, through
`src/targets/pi.ts`
**Layer:** use case over an injected project directory
**Requirement:** the "Where things land" table in the top-level `README.md`, and
"What each target does with the edges"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | the command being run | one `install` step, `-t pi` |
| `inputs/bundles/sample-kit/` | the bundle | 8 files, one resource of each of the 8 kinds |

The same `sample-kit` as its four siblings. Note the case installs **without**
`--pi-subagents`, so this is the default Pi layout; the extension's layout is
`pi-subagents-extension`.

### Why each row exists

Two rows carry the Pi-specific weight. The **subagent** proves the
subagent-becomes-a-skill mapping and the frontmatter that mapping has to throw
away. The **MCP server** proves hcm writes it anyway, in Claude Code's shape,
into a file Pi shares.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | every file in the project after the install | path order |

**Canonical form:** files as written, `\n` line endings.
**Normalised away:** `.hcm/`.

## Baseline provenance

- [x] **Computed by hand** from the requirement — the "Where things land" table
  and Pi's Agent Skills frontmatter (<https://pi.dev/docs/latest/quickstart>).

## Walkthrough

### The rules, stated once

1. **Pi's roots:** skills in `.pi/skills/<name>/`, commands in `.pi/prompts/`,
   settings in `.pi/settings.json`, context **and rules** in `AGENTS.md` at the
   project root, MCP servers in `.mcp.json` at the project root.
2. **A subagent is a skill here.** Pi has no delegation, so `subagents/x.md`
   installs as `.pi/skills/x/SKILL.md`.
3. **Agent Skills frontmatter is only `name` and `description`.** Anything else
   in the canonical resource has nowhere to go.

### `subagents/code-reviewer.md` → `.pi/skills/code-reviewer/SKILL.md`

The single most reshaped resource in the five cases:

1. A **file becomes a directory**: `code-reviewer.md` → `code-reviewer/SKILL.md`.
2. `name: code-reviewer` added, `description` kept — and that is the whole of
   the frontmatter. `tools`, `model` and `color` are all dropped, because rule 3
   leaves nowhere to put them:

   ```yaml
   ---
   name: code-reviewer
   description: Reviews changed code for correctness and clarity.
   ---
   ```

   Compare `.opencode/agents/code-reviewer.md` next door, which keeps `model`
   and `color` and drops only `tools`. Same bundle file, four harnesses, four
   different subsets survive.
3. The body is unchanged apart from references. With no delegation, this prompt
   runs in the main context when invoked as `/skill:code-reviewer` rather than
   in a subagent's own — a consequence worth knowing and one no assertion can
   express, which is why it is written here.

**The collision this implies:** a subagent and a skill now share one namespace.
A bundle shipping `subagents/helper.md` *and* `skills/helper/` would have them
overwrite each other's `SKILL.md`. `hcm validate` refuses such a bundle — see
the `validate-names-every-mistake` case.

### `rules/typescript.md` → `AGENTS.md`

1. Like OpenCode, Pi has no glob-scoped rule format — but unlike OpenCode it has
   no `instructions` array either, so there is nowhere to register a rule file.
   The rule therefore becomes a **marker block in `AGENTS.md`**, not a file.
2. Its globs are stated in prose the model can honour:
   `**Applies to:** ` `` `**/*.ts` ``, `` `**/*.tsx` ``.
3. So `AGENTS.md` here holds **three** blocks — two context sections and one
   rule — where OpenCode's holds two.

### `context/*.md` → `AGENTS.md`

Two marker blocks in filename order, above the rule block.

`AGENTS.md` is **shared with OpenCode**. The context blocks in
`outputs/tree/AGENTS.md` are byte-identical to
`opencode-every-kind/outputs/tree/AGENTS.md`; the difference between the two
files is exactly the rule block, which only Pi puts here.

### `mcp/filesystem.json` → `.mcp.json`

1. Pi has no built-in MCP client — that is extension territory. hcm writes the
   server anyway, in the same `mcpServers` shape and the same root-level
   `.mcp.json` that Claude Code uses: inert until an MCP extension is installed,
   correct the moment one is.
2. So `outputs/tree/.mcp.json` is byte-identical to
   `claude-code-every-kind/outputs/tree/.mcp.json`, and in a folder set up for
   both harnesses it is literally one file with two claims on it.

### `commands/review-pr.md` → `.pi/prompts/review-pr.md`

`prompts/`, Pi's word for a command. No suffix, unlike Copilot.

### `skills/dependency-audit/` → `.pi/skills/dependency-audit/`

Filed beside the subagent-turned-skill, which is what makes the namespace
shared. Its reference to the subagent is now a reference to a **sibling skill**:
``../code-reviewer/SKILL.md`` rather than Claude Code's
``../../agents/code-reviewer.md``.

### `settings/settings.json` → `.pi/settings.json`

Merged, into a file of its own rather than a shared config.

## Why this proves the code is correct

- **It pins:** subagent-as-skill including the file→directory promotion, the
  exact frontmatter subset Agent Skills allow, the rule landing in `AGENTS.md`
  as prose rather than as a file, `.mcp.json` matching Claude Code's byte for
  byte, and the sibling-skill reference form.
- **It would catch:** `tools` or `model` leaking into a `SKILL.md` Pi would
  reject, a subagent written to `.pi/agents/` without the extension being
  declared, a rule written as a file with nothing loading it, and an MCP server
  written in some Pi-specific shape rather than the shared one.
- **It does not cover:** the `--pi-subagents` layout (`pi-subagents-extension`),
  or what happens when Claude Code and Pi both claim `.mcp.json`
  (`shared-mcp-between-harnesses`).

## How to run and debug

```bash
make test-case CASE=pi-every-kind
make debug-case CASE=pi-every-kind
```

**Start here:** breakpoint in `src/targets/pi.ts`, in `actions()`, on the
`subagent` branch — that is where the file becomes a directory.

## When to change this case

- **A red run is a regression until proven otherwise.**
- Adding a resource kind means adding it to all five `*-every-kind` cases.
- **Regenerating** (`UPDATE_BASELINES=1 npm run test:cases`) is a diff a human
  reads line by line, in a commit that changes baselines and nothing else.
