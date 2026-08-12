# Authoring bundles

A practical guide to writing a bundle that installs cleanly into all three
harnesses. See the [README](../README.md) for the CLI reference, and
[`bundles/ts-review-kit`](../bundles/ts-review-kit) for a complete example.

## Start from the scaffold

```bash
hcm init my-kit --name my-kit
hcm validate ./my-kit
hcm registry add ./my-kit --dev
```

`--dev` matters while you are authoring. Registering normally copies the bundle
into `~/.hcm/store`, so what you install is a snapshot taken at that moment and
later edits need an `hcm update`. A `--dev` entry is read from your working
directory every time, so the loop is edit → `hcm install my-kit` → look at the
result, with nothing to refresh in between.

`hcm validate` checks for the mistakes that actually bite: subagents and skills
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
                                  # known ids: claude-code, copilot, reasonix,
                                  #            opencode, pi
dependencies:                     # optional; see below
  - jira-board@^1.2.0
```

Set `targets` only when a bundle genuinely does not make sense elsewhere.
Installing into an unlisted target is refused rather than silently partial.

## Depending on another bundle

When several of your kits assume the same background — how the team's JIRA board
is laid out, which database the services use — write that once and require it:

```yaml
dependencies:
  - jira-board                       # any version
  - team-conventions@^2.0.0          # a range
  - name: db-kit                     # the long form
    version: ">=2.1 <3"
    source: acme/agent-kits/db-kit   # where to find it, if it is not registered
```

`hcm install my-kit` then installs `jira-board` first, and `hcm uninstall
my-kit` takes it away again unless something else still needs it. Users see the
tree before anything is written.

**Give a `source` to anything you publish.** A dependency is looked for in the
registry, then beside your bundle in the same collection, then at its `source`.
The first two are what make authoring pleasant — a monorepo of kits resolves
with nothing registered — but neither is available to someone who has just
pasted your repo URL. `hcm validate` runs the same lookup and will tell you:

```
$ hcm validate ./my-kit
my-kit v1.0.0
  4 resource(s)
!   "my-kit" requires the bundle "jira-board", which hcm cannot find
```

**Version ranges** are the familiar subset: `1.2.3`, `^1.2.3`, `~1.2.3`,
`>=1.2.3`, `1.2.x`, `*`, and those joined by a space (*and*) or `||` (*or*). A
range hcm does not understand is refused when the manifest is read, rather than
matching nothing later. Only one version of a bundle can be installed in a
scope, so prefer a wide range (`^1.2.0`) over a pinned one: two kits that pin
different patch versions of the same dependency cannot both be installed.

**Keep the graph shallow, and never circular.** A cycle is refused with the loop
named; if two bundles genuinely need each other, the shared part wants to be a
third bundle they both require.

Depending on a bundle is also the way to *share* resources deliberately. If your
kit ships the same `skills/jira-board/` as the bundle it requires, byte for
byte, the second install writes nothing and both claim the one copy — see
[Conventions that avoid conflicts](#conventions-that-avoid-conflicts).

## Writing each resource kind

### Subagents — `subagents/<name>.md`

```markdown
---
description: Reviews changed code for correctness and security. Use before opening a PR.
tools: [Read, Grep, Glob, Bash]
model: sonnet
---

