# Test case: copilot-every-kind

## What this proves

The same bundle as `claude-code-every-kind`, installed into **GitHub Copilot**:
every kind lands under `.github/`, filenames grow the suffixes Copilot
recognises, and the frontmatter goes the *opposite* way from Claude Code's on
the two keys where the harnesses disagree.

**Unit under test:** `src/commands/install.ts::installCommand`, through
`src/targets/copilot.ts`
**Layer:** use case over an injected project directory
**Requirement:** the "Where things land" table in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | the command being run | one `install` step, `-t copilot` |
| `inputs/bundles/sample-kit/` | the bundle | 8 files, one resource of each of the 8 kinds |

Byte-for-byte the same `sample-kit` as the other four `*-every-kind` cases, on
purpose: holding the input constant is what makes the five output trees
directly comparable.

```bash
diff -r tests/cases/claude-code-every-kind/inputs tests/cases/copilot-every-kind/inputs
```

should print nothing but the `case.json` target.

### Why each row exists

As `claude-code-every-kind`: one resource per kind, because the mapping is per
kind. The rows that carry the *Copilot-specific* weight are the subagent (list
vs string tools), the rule (one glob string vs a list) and the MCP server (a
`type` Copilot needs and Claude Code does not).

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | every file in the project after the install | path order |

**Canonical form:** files as written, `\n` line endings.
**Normalised away:** `.hcm/`.

## Baseline provenance

- [x] **Computed by hand** from the requirement — the "Where things land" table,
  plus Copilot's documented file naming
  (<https://awesome-copilot.github.com/learning-hub/copilot-configuration-basics/>).

## Walkthrough

### The rules, stated once

1. **Copilot's roots:** everything under `.github/` — agents in
   `.github/agents/`, skills in `.github/skills/<name>/`, commands in
   `.github/prompts/`, rules in `.github/instructions/`, settings in
   `.github/copilot/settings.json`, context in `.github/copilot-instructions.md`.
   The one exception is the MCP server, which VS Code reads from
   `.vscode/mcp.json`.
2. **Copilot identifies a file kind by its suffix**, so the names grow:
   `.agent.md`, `.prompt.md`, `.instructions.md`.
3. A reference is rewritten relative to the file containing it — and, because of
   rule 2, the **name** it points at changes too.

### `subagents/code-reviewer.md` → `.github/agents/code-reviewer.agent.md`

1. `.agent.md`, not `.md`: rule 2.
2. `name: code-reviewer` is added from the filename, as everywhere.
3. `tools` stays a **YAML list**. This is the exact inverse of Claude Code,
   which joins it into a string — the same canonical `tools:` in the same
   bundle file, two different renderings:

   ```yaml
   tools:
     - Read
     - Grep
     - Bash
     - mcp__filesystem__read_text_file
   ```

4. `model: sonnet` survives; `color: blue` is dropped, as it is for Claude Code.

### `rules/typescript.md` → `.github/instructions/typescript.instructions.md`

1. `appliesTo` becomes `applyTo` — one letter different from Claude Code's
   `paths`, and a different **shape**: Copilot takes a single comma-separated
   string, not a list.
2. So the two globs collapse into one value:
   `applyTo: "**/*.ts, **/*.tsx"`.

### `commands/review-pr.md` → `.github/prompts/review-pr.prompt.md`

1. `prompts/`, not `commands/` — Copilot's word for the same thing.
2. `.prompt.md`: rule 2.

### `skills/dependency-audit/` → `.github/skills/dependency-audit/`

1. The directory survives as a directory, so ``checklist.md`` next to
   `SKILL.md` is still ``checklist.md``.
2. Its reference to the subagent has to climb two levels and land on the
   **suffixed** name: ``../../agents/code-reviewer.agent.md``. Compare the same
   line in `claude-code-every-kind`, where it is
   ``../../agents/code-reviewer.md`` — same bundle text, different output,
   because the destination filename differs.

### `context/*.md` → `.github/copilot-instructions.md`

1. Two marker blocks, ids `sample-kit/10-conventions` and
   `sample-kit/20-pull-requests`, in filename order.
2. This file lives **inside** `.github/`, one directory nearer the skill than
   Claude Code's root-level `CLAUDE.md` is. So the same reference comes out
   shorter: ``skills/dependency-audit/checklist.md``, where Claude Code writes
   ``.claude/skills/dependency-audit/checklist.md``. That difference is rule 3
   doing its job, and it is the clearest single illustration of why references
   are remapped per harness rather than once.

### `mcp/filesystem.json` → `.vscode/mcp.json`

1. Not `.github/`: VS Code owns this file.
2. The key is `servers`, not `mcpServers`.
3. `"type": "stdio"` is **added** — Copilot requires it and the bundle does not
   say it, because a bundle describes the server rather than any one client's
   schema.

### `settings/settings.json` → `.github/copilot/settings.json`

Merged, exactly as for Claude Code — the destination differs, the merge does not.

## Why this proves the code is correct

- **It pins:** the `.github/` layout, all three filename suffixes, `tools` as a
  list, `applyTo` as one comma-separated string, the added `stdio` type, and the
  shorter reference form that follows from `copilot-instructions.md` living
  inside `.github/`.
- **It would catch:** a suffix dropped from a filename, `tools` being joined the
  way Claude Code joins it, `applyTo` emitted as a list, a missing `type` on the
  MCP server, and a reference that forgot the `.agent.md` suffix.
- **It does not cover:** the other four harnesses (one case each), and anything
  about conflicts or removal.

## How to run and debug

```bash
make test-case CASE=copilot-every-kind
make debug-case CASE=copilot-every-kind
```

**Start here:** breakpoint in `src/targets/copilot.ts`, in `actions()`.

The comparison this case exists to make:

```bash
diff -r tests/cases/claude-code-every-kind/outputs/tree \
        tests/cases/copilot-every-kind/outputs/tree
```

Every line that prints is something the two harnesses genuinely disagree about,
and every one of them is explained above.

## When to change this case

- **A red run is a regression until proven otherwise.**
- Adding a resource kind means adding it to all five `*-every-kind` cases.
- **Regenerating** (`UPDATE_BASELINES=1 npm run test:cases`) is a diff a human
  reads line by line, in a commit that changes baselines and nothing else.
