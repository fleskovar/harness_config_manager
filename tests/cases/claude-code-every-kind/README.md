# Test case: claude-code-every-kind

## What this proves

Installing a bundle holding **one resource of every kind** into Claude Code puts
each one where Claude Code looks for it, rewritten into Claude Code's own
frontmatter dialect, with every reference between them repointed at the new
layout.

**Unit under test:** `src/commands/install.ts::installCommand`, through
`src/targets/claude-code.ts`
**Layer:** use case over an injected project directory
**Requirement:** the "Where things land" table in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | the command being run | one `install` step, `-t claude-code` |
| `inputs/bundles/sample-kit/` | the bundle | 8 files, one resource of each of the 8 kinds |

The project starts empty — there is no `inputs/project/` — so every file in
`outputs/tree/` was put there by this install and nothing else.

### Why each row exists

One resource per kind, because the mapping is per kind and a kind with no
resource proves nothing about where that kind goes:

| Resource | Demonstrates |
| --- | --- |
| `subagents/code-reviewer.md` | subagent filing, and the `tools`/`color` frontmatter rewrite |
| `skills/dependency-audit/` | a skill is a **directory**: `SKILL.md` is re-rendered, `checklist.md` is copied byte-for-byte |
| `commands/review-pr.md` | command filing, and the `argumentHint` → `argument-hint` rename |
| `rules/typescript.md` | rule filing, and `appliesTo` → `paths` |
| `context/10-conventions.md` | a context section becomes a marker block, not a file |
| `context/20-pull-requests.md` | a second section, to prove filename order decides block order |
| `mcp/filesystem.json` | an MCP server goes to `.mcp.json`, verbatim |
| `settings/settings.json` | a settings fragment is deep-merged, not copied |

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | every file in the project after the install | path order |

`outputs/tree/` is **exhaustive**: a file absent from it must be absent from the
project. That is what makes this one comparison enough to replace the eleven
separate assertions this case was converted from.

**Canonical form:** files as written, `\n` line endings, JSON pretty-printed by
hcm's own writer.
**Normalised away:** `.hcm/` — hcm's ledger holds timestamps and absolute paths,
and is asserted by the cases that are actually about receipts.

## Baseline provenance

- [x] **Computed by hand** from the requirement — the "Where things land" table
  in the top-level `README.md` gives the destination for each of the eight
  kinds, and the walkthrough below derives every rewrite from the bundle file
  beside it.

## Walkthrough

### The rules, stated once

1. **Claude Code's roots:** subagents in `.claude/agents/`, skills in
   `.claude/skills/<name>/`, commands in `.claude/commands/`, rules in
   `.claude/rules/`, settings in `.claude/settings.json`, MCP servers in
   `.mcp.json` at the project root, context in `CLAUDE.md` at the project root.
2. **Frontmatter is translated, not copied.** A key the harness does not know is
   dropped rather than passed through.
3. **A reference is rewritten relative to the file that contains it**, and only
   when it resolves to a file this install actually writes.

### `subagents/code-reviewer.md` → `.claude/agents/code-reviewer.md`

1. The bundle's frontmatter has no `name`; Claude Code needs one, so it is taken
   from the filename → `name: code-reviewer`.
2. `tools` is a YAML list in the bundle. Claude Code wants a comma-separated
   string → `tools: Read, Grep, Bash, mcp__filesystem__read_text_file`.
3. `model: sonnet` is a key Claude Code has, so it survives unchanged.
4. `color: blue` is **not** a key Claude Code's agent frontmatter has, so it is
   dropped. Grep `outputs/tree/.claude/agents/code-reviewer.md` for `color` and
   you will not find it — that absence is rule 2 above.
5. The body says ``Apply the conventions in `rules/typescript.md``` . That file
   lands at `.claude/rules/typescript.md`; this file lives in
   `.claude/agents/`, so the way there is up one and down into `rules/` →
   ``../rules/typescript.md``.
6. Likewise ``skills/dependency-audit/checklist.md`` →
   ``../skills/dependency-audit/checklist.md``.

### `skills/dependency-audit/` → `.claude/skills/dependency-audit/`

1. A skill is a directory, so both its files move together.
2. `SKILL.md` is re-rendered with `name: dependency-audit` added from the
   directory name.
3. Its reference to ``checklist.md`` is a sibling **before and after** — the
   skill directory survives as a directory — so it is left exactly as written.
4. Its reference to ``subagents/code-reviewer.md`` has to climb out of
   `.claude/skills/dependency-audit/` (two levels) and back down into `agents/`
   → ``../../agents/code-reviewer.md``.