You are a meticulous code reviewer...
```

The filename is the subagent name unless frontmatter sets `name`. Write `tools` as a
YAML list; `hcm` converts it to the comma-separated string Claude Code expects,
leaves it a list for Copilot, and renames it `allowed-tools` for Reasonix. The
body becomes the system prompt.

The `description` is what the harness uses to decide when to delegate, so write
it as *when to use this*, not *what this is*.

Reasonix has no separate agents directory: a subagent profile is a skill carrying
`runAs: subagent` and `invocation: manual`, so it installs to
`.reasonix/skills/<name>/SKILL.md`. Subagents and skills therefore share one
namespace there — don't give a subagent the same name as a skill in the same
bundle, and `hcm validate` will tell you if you have. Two further Reasonix-only
frontmatter keys are passed through when present: `effort` and `readOnly`
(rendered as `read-only`, which strips writer tools).

OpenCode files subagents at `.opencode/agents/<name>.md` with `mode: subagent`,
and passes `model`, `temperature` and `color` through. It does *not* take a tool
allowlist: access there is a `permission` object keyed by OpenCode's own
categories (`edit`, `bash`, `read`, …), which a list of tool names cannot be
translated into, so `tools` is dropped for that target.

Pi has no agents directory either, and no delegation at all — that is extension
territory there. A subagent installs as a skill, `.pi/skills/<name>/SKILL.md`,
invoked as `/skill:<name>`. Pi follows the Agent Skills standard, whose
frontmatter is just `name` and `description`, so `tools` and `model` have
nowhere to go and are dropped; and without delegation the prompt runs in the
main context rather than its own. As on Reasonix, subagents and skills share one
namespace — `hcm validate` flags a name used by both.

Users who have installed [`pi-subagents`](https://github.com/nicobailon/pi-subagents)
get the better mapping by passing `hcm install --pi-subagents`: the subagent is
written to `.pi/agents/<name>.md`, which is the directory that extension scans,
and `tools` and `model` survive because it has fields for them. Nothing in the
bundle changes — this is a fact about the user's machine, not about your kit —
so write `tools` and `model` as you would for any other target and let the
people who have the extension benefit from them.

One thing to know if you ship a `tools` allowlist: `hcm` translates the *shape*
of frontmatter between harnesses, never the tool names themselves, and the
names differ. `pi-subagents` documents `tools` as a **strict** allowlist over
its own vocabulary (`read, grep, bash`, plus `mcp:<server>` entries), so a list
written as Claude Code's `[Read, Grep]` will not match anything there. Either
leave `tools` off — the extension's default is unrestricted — or accept that the
allowlist is meaningful on one harness at a time.

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

Becomes a slash command in Claude Code, Reasonix and OpenCode, a `.prompt.md`
file for Copilot, and a prompt template in `.pi/prompts/` for Pi. `argumentHint`
survives everywhere that has a field for it; OpenCode has none, so it is dropped
there.

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
`applyTo: '**/*.ts, **/*.tsx'` for Copilot. Omit it and the rule loads at session
start everywhere (Copilot gets `applyTo: '**'`).

Reasonix and Pi are the exceptions: their standing instructions are the
`REASONIX.md` / `AGENTS.md` hierarchy, scoped by directory rather than by glob,
so a rule is appended to that file as a marker block with its globs stated in
prose:

```markdown
<!-- hcm:begin my-kit/rules/typescript -->
**Applies to:** `**/*.ts`, `**/*.tsx`

- Prefer named exports.
<!-- hcm:end my-kit/rules/typescript -->
```

That means a Reasonix or Pi rule costs context in every session, the way
`context/` does. Keep rules short, or prefer `context/` when the instruction is
universal anyway.

OpenCode sits between the two. It has no glob-scoped rule format either, but it
does load extra instruction files named in `instructions`, so the rule keeps its
own file — `.opencode/rules/<name>.md`, with the same prose header — and one
entry is *appended* to that array in `opencode.json`. Appending rather than
replacing is what lets several bundles list rules in the same config and each
take back only its own on uninstall. The file is still loaded in full every
session, so the same brevity advice applies.

### Context — `context/<name>.md`

Always-loaded instructions. These are merged into the harness's top-level
instruction file (`CLAUDE.md`, `.github/copilot-instructions.md`, `REASONIX.md`,
or `AGENTS.md` for OpenCode and Pi) inside a marker block:

```markdown
<!-- hcm:begin my-kit/10-conventions -->
## Review conventions
...
<!-- hcm:end my-kit/10-conventions -->
```

Start the body at heading level 2 — it is being pasted into someone else's
document. Keep it short; this text costs context in every single session.

**One section per file.** Every file in `context/` becomes its own block, and
the blocks are concatenated in filename order — so number them when the order
matters:

```
context/
├── 10-conventions.md
├── 20-pull-requests.md
└── 30-glossary.md
```

Splitting is not cosmetic. This is the one file the harness's own agent writes
back to, and when it rewrites `CLAUDE.md` your instructions can go with it.
`hcm` keeps a copy of each section under the project's `.hcm/context/` and
restores them a section at a time:

```bash
hcm context            # is everything still in place?
hcm context append     # put back what is missing, leaving the rest alone
```

Small sections survive that far better than one long one: a rewrite that keeps
half your text leaves `append` able to tell what is missing from what is not.
See [Context in the README](../README.md#context-sections-that-survive-being-overwritten)
for `override` and `remove`.

The block id is `<bundle>/<section>`, so renaming a context file after people
have installed the bundle orphans the old block until they run `hcm update`.

### MCP servers — `mcp/<name>.json`

One file per server. The filename is the server name.

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
}
```

Recognised keys: `command`, `args`, `env`, `type`, `url`, `headers`,
`startupTimeoutSeconds`, `callTimeoutSeconds`, `toolTimeoutSeconds`. Timeout keys
may also be written in the snake_case form the Reasonix spec uses
(`startup_timeout_seconds`).

A remote server needs a `url`; the transport is inferred as `http` when you do
not state a `type`, so this is enough:

```json
{
  "url": "https://mcp.stripe.com",
  "headers": { "Authorization": "Bearer ${STRIPE_KEY}" }
}
```

Each target gets the form it expects:

