# Test case: reasonix-every-kind

## What this proves

The same bundle as the other four `*-every-kind` cases, installed into
**Reasonix** — the only harness whose config is TOML, so ownership is expressed
as comment-delimited blocks rather than as JSON keys, and the only one where a
subagent keeps its tool allowlist while still being a skill.

**Unit under test:** `src/commands/install.ts::installCommand`, through
`src/targets/reasonix.ts`
**Layer:** use case over an injected project directory
**Requirement:** the "Where things land" table in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | the command being run | one `install` step, `-t reasonix` |
| `inputs/bundles/sample-kit/` | the bundle | 8 files, one resource of each of the 8 kinds |

The same `sample-kit` as its four siblings.

### Why each row exists

Two rows carry the Reasonix-specific weight: the **MCP server** and the
**settings fragment**, which are the two things that land in `reasonix.toml` and
therefore the two that need marker blocks instead of pointers. The **subagent**
carries the third: it is a skill here, as on Pi, but a much less lossy one.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | every file in the project after the install | path order |

**Canonical form:** files as written, `\n` line endings, TOML as `smol-toml`
emits it.
**Normalised away:** `.hcm/`.

## Baseline provenance

- [x] **Computed by hand** from the requirement — the "Where things land" table
  and the Reasonix configuration guide
  (<https://github.com/esengine/DeepSeek-Reasonix/blob/main-v2/docs/GUIDE.md>).

## Walkthrough

### The rules, stated once

1. **Reasonix's roots:** skills in `.reasonix/skills/<name>/`, commands in
   `.reasonix/commands/`, context **and rules** in `REASONIX.md`, MCP servers
   and settings in `reasonix.toml`.
2. **A subagent is a skill**, as on Pi — but Reasonix's skill frontmatter is
   rich enough to say what kind of skill it is.
3. **TOML has no pointer, so ownership is a block.** A JSON destination lets hcm
   claim `mcpServers.filesystem` by path; TOML does not, so each contribution is
   wrapped in `# hcm:begin <id>` / `# hcm:end <id>` comments and removed by id.

### `subagents/code-reviewer.md` → `.reasonix/skills/code-reviewer/SKILL.md`

1. A file becomes a directory, as on Pi.
2. Unlike Pi, almost everything survives, because Reasonix's frontmatter has
   somewhere for it:
   - `invocation: manual` — **added**. This is what stops the skill loading
     itself into every session; a subagent is invoked by name.
   - `runAs: subagent` — **added**, saying what it is.
   - `allowed-tools` — the canonical `tools` list, kept as a list under
     Reasonix's name for it.
   - `model` and `color` both survive.
3. So of the four harnesses that file a subagent, Reasonix keeps the most:
   Copilot keeps `tools` as a list, Claude Code joins it to a string, OpenCode
   drops it, Pi drops nearly everything. The same bundle line, four answers.

### `rules/typescript.md` → `REASONIX.md`

As on Pi: no glob-scoped rule format and no instructions array, so the rule
becomes a marker block with its globs stated in prose —
`**Applies to:** ` `` `**/*.ts` ``, `` `**/*.tsx` ``.

### `context/*.md` → `REASONIX.md`

Two marker blocks in filename order, then the rule block. `REASONIX.md` is
Reasonix's alone — unlike `AGENTS.md`, which OpenCode and Pi share.

### `mcp/filesystem.json` → `reasonix.toml` → `[[plugins]]`

1. Reasonix registers a server as an **array-of-tables entry**, not a keyed
   object, and the name moves *into* the entry as a field:

   ```toml
   # hcm:begin sample-kit/plugins/filesystem
   [[plugins]]
   name = "filesystem"
   command = "npx"
   args = [ "-y", "@modelcontextprotocol/server-filesystem", "." ]
   env = { FS_LOG = "warn" }
   # hcm:end sample-kit/plugins/filesystem
   ```

2. The block id is `sample-kit/plugins/filesystem` — bundle, table, name. That
   id is the whole of hcm's claim on this text: uninstall finds the two comment
   lines and removes what is between them, leaving anything a person wrote in
   the same file untouched.
3. Because entries **append** rather than collide, two bundles can each add a
   `[[plugins]]`. What they may not do is both call it `filesystem` — an
   ambiguous server name is refused at plan time.

### `settings/settings.json` → `reasonix.toml` → `[permissions]`

1. A second block, id `sample-kit/settings/settings`, holding a normal TOML
   table.
2. It sits *below* the plugins block, separated by a blank line — the two are
   independent claims on one file, and either can be removed without disturbing
   the other. That is the TOML counterpart of two bundles owning different keys
   in one JSON document.

### `commands/review-pr.md` → `.reasonix/commands/review-pr.md`

Filed as a command. Its reference to the subagent points at the skill the
subagent became: ``../skills/code-reviewer/SKILL.md``.

### `skills/dependency-audit/` → `.reasonix/skills/dependency-audit/`

Beside `code-reviewer/`, sharing the namespace — the same collision risk Pi has,
and the same `hcm validate` refusal covers both.

## Why this proves the code is correct

- **It pins:** the two added frontmatter keys that make a skill behave as a
  subagent (`invocation: manual`, `runAs: subagent`), `allowed-tools` as a list,
  the `[[plugins]]` array-of-tables form with the name as a field, both marker
  block ids, and the two independent blocks coexisting in one TOML file.
- **It would catch:** a skill loading itself into every session because
  `invocation` was lost, a server written as `[plugins.filesystem]` instead of
  `[[plugins]]`, a block emitted without its markers (which would make uninstall
  unable to find it), and the settings block swallowing the plugins block.
- **It does not cover:** two bundles writing `[[plugins]]` into one file
  (`shared-reasonix-plugins`), or an existing hand-written `reasonix.toml`
  colliding (`conflict-existing-toml-table`).

## How to run and debug

```bash
make test-case CASE=reasonix-every-kind
make debug-case CASE=reasonix-every-kind
```

**Start here:** breakpoint in `src/merge/toml.ts`, in `upsertBlock`, to watch a
block being placed; or `src/targets/reasonix.ts::actions` to watch one being
built.

## When to change this case

- **A red run is a regression until proven otherwise.**
- Adding a resource kind means adding it to all five `*-every-kind` cases.
- **Regenerating** (`UPDATE_BASELINES=1 npm run test:cases`) is a diff a human
  reads line by line, in a commit that changes baselines and nothing else.