5. `checklist.md` is a supporting file: copied byte-for-byte, no frontmatter, no
   rewriting. Diff it against `inputs/bundles/sample-kit/skills/dependency-audit/checklist.md`
   and there is no difference.

### `commands/review-pr.md` → `.claude/commands/review-pr.md`

1. `argumentHint` is hcm's canonical spelling; Claude Code's is `argument-hint`
   → `argument-hint: "[base-branch]"`.
2. `allowedTools` (a YAML list) → `allowed-tools: Read, Grep, Bash`, a string,
   for the same reason as the subagent's `tools`.
3. The file lands in `.claude/commands/`, one level under the project root, so
   ``skills/dependency-audit/checklist.md`` →
   ``../skills/dependency-audit/checklist.md`` and
   ``subagents/code-reviewer.md`` → ``../agents/code-reviewer.md``. Note the
   second one changes **directory name as well as depth**: `subagents/` in the
   bundle is `agents/` in Claude Code.

### `rules/typescript.md` → `.claude/rules/typescript.md`

1. `appliesTo` is hcm's canonical name for the globs; Claude Code's is `paths`,
   and it takes a YAML list, so the two entries come through as a list:

   ```yaml
   paths:
     - "**/*.ts"
     - "**/*.tsx"
   ```

2. `appliesTo` itself does not appear in the output — it was renamed, not
   duplicated.

### `context/10-conventions.md` and `context/20-pull-requests.md` → `CLAUDE.md`

1. Context is the one kind that is **not** a file of its own. Each section
   becomes a marker-delimited block inside `CLAUDE.md`:
   `<!-- hcm:begin sample-kit/10-conventions -->` … `<!-- hcm:end … -->`.
2. The block id is `<bundle>/<section>`, which is what lets uninstall remove
   exactly these two blocks from a file that may hold hand-written notes too.
3. The `10-` and `20-` prefixes order them: `## Review conventions` appears
   before `## Pull requests` in `outputs/tree/CLAUDE.md`.
4. `CLAUDE.md` sits at the **project root**, so a reference from it has nothing
   to climb out of: ``skills/dependency-audit/checklist.md`` →
   ``.claude/skills/dependency-audit/checklist.md``, which looks like a rooted
   path but is an ordinary relative one.

### `mcp/filesystem.json` → `.mcp.json`

1. The server is filed under `mcpServers.filesystem` — the file's basename is
   the server name.
2. The payload is copied verbatim, `env` and all. Claude Code needs no extra
   keys, so nothing is added.

### `settings/settings.json` → `.claude/settings.json`

1. A settings fragment is **merged**, so the result is a document with the
   fragment's leaves in it rather than a copy of the fragment.
2. `permissions.defaultMode` is a scalar and lands as one.
3. `permissions.allow` is an array and is **appended to**, which is why
   uninstalling one bundle can leave another's entries in place.

## Why this proves the code is correct

- **It pins:** the destination of all eight kinds, the four frontmatter
  translations (`tools` joining, `argumentHint` hyphenation, `appliesTo` →
  `paths`, `color` being dropped), the block-id format, section ordering by
  filename, and the exact relative form of five rewritten references.
- **It would catch:** a resource filed in the wrong directory, a frontmatter key
  passed through that Claude Code would reject, a reference rewritten from the
  project root instead of from the containing file, and the two context sections
  swapping order.
- **It does not cover:** any other harness (one case each, next door), conflicts
  with existing files (`adopt-identical-mcp-server`, `conflict-*`), or removal
  (`uninstall-leaves-project-empty`).

## How to run and debug

```bash
make test-case CASE=claude-code-every-kind    # run only this case
make debug-case CASE=claude-code-every-kind   # run it with no test framework in the stack
```

**Start here:** breakpoint in `src/targets/claude-code.ts`, in `actions()`, then
run `make debug-case CASE=claude-code-every-kind` and step. It is called once
per resource, so the first eight stops are the eight rows in the table above.

To compare by hand instead:

```bash
npx tsx src/cli.ts install tests/cases/claude-code-every-kind/inputs/bundles/sample-kit \
  -t claude-code
diff -r . tests/cases/claude-code-every-kind/outputs/tree
```

## When to change this case

- **A red run is a regression until proven otherwise.** Do not regenerate the
  baseline to get green.
- Adding a resource kind means adding it to `inputs/bundles/sample-kit/` in
  **all five** `*-every-kind` cases, so the harnesses stay comparable:
  `diff -r tests/cases/claude-code-every-kind/outputs/tree tests/cases/pi-every-kind/outputs/tree`
  should only ever show things the two harnesses genuinely disagree about.
- **Regenerating** (`UPDATE_BASELINES=1 npm run test:cases`) produces a diff a
  human reads line by line, in a commit that changes baselines and nothing else.