| Canonical | Claude Code `.mcp.json` | Copilot `.vscode/mcp.json` | Reasonix `reasonix.toml` | OpenCode `opencode.json` |
| --- | --- | --- | --- | --- |
| `command`, `args` | as written | as written | as written | merged into one `command` argv array |
| `env` | as written | as written | as written | `environment` |
| `url`, `headers` | as written | as written | as written | as written |
| *(transport)* | inferred by the harness | `type` added (`stdio`/`http`) | `type` added unless stdio, which is the documented default | `type` added (`local`/`remote`) |
| `startupTimeoutSeconds` | as written | as written | `startup_timeout_seconds` | — |
| `callTimeoutSeconds` | as written | as written | `call_timeout_seconds` | — |
| `toolTimeoutSeconds` | as written | as written | `tool_timeout_seconds` | — |

OpenCode names its transports `local` and `remote` rather than `stdio` and
`http`, and takes the command as a single argv array, so
`{"command": "npx", "args": ["-y", "server"]}` is written out as
`{"type": "local", "command": ["npx", "-y", "server"]}`. Its own `cwd`,
`enabled` and `timeout` keys pass through when you set them.

Pi has no built-in MCP client of its own — servers there come from extensions —
but those extensions read the same `.mcp.json`, in the same `mcpServers` shape,
that Claude Code uses. So the definition is written there unchanged and sits
inert until you install one. At user scope it lands in Pi's own config
directory, `~/.pi/agent/.mcp.json`, alongside its other resources.

`hcm targets` prints the kinds each harness accepts; today that is all eight
everywhere, so a bundle installs in full wherever you send it.

That does mean Claude Code and Pi share `.mcp.json` at project scope, which needs
no special handling: whichever target you install second finds the server
already there and identical, adopts it rather than claiming it, and leaves it
alone on uninstall. Installing a bundle into both targets and removing it from
one keeps the other working.

`${VAR}` references are passed through untouched — every one of these harnesses
expands them itself, so keep secrets in the environment rather than the bundle.

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
*set*; one already present with a different value is a conflict the user is
asked about, key by key.

Keep fragments minimal. Every key you set is a key the user cannot change
without `hcm status` reporting drift.

### Assets — `assets/**`

Copied verbatim into the harness directory. Use for scripts, templates and images
that your subagents or skills reference.

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
│   └── subagents/code-reviewer.md
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

Reinstalling a `--dev` bundle over itself is fine: items you installed and
nobody has touched are replaced without `--force`, and an item somebody
hand-edited stops to ask rather than being overwritten. To check what your users
will get when you ship a change, use `hcm update my-kit --dry-run` — that shows
the removals as well as the writes, which is where a renamed or deleted resource
shows up.

Worth testing deliberately: overwrite `CLAUDE.md` with something else entirely,
then run `hcm context list` and `hcm context append`. That is the state a user's
project reaches on its own, and it will tell you whether your sections are
divided the way you think they are.

Also worth testing: install into a directory that already has a
`.mcp.json` containing one of your servers. If the definitions match, the
install reports the server as adopted and leaves the file untouched; if they
differ, you are asked what to do. Seeing both tells you how your bundle lands in
a project that is not empty.

If your bundle has dependencies, install it into an empty directory and then
uninstall it: everything it pulled in should go too, and the directory should be
as it started. Then install the dependency by name first and repeat — this time
it should stay, because you asked for it yourself.

## Conventions that avoid conflicts

Bundles collide when two of them want the same item and want it to say something
*different*. Wanting the same item identically is not a collision: hcm writes it
once, records a claim for each bundle, and removes it when the last of them is
uninstalled. So two kits can both ship `skills/jira-board/` — as long as the
files really are identical, which in practice means one of them depends on the
other and copies it, or both are generated from the same place.

Cheap habits that prevent the collisions that remain:

- **Namespace MCP server filenames** when wrapping a common service:
  `mcp/acme-postgres.json`, not `mcp/postgres.json`.
- **Prefix subagent and command names** with something recognisable if the bundle
  is for a specific team or product.
- **Prefer `context/` over `settings/`** for anything advisory. Instruction text
  merges additively; settings keys are exclusive.
- **Keep one concern per bundle.** Users install and uninstall at bundle
  granularity, so a bundle bundling unrelated things forces all-or-nothing.
  Where two kits share a concern, a `dependencies:` entry beats a copy — the
  shared part is then installed once, kept up to date in one place, and removed
  when the last kit that needed it goes.
- **Refer to your MCP servers by name, plainly.** When a user hits a name clash
  they can install your server under a different name, and `hcm` rewrites the
  mentions in the rest of your bundle to match. That works on `mcp__<name>__tool`
  prefixes and on the bare name; it cannot follow a name you assembled at
  runtime or split across a line break.

A conflict is never resolved silently: `hcm install` asks, naming the owning
bundle where there is one, and writes nothing until you answer.
