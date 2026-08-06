# Authoring bundles

A practical guide to writing a bundle that installs cleanly into all three
harnesses. See the [README](../README.md) for the CLI reference, and
[`bundles/ts-review-kit`](../bundles/ts-review-kit) for a complete example.

## Start from the scaffold

```bash
hcm init my-kit --name my-kit
hcm validate ./my-kit
```

`hcm validate` checks for the mistakes that actually bite: agents and skills
without a `description`, MCP servers with neither `command` nor `url`, malformed
`appliesTo`, and duplicate names within a kind.

## The manifest

```yaml
name: my-kit          # required; must be usable as a filename
version: 1.0.0        # required
description: ...      # shown by `hcm list` and `hcm info`
author: ...
homepage: ...
tags: [review, typescript]
targets: [claude-code, copilot]   # optional; omit to support all
```

Set `targets` only when a bundle genuinely does not make sense elsewhere.
Installing into an unlisted target is refused rather than silently partial.

## Writing each resource kind

### Agents — `agents/<name>.md`

```markdown
---
description: Reviews changed code for correctness and security. Use before opening a PR.
tools: [Read, Grep, Glob, Bash]
model: sonnet
---

You are a meticulous code reviewer...
```

The filename is the agent name unless frontmatter sets `name`. Write `tools` as a
YAML list; `hcm` converts it to the comma-separated string Claude Code expects
and leaves it a list for Copilot. The body becomes the system prompt.

The `description` is what the harness uses to decide when to delegate, so write
it as *when to use this*, not *what this is*.

### Skills — `skills/<name>/SKILL.md` plus supporting files

```
skills/dependency-audit/
├── SKILL.md
└── checklist.md
```

Every file in the directory is copied. `SKILL.md` is re-rendered so its
frontmatter matches the target; supporting files are copied byte-for-byte.
Reference them by relative path from `SKILL.md`.

### Commands — `commands/<name>.md`

```markdown
---
description: Review the current branch against a base branch
argumentHint: "[base-branch]"
allowedTools: [Read, Grep, Bash]
---

Review this branch against `$ARGUMENTS`...
```

Becomes a slash command in Claude Code and Reasonix, and a `.prompt.md` file for
Copilot.

### Rules — `rules/<name>.md`

```markdown
---
description: TypeScript conventions
appliesTo:
  - "**/*.ts"
  - "**/*.tsx"
---

- Prefer named exports.
```

`appliesTo` is the canonical field. It becomes `paths:` for Claude Code and
Reasonix, and `applyTo: '**/*.ts, **/*.tsx'` for Copilot. Omit it and the rule
loads at session start everywhere (Copilot gets `applyTo: '**'`).

### Context — `context/<name>.md`

Always-loaded instructions. These are merged into the harness's top-level
instruction file (`CLAUDE.md`, `.github/copilot-instructions.md`, `REASONIX.md`)
inside a marker block:

```markdown
<!-- hcm:begin my-kit/conventions -->
## Review conventions
...
<!-- hcm:end my-kit/conventions -->
```

Start the body at heading level 2 — it is being pasted into someone else's
document. Keep it short; this text costs context in every single session.

### MCP servers — `mcp/<name>.json`

One file per server. The filename is the server name.

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
}
```

Recognised keys: `command`, `args`, `url`, `env`, `startupTimeoutSeconds`,
`callTimeoutSeconds`. `hcm` adds Copilot's required `type` (`stdio` or `http`,
inferred from `command` vs `url`) and converts the timeouts to Reasonix's
snake_case `[[plugins]]` keys.

Never commit secrets. Reference an environment variable instead:

```json
{ "command": "my-server", "env": { "API_KEY": "${MY_API_KEY}" } }
```

### Settings — `settings/settings.json`

A fragment deep-merged into the harness's settings file.

```json
{
  "permissions": {
    "allow": ["Bash(git diff:*)", "Bash(npm test:*)"]
  }
}
```

Each **leaf** becomes its own receipt, so two bundles can own different keys in
the same file and uninstall independently. Arrays are *appended to*, not
replaced, and de-duplicated — which is what permission lists need. Scalars are
*set*; if one is already present with a different value, that is a conflict.

Keep fragments minimal. Every key you set is a key the user cannot change
without `hcm status` reporting drift.

### Assets — `assets/**`

Copied verbatim into the harness directory. Use for scripts, templates and images
that your agents or skills reference.

## Sharing a bundle

```bash
git init && git add . && git commit -m "Add my-kit"
git remote add origin git@github.com:acme/my-kit.git && git push -u origin main
```

Then anywhere else — paste whatever GitHub gave you, whether that's the short
form, the browser address bar, or the clone box:

```bash
hcm registry add acme/my-kit
hcm registry add https://github.com/acme/my-kit
hcm registry add git@github.com:acme/my-kit.git
hcm install my-kit
```

A monorepo of bundles works too — point at the subdirectory. Linking straight at
a bundle's `hcm.yaml` in the GitHub file viewer works as well; `hcm` takes the
directory containing it:

```bash
hcm registry add acme/agent-kits/bundles/my-kit#v1.2.0
hcm registry add https://github.com/acme/agent-kits/tree/v1.2.0/bundles/my-kit
hcm registry add https://github.com/acme/agent-kits/blob/v1.2.0/bundles/my-kit/hcm.yaml
```

Pin a tag for anything a team depends on; `#ref` accepts branches, tags and SHAs.
If your branch name contains a slash, use the shorthand form
(`acme/agent-kits/bundles/my-kit#feature/login`) — a `/tree/` URL can't express
that unambiguously.

## Shipping several bundles together

Put each bundle in its own folder at the same level and the parent becomes a
*collection*:

```
agent-kits/
├── README.md
├── review-kit/
│   ├── hcm.yaml
│   └── agents/code-reviewer.md
└── db-kit/
    ├── hcm.yaml
    └── mcp/postgres.json
```

```bash
hcm registry add acme/agent-kits    # registers review-kit and db-kit
hcm install acme/agent-kits         # installs both
hcm install acme/agent-kits/db-kit  # or just one
```

Bundle names must be unique within a collection, since each is registered and
installed under its own name. Files in the collection root that are not bundle
directories — a README, a LICENSE, CI config — are ignored.

Prefer a collection over one giant bundle when the pieces are independently
useful: users install and uninstall at bundle granularity, so splitting lets
them take the review kit without the database tooling.

## Testing a bundle before publishing

```bash
hcm info my-kit                 # every planned write, per target
hcm install my-kit --dry-run    # includes conflict detection
mkdir /tmp/probe && cd /tmp/probe
hcm install /path/to/my-kit && hcm status && hcm uninstall my-kit
```

A clean install/uninstall round-trip in an empty directory should leave nothing
behind. If it does not, that is a bug worth reporting.

## Conventions that avoid conflicts

Bundles collide when two of them claim the same item. Cheap habits that prevent it:

- **Namespace MCP server filenames** when wrapping a common service:
  `mcp/acme-postgres.json`, not `mcp/postgres.json`.
- **Prefix agent and command names** with something recognisable if the bundle
  is for a specific team or product.
- **Prefer `context/` over `settings/`** for anything advisory. Instruction text
  merges additively; settings keys are exclusive.
- **Keep one concern per bundle.** Users install and uninstall at bundle
  granularity, so a bundle bundling unrelated things forces all-or-nothing.

`hcm install` fails with the owning bundle named when a conflict is detected, so
collisions surface at install time rather than as silent overwrites.
