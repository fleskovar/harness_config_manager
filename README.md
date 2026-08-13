# harness-config-manager (`hcm`)

Define your subagents, skills, commands, rules and MCP servers **once**, then install
them into whichever agent harness you happen to be using — and remove them again
cleanly, even when several bundles share the same config file.

Supported targets:

| Target | Docs |
| --- | --- |
| Claude Code | <https://code.claude.com/docs/en/claude-directory> |
| GitHub Copilot | <https://awesome-copilot.github.com/learning-hub/copilot-configuration-basics/> |
| Reasonix | <https://github.com/esengine/DeepSeek-Reasonix/blob/main-v2/docs/GUIDE.md> |
| OpenCode | <https://opencode.ai/docs/config/> |
| Pi | <https://pi.dev/docs/latest/quickstart> |

## Install

```bash
make setup        # install dependencies, build, run the checks
make link         # puts `hcm` on your PATH
```

Or without make: `npm ci && npm run build && npm link`.

## Quick start

```bash
hcm init my-kit                  # scaffold a bundle
hcm registry add ./my-kit        # make it installable by name or id
hcm list                         # what can I install?
hcm info my-kit                  # where would everything land?
hcm install my-kit --dry-run     # check before writing
hcm install my-kit               # install into every supported target
hcm list --installed             # what is installed here?
hcm status                       # is it all still intact?
hcm update my-kit                # re-read the source, reinstall in place
hcm context append               # put back context an agent overwrote
hcm uninstall my-kit             # remove exactly what was installed
```

Every registered bundle also gets a one-character id, so the above is usually
`hcm install 1`, `hcm update 1`. If you are *writing* the bundle, register it
with `hcm registry add ./my-kit --dev` and your edits apply straight away.

## Bundle layout

A bundle is a directory with a manifest and conventionally-named subdirectories.
There is no resource list to maintain — the layout *is* the schema.

```
my-kit/
├── hcm.yaml                        # name, version, description, tags, targets
├── subagents/code-reviewer.md      # delegated worker with its own prompt
├── skills/dependency-audit/        # SKILL.md plus supporting files
│   ├── SKILL.md
│   └── checklist.md
├── commands/review-pr.md           # slash command / prompt
├── rules/typescript.md             # path-scoped instructions
├── context/10-conventions.md       # always-loaded instructions, one section per file
├── context/20-pull-requests.md     #   concatenated in filename order
├── mcp/filesystem.json             # one file per MCP server
├── settings/settings.json          # settings fragment, deep-merged
└── assets/                         # copied verbatim
```

`hcm.yaml`:

```yaml
name: my-kit
version: 1.0.0
description: What this bundle is for
tags: [review, typescript]
# Omit "targets" to support all of them.
targets: [claude-code, copilot, reasonix, opencode, pi]
# Bundles this one needs; installed first. See "Dependencies" below.
dependencies:
  - jira-board@^1.2.0
```

## Where things land

`hcm` writes one canonical resource into each harness's own convention, rewriting
frontmatter to match. Project scope is the current directory; user scope is the
harness's home directory (`hcm targets` prints the exact paths on your machine).

| Kind | Claude Code | GitHub Copilot | Reasonix |
| --- | --- | --- | --- |
| subagent | `.claude/agents/<n>.md` | `.github/agents/<n>.agent.md` | `.reasonix/skills/<n>/SKILL.md` |
| skill | `.claude/skills/<n>/` | `.github/skills/<n>/` | `.reasonix/skills/<n>/` |
| command | `.claude/commands/<n>.md` | `.github/prompts/<n>.prompt.md` | `.reasonix/commands/<n>.md` |
| rule | `.claude/rules/<n>.md` | `.github/instructions/<n>.instructions.md` | `REASONIX.md` |
| context | `CLAUDE.md` | `.github/copilot-instructions.md` | `REASONIX.md` |
| mcp | `.mcp.json` → `mcpServers.<n>` | `.vscode/mcp.json` → `servers.<n>` | `reasonix.toml` → `[[plugins]]` |
| settings | `.claude/settings.json` | `.github/copilot/settings.json` | `reasonix.toml` |

| Kind | OpenCode | Pi |
| --- | --- | --- |
| subagent | `.opencode/agents/<n>.md` | `.pi/skills/<n>/SKILL.md`, or `.pi/agents/<n>.md` with `--pi-subagents` |
| skill | `.opencode/skills/<n>/` | `.pi/skills/<n>/` |
| command | `.opencode/commands/<n>.md` | `.pi/prompts/<n>.md` |
| rule | `.opencode/rules/<n>.md` + `opencode.json` → `instructions[]` | `AGENTS.md` |
| context | `AGENTS.md` | `AGENTS.md` |
| mcp | `opencode.json` → `mcp.<n>` | `.mcp.json` → `mcpServers.<n>` |
| settings | `opencode.json` | `.pi/settings.json` |

Frontmatter is translated per target. A rule written once as:

```yaml
appliesTo: ["**/*.ts", "**/*.tsx"]
```

becomes `paths: [...]` for Claude Code, `applyTo: '**/*.ts, **/*.tsx'` for
Copilot, and — since Reasonix, OpenCode and Pi have no glob-scoped rule format —
a line of prose above the rule text. Subagent `tools` become a comma-separated
string for Claude Code, a YAML list for Copilot, and `allowed-tools` for
Reasonix.

Note the deliberate asymmetry: bundles say **subagent**, but each harness keeps
its own word — and its own filing system — for the same thing. Claude Code,
Copilot and OpenCode each have an `agents/` directory; Reasonix and Pi have
none, because there a subagent *is* a skill — on Reasonix marked `runAs:
subagent` and `invocation: manual` so it is only invoked by name, on Pi invoked
as `/skill:<name>`. `hcm` translates; you only learn one vocabulary.

One consequence: on Reasonix and Pi a subagent and a skill share one namespace.
Give them distinct names — `hcm validate` flags a bundle that does not.

### What each target does with the edges

Every target has a home for every kind, but the fit is not always exact:

- **OpenCode gates subagent tools through a `permission` object** keyed by its
  own categories (`edit`, `bash`, `read`, …) rather than a list of tool names,
  so a canonical `tools:` allowlist has no faithful translation and is dropped
  from the written agent file. Set it in OpenCode's own config if you need it.
- **Pi has neither sub-agents nor a built-in MCP client** — both are extension
  territory there — but both kinds still install, on the conventions those
  extensions build on. A subagent becomes a skill (Agent Skills frontmatter is
  just `name` and `description`, so `tools` and `model` are dropped, and with no
  delegation the prompt runs in the main context rather than its own). MCP
  servers go to the same `.mcp.json`, in the same `mcpServers` shape, that
  Claude Code uses — inert until an MCP extension is installed, correct once it
  is. If you *have* installed the sub-agent extension, say so — see
  [`--pi-subagents`](#pi-subagents) below.
- **OpenCode has no glob-scoped rule format**, but it does read extra
  instruction files listed in `instructions`. So a rule becomes a file *and* one
  entry appended to that array — appended, never replaced, so several bundles
  can each list their own rules in the same config and each remove only its own
  on uninstall.

Finally, two files are genuinely shared between harnesses rather than owned by
one: **`.mcp.json`** (Claude Code and Pi) and **`AGENTS.md`** (OpenCode and Pi).
Installing one bundle into both harnesses writes the shared item once, and both
installations claim it — so uninstalling from either leaves the other working,
and the item goes when the second one does. See
[Shared items](#shared-items-written-once-claimed-by-everyone-who-needs-them).

Everything outside those two files is per-target and unaffected.

### pi-subagents

Pi's sub-agent support is an extension,
[`pi-subagents`](https://github.com/nicobailon/pi-subagents), and it scans a
directory stock Pi knows nothing about. `hcm` cannot tell whether you have
installed it, so tell it:

```bash
hcm install my-kit -t pi --pi-subagents
```

| | Without | With `--pi-subagents` |
| --- | --- | --- |
| project | `.pi/skills/<n>/SKILL.md` | `.pi/agents/<n>.md` |
| user | `~/.pi/agent/skills/<n>/SKILL.md` | `~/.pi/agent/agents/<n>.md` |
| frontmatter | `name`, `description` | `name`, `description`, `tools`, `model` |
| invoked as | `/skill:<n>`, in the main context | `subagent({ agent: "<n>" })`, in a child session |

The extension has fields for `tools` and `model`, so a subagent that would have
had them dropped keeps them. It also ends the shared namespace: a subagent and a
skill of the same name are two files in two directories rather than one
collision, though `hcm validate` still flags the pair because Reasonix keeps it.

`tools` is passed through as written. `hcm` translates the shape of frontmatter,
never the tool names inside it — and `pi-subagents` treats the list as a strict
allowlist over its own vocabulary (`read`, `grep`, `bash`, `mcp:<server>`), so a
list written for Claude Code will not match there. See
[authoring bundles](docs/authoring-bundles.md#subagents--subagentsnamemd).

**The flag is recorded with the installation**, so `hcm update` reinstalls into
the same place without being told again — say it once. Passing it to `hcm update`
overrides what was recorded, which is how you migrate an existing install after
adding the extension:

```bash
hcm update my-kit --pi-subagents    # moves the subagent, removing the old skill
```

`hcm install` accepts it too, but a plain install does not clean up: it writes
the new location and leaves the old file behind, so it warns and points you at
`hcm update`. The flag also works on `hcm info` (to preview the layout) and on
`hcm import --install`.

## Dependencies: bundles that build on other bundles

One bundle explaining how your team's JIRA board works is worth writing once and
requiring from the half-dozen bundles that assume it. A manifest says so:

```yaml
name: sprint-kit
version: 1.0.0
dependencies:
  - jira-board@^1.2.0                # a name and a range
  - team-conventions                 # any version will do
  - name: db-kit                     # ...or the long form, with a source
    version: ">=2.1 <3"
    source: acme/agent-kits/db-kit
```

Installing `sprint-kit` installs `jira-board` first:

```
Resolved 1 required bundle(s):
  sprint-kit v1.0.0
  └─ jira-board v1.4.2  (registered)

jira-board v1.4.2 (…/jira-board) (required by sprint-kit)
  + .claude/skills/jira-board/SKILL.md
  + .claude/agents/triager.md

sprint-kit v1.0.0 (…/sprint-kit)
  = .claude/skills/jira-board/SKILL.md  (already installed by another bundle -- shared, not copied again)
  + .claude/agents/planner.md
```

**Where a dependency is looked for**, in order: bundles already in this run, the
registry, a sibling folder in the same collection, and the `source` the
dependency itself names. So a monorepo of bundles resolves with nothing
registered and no network, and a published bundle can point at where its
dependency lives. `hcm validate` tries the same lookup and tells you when it
fails — which is the moment to add a `source`, since what resolves on your
machine because you registered it resolves nowhere else.

**Versions** are the usual subset: `1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2.3`,
`1.2.x`, `*`, joined with a space for *and* and `||` for *or*. One version of a
bundle exists per scope — there is only one `.claude/agents/` — so two
dependents that cannot agree is an error naming both, not a silent choice:

```
✖ "jira-board" v1.4.2 does not satisfy ^2.0.0 (required by report-kit)
Only one version of a bundle can be installed in a scope, and sprint-kit
wants ^1.0.0, report-kit wants ^2.0.0.
```

Cycles are refused, naming the loop. A dependency goes only into the harnesses
the bundles needing it went into, whatever else it happens to support.

**Coming back out.** A bundle pulled in as a dependency is marked as such
(`[dependency]` in `hcm list --installed`) and leaves when the last bundle
needing it does:

```bash
hcm uninstall sprint-kit          # takes jira-board too, if nothing else needs it
hcm uninstall sprint-kit --keep-orphans
hcm uninstall jira-board          # refused: sprint-kit still requires it
hcm uninstall jira-board --cascade            # …remove sprint-kit as well
hcm uninstall jira-board --ignore-dependents  # …or leave it installed without it
```

Installing a dependency by name makes it yours: it is no longer automatic, and
survives whatever pulled it in. `hcm install --no-deps` skips resolution
entirely, and says what it skipped.

`hcm update` installs dependencies a new version has gained, and leaves ones
that are already there alone — updating one bundle should not quietly update
another. Use `hcm update all` for that.

## Shared items: written once, claimed by everyone who needs them

Two bundles will often want the very same thing: a dependency's skill that its
dependents also ship, an MCP server two kits both wrap, a permission both ask
for. That is not a collision.

**An item hcm has already installed, identical to what this bundle would write,
is *shared*.** Nothing is written a second time — no second copy, not even a
rewritten file — and the new installation claims it alongside the existing one.
Uninstalling reports the item as `held` and leaves it:

```
  removed  .claude/agents/planner.md
  held     .claude/skills/jira-board/SKILL.md (still required by jira-board)
```

The last claim to go takes the item with it. There is no counter to drift out of
step: the claims *are* the install ledger, so what is holding an item is worked
out from the same records `hcm list --installed` prints.

This works item by item, so two bundles asking for one permission each plus one
in common end up with three entries in the allow-list, and removing either
leaves the other's two. It works across harnesses, since the claim is keyed by
where the item actually is — which is what makes `.mcp.json` and `AGENTS.md`
safe to share between Claude Code, OpenCode and Pi. And it works only for hcm's
own claims: an entry *you* wrote is claimed by nobody, so it is adopted and
outlives every bundle that happened to want it.

Three outcomes, then, when something is already there:

| What is there | Outcome | On uninstall |
| --- | --- | --- |
| Nothing | written | removed |
| The same item, claimed by another bundle | **shared** — not written again | `held` until the last claimant goes |
| The same item, claimed by nobody | **adopted** — not written, not owned | `kept`, always |
| A different item | a conflict — you are asked | — |

## Context: sections that survive being overwritten

`CLAUDE.md`, `AGENTS.md` and `REASONIX.md` are the one place hcm writes that the
harness's own agent also writes. Ask it to record what it has learned about the
project and it may rewrite the file from scratch — taking the marker blocks, and
the instructions inside them, with it.

A receipt cannot help here: it records *where* a section was, not what it said.
So every install also drops a copy of each context section under `.hcm`:

```
.hcm/
├── state.json                          # the install ledger
├── context.json                        # each section, its order, and where it goes
└── context/
    └── ts-review-kit/
        ├── 10-conventions.md
        └── 20-pull-requests.md
```

Split `context/` into several short files and each becomes its own section —
its own marker block, restorable on its own. Filename order is section order,
which is what the numeric prefixes are for.

```bash
hcm context                     # what is tracked, and is it still in place?
hcm context append              # put back whatever has gone missing
hcm context override            # clear the file, rewrite it from the sections
hcm context remove              # take the sections out again
```

Every subcommand takes bundle names or ids — `hcm context append 1 my-kit` — and
acts on all of them when you name none. `-t` narrows to one harness, `-s` to a
scope, and `--dry-run` shows the change without making it.

**`append` is the everyday one.** It looks at each tracked section and writes
back only what is absent, leaving the rest of the file — including anything the
agent wrote — exactly where it is. Two things it deliberately does not touch:

- A section still inside its markers is left alone even if the text has been
  edited, on the same principle as everywhere else in `hcm`. `--force` writes
  every section from the cache instead, which is how you undo such an edit.
- A section whose text survived the rewrite *without* its markers is reported as
  `unmarked` and not appended, because appending would say the same thing twice.
  `hcm context list` shows these; re-wrapping one means deleting the loose copy
  and running `append` again.

**`override` is the reset.** It discards everything hcm did not write and lays
the sections down in order. Blocks belonging to other bundles — or to rules,
which share `AGENTS.md` on Pi and `REASONIX.md` on Reasonix — are kept and moved
below, since they have receipts of their own. Because it does destroy
hand-written text, it says how many lines that is and asks first; `--force`
answers yes, and with no terminal it refuses rather than guessing.

**`remove` takes the sections out** and keeps the cached copies, so `append` can
put them back. Uninstalling the bundle is what forgets them for good.

Throughout, the install receipts are kept in step: after `hcm context remove`,
`hcm status` does not report the blocks as damage, and after `append` it counts
them as present again.

## References: written once, repointed on the way in

A bundle's files talk about each other. A `SKILL.md` says to work through
`checklist.md`; a command points at the skill; an MCP server's args name a
script under `assets/`. Installation takes that layout apart and files each
piece under a different harness's conventions — so a path written against the
bundle is wrong in every target, and wrong differently in each.

So write references **against the bundle's own layout**, from its root:

```markdown
Follow the checklist at `skills/dependency-audit/checklist.md`.
See [the reviewer](subagents/code-reviewer.md) for the tone to use.
```

and `hcm` rewrites them as it installs, to wherever those files actually went:

| Written in the bundle | Claude Code | Reasonix |
| --- | --- | --- |
| `subagents/code-reviewer.md` | `.claude/agents/code-reviewer.md` | `.reasonix/skills/code-reviewer/SKILL.md` |
| `skills/audit/checklist.md` | `.claude/skills/audit/checklist.md` | `.reasonix/skills/audit/checklist.md` |
| `context/conventions.md` | `CLAUDE.md` | `REASONIX.md` |
| `assets/run.sh` | `.claude/assets/run.sh` | `.reasonix/assets/run.sh` |

What comes out is always **relative to the file doing the referring**:

```
.claude/skills/audit/SKILL.md  →  checklist.md              (same directory)
.claude/commands/review.md     →  ../skills/audit/checklist.md
.claude/skills/audit/SKILL.md  →  ../../agents/code-reviewer.md
CLAUDE.md                      →  .claude/skills/audit/checklist.md
```

One rule, not two. A reference means the same thing to whoever reads the file it
is written in, wherever that file ended up — the last line only looks like a
rooted path because a context section lands at the scope root and has nothing to
climb out of. It is why the same reference reads identically at project and user
scope, even though the layouts differ: from `prompts/review.md` to
`skills/audit/checklist.md` is `../skills/audit/checklist.md` either way.

Both readings are accepted going in, bundle root first, so `checklist.md` next
to a `SKILL.md` keeps working and nothing written before this needs changing.
Markdown links, images, link definitions, inline code and `@paths` are all
rewritten, in resource files *and* in context blocks, and so are whole string
values in MCP and settings fragments — `"args": ["assets/run.sh"]` is repointed,
while `"args": ["-c", "echo hi"]` is left alone.

Nothing is guessed. A reference is rewritten only when it names a file the
bundle ships *and* this target installs. One naming a file the target drops is
left exactly as written and reported as a warning; one pointing outside the
bundle — a URL, a path in the user's project — is never touched. `hcm info`
prints the rewrites per target before you install anything, and `hcm install
--verbose` prints them as it goes.

> **One thing to watch in config values.** The rule holds wherever a path is
> resolved against the file containing it, which is how the harnesses read the
> markdown they load. A path inside a *config value* — an MCP server's `args`,
> a hook command in `settings.json` — is resolved by the harness, usually
> against the project root rather than against the config file. Where the config
> sits at the scope root (`.mcp.json`, `opencode.json`, `reasonix.toml`) the two
> agree and there is nothing to think about. Where it does not, they diverge:
> Copilot's `.vscode/mcp.json` gets `../.github/assets/run.sh`, which is the
> correct path *from that file* and not what a client launched in the project
> root will open. Keep executable paths out of bundle-relative references, or
> check `hcm info` before shipping.

### Finding the ones that point at nothing

```bash
hcm refs check --path ./bundles          # report broken references
hcm refs fix   --path ./bundles          # repair them, by picking from a list
```

`check` reads every markdown file and config under the path — one bundle or a
whole collection — resolves each reference both ways, and reports what resolves
neither way, with the files it probably meant:

```
ts-review-kit/README.md
  ✖ line 11  context/conventions.md (code)
      → context/10-conventions.md
```

`fix` puts the same thing in a JSON file, one entry per broken reference, each
with the candidates ranked best first:

```json
{
  "ts-review-kit/README.md": {
    "original_ref": "context/conventions.md",
    "new": ["context/10-conventions.md", "context/20-pull-requests.md"]
  }
}
```

Delete the wrong ones. **Leave exactly one entry in each `new` list**, save, and
close the editor — every entry down to one choice is applied, and every entry
still holding two or more is reported and left alone, so an unfinished pass
cannot write something nobody picked. Entries are keyed by the file the
reference is in; a file that broke several gets `#2`, `#3` suffixes, and
`original_ref` is what actually identifies the reference.

`$VISUAL` or `$EDITOR` decides the editor; GUI editors known to fork get
`--wait` added, or the round trip would apply the file before you touched it.
Two flags split it up when that is not what you want:

```bash
hcm refs fix --path ./bundles --write              # save hcm-refs.json here, stop
hcm refs fix --path ./bundles --write fixes.json   # ...under a name of your choosing
hcm refs fix --path ./bundles --file fixes.json    # apply one you edited earlier
hcm refs fix --path ./bundles --file fixes.json --dry-run
```

Suggestions come from the files under the scanned path — the same bundle first,
then sibling bundles and dependencies in the same folder. A suggestion from
another bundle is marked, and never outranks one from the bundle doing the
referring: it may not be installed alongside it, and it cannot be remapped if it
is not.

### What it will not report

A bundle's prose is full of filenames it is not referring to. Reporting
`package.json` as a broken reference in a skill that merely says to read one
would make the report worthless, so:

- **Fenced code blocks are skipped** — they are examples and shell sessions.
- **URLs, anchors, absolute paths, `~/…` and `${VAR}` paths** are somebody
  else's to resolve.
- **Paths rooted at a hidden directory** — `.claude/agents/x.md`,
  `.vscode/mcp.json` — describe where something lands *after* installation.
  Bundles ship no hidden directories, so these are documentation, not references.
- **Well-known project filenames** (`package.json`, `tsconfig.json`, `go.mod`,
  lockfiles…) mentioned without a path.
- **A bare filename with nothing similar in the tree** — `checklist.md` with no
  candidate anywhere is prose, and there would be no fix to offer if it were
  not. `--strict` reports these too.

Anything written as a reference — a link, an image, a link definition — or
containing a `/` is always reported. Nobody writes `skills/audit/checklist.md`
as a turn of phrase.

## How rollback stays exact

The hard part is that bundles share files. Two bundles both write into
`.mcp.json`; a third appends to `settings.json`; you hand-edit `CLAUDE.md`. A
line-based or diff-based record would break the moment anything is reordered or
reformatted.

So `hcm` never records line numbers. Every write leaves a **receipt** expressed in
terms the file format itself understands:

- **JSON** — a structural path plus a SHA-256 of the value written, e.g.
  `mcpServers.filesystem = <hash>`. On uninstall the pointer is resolved in the
  file *as it is now*; the item is removed only if it still hashes to what we
  wrote. Hashes are computed over canonicalised JSON with sorted keys, so
  reformatting and key reordering are invisible.
- **JSON arrays** (permission allow-lists) — each appended item is recorded by
  its own hash and removed by value, so position never matters and items other
  bundles contributed are left alone.
- **Markdown and TOML** — a comment-delimited marker block, so removal is an
  exact excision no matter what moved around it:

  ```markdown
  <!-- hcm:begin my-kit/conventions -->
  ...
  <!-- hcm:end my-kit/conventions -->
  ```

  TOML uses `# hcm:begin ...`. Because TOML files carry comments people care
  about, `hcm` never parses-and-restringifies them — it only appends and excises
  marked blocks, leaving the rest of the file byte-for-byte intact.

Consequences worth knowing:

- **Files you already had are never deleted.** A pre-existing `CLAUDE.md` keeps
  its content; only the marked block goes. A file that ends up empty is removed.
- **Hand edits are respected.** If an item no longer matches its receipt,
  uninstall reports it as `modified` and leaves it in place. The installation
  record is kept so you can retry with `--force`.
- **Overwrites are reversible.** When installing replaces an existing value, the
  old value is stored in the receipt and restored on uninstall.
- **Items you already had are adopted, not claimed.** If a server, file or key
  is already exactly what the bundle would write, `hcm` records that the bundle
  uses it but does not take ownership — uninstall leaves it exactly where it is.
- **Items another bundle installed are shared, not duplicated.** The same item
  wanted by two bundles is written once and claimed by both; the last uninstall
  is the one that removes it. See
  [Shared items](#shared-items-written-once-claimed-by-everyone-who-needs-them).
- **Everything else is asked about before writing.** See below.

## When something is already there

Installing into a real project usually means landing next to configuration
somebody else — you, a teammate, another tool — already wrote. `hcm` decides
what to do *before* it writes anything, and the answer depends on what it finds.

**Already identical → adopted.** An MCP server in `.mcp.json` whose definition
matches the bundle's byte for byte is left untouched: the file is not rewritten,
not even reformatted, and the receipt records that the item was there first.
`hcm status` counts it as adopted, `hcm uninstall` reports it as `kept` and
leaves it behind, and a second bundle can adopt the same item without colliding.

**Already installed by another bundle, identically → shared.** Same
write-nothing outcome, different bookkeeping: this bundle claims the item too,
and it survives until the last claimant is uninstalled. See
[Shared items](#shared-items-written-once-claimed-by-everyone-who-needs-them).

**Different → your call, one question per resource.** With a terminal attached,
`hcm` asks. A skill is a dozen files but one question, because you mean one
thing by all of them:

```
! mcp "light-plan" conflicts with what is already installed:
    .mcp.json  mcpServers.light-plan already set to a different value
  How should hcm handle mcp "light-plan"?
  *1) skip     -- keep the existing one, install nothing
   2) replace  -- overwrite it with the bundle version
   3) rename   -- install under another name and update this bundle's instructions
   4) abort    -- stop; write nothing at all
```

- **skip** — the existing item stays and the rest of the bundle installs as
  normal. For a settings fragment only the colliding keys are dropped, since its
  keys are independent; for everything else the whole resource is, because half
  a skill on disk is worse than none.
- **replace / overwrite** — the bundle's version wins. The old value is kept in
  the receipt and restored when you uninstall.
- **rename** — offered for MCP servers, which are addressed by name. The server
  installs under the name you give, *and* every mention of the old name in the
  rest of the bundle — `mcp__old__tool` prefixes and the bare name in skills,
  subagents, commands and context — is rewritten to match, so the instructions
  still point at a server that exists. The number of rewritten mentions is
  reported; the substitution is textual, so check that count if the old name is
  also an ordinary word. Names glued to other name characters (`light-plan` in
  `light-plan-legacy`) are left alone, and the server's own `command` is never
  rewritten. A rename decided for one harness is applied to the others in the
  same run, so the server has one name everywhere.
- **abort** — stops the whole run with nothing written.

Answers are remembered per bundle for the length of the run: a bundle installed
into three harnesses asks each question once.

**No terminal?** Then there is nobody to ask, and `hcm` fails with the conflicts
listed rather than guessing — the behaviour scripts and CI already relied on.
Decide up front instead:

```bash
hcm install my-kit --on-conflict skip       # keep whatever is already there
hcm install my-kit --on-conflict overwrite  # same as --force
hcm install my-kit --on-conflict abort      # the default: fail and list them
hcm install my-kit --on-conflict prompt     # ask even where hcm would not have
```

## Commands

| Command | What it does |
| --- | --- |
| `hcm install <bundle>` | Install, with whatever it requires. `-t/--target`, `-s/--scope`, `--dry-run`, `--force`, `--on-conflict`, `--refresh`, `--no-deps`, `--pi-subagents` |
| `hcm update <bundle>\|all` | Re-read a registered bundle and reinstall it. `-t`, `-s`, `--dry-run`, `--force`, `--on-conflict`, `--pi-subagents` |
| `hcm uninstall <bundle>` | Remove exactly what was installed. `-t`, `-s`, `--dry-run`, `--force`, `--cascade`, `--ignore-dependents`, `--keep-orphans` |
| `hcm list` | Registered bundles (`●` = installed somewhere) |
| `hcm list --installed` | Installed bundles. `--scope project\|user\|all`, `--json` |
| `hcm info <bundle>` | Contents, plus where every item would land in each target. `--pi-subagents` |
| `hcm status` | Verify installed items are still present and unmodified |
| `hcm context [list]` | Tracked context sections, and whether each is still in its file. `--json` |
| `hcm context append [bundle...]` | Add back the sections that have gone missing. `-t`, `-s`, `--dry-run`, `--force` |
| `hcm context override [bundle...]` | Clear the file and rewrite it from the cached sections. `-t`, `-s`, `--dry-run`, `--force` |
| `hcm context remove [bundle...]` | Take the sections out, keeping the cached copies. `-t`, `-s`, `--dry-run` |
| `hcm refs check` | Report file references that point at nothing. `-p/--path`, `--strict`, `--json` |
| `hcm refs fix` | Repair them by picking from a ranked list. `-p/--path`, `--write [file]`, `--file <path>`, `--strict`, `--dry-run` |
| `hcm validate [dir]` | Check a bundle for common mistakes |
| `hcm init [dir]` | Scaffold a new bundle |
| `hcm targets` | Supported harnesses and their paths on this machine |
| `hcm registry add <source>` | Register a bundle by path, `owner/repo`, or GitHub URL. `--dev`, `-n/--name` |
| `hcm registry remove <bundle...>` | Unregister and delete the stored copy |
| `hcm registry open [bundle]` | Print — and open — where registered bundles are stored |
| `hcm registry list` | List registered bundles with their ids |
| `hcm export [file]` | Write installed (or `--registry`) bundles to `bundles.txt` |
| `hcm import [file]` | Register everything a bundles file lists; `--install` to install too, `--on-conflict` |
| `hcm config` | Show settings; `config set\|get\|unset` to change them |

`<bundle>` accepts a registered **name or id**, a local path, or a GitHub
reference — so `hcm install 3`, `hcm install ./my-kit` and
`hcm install acme/kits/review#v2` all work, the last two without registering
first.

### Short ids

Every registered bundle gets a one-character handle — `1`, `2`, … `a`, `b` —
usable anywhere a name is:

```bash
hcm registry list           # 1  ts-review-kit v1.0.0
hcm install 1               # …instead of typing the name
hcm update 1
hcm registry remove 1
```

Ids are assigned on registration and stay put; re-registering a bundle keeps
its id, and an id freed by `registry remove` is handed to the next bundle
registered. They are a local convenience, not an identity: `bundles.txt` and
install receipts always record names and sources, so nothing that travels
between machines depends on them.

### Scopes

- `--scope project` (default) — writes into the current directory; state in
  `.hcm/state.json` and cached context in `.hcm/context/`, both of which you can
  commit so the team shares them.
- `--scope user` — writes into the harness's home directory; state in
  `~/.hcm/state.json`.

### GitHub sources

Paste whatever GitHub gave you — the address bar, the clone box, or the short
form. All of these work anywhere a bundle is accepted (`registry add`, `install`,
`info`):

```bash
# shorthand
hcm registry add owner/repo                  # default branch
hcm registry add owner/repo#v1.2.0           # tag, branch or SHA
hcm registry add owner/repo/bundles/my-kit   # subdirectory of a monorepo

# copied from the browser
hcm registry add https://github.com/owner/repo
hcm registry add https://github.com/owner/repo?tab=readme-ov-file
hcm registry add https://github.com/owner/repo/tree/main/bundles/my-kit
hcm registry add https://github.com/owner/repo/blob/main/bundles/my-kit/hcm.yaml

# copied from the clone box
hcm registry add https://github.com/owner/repo.git
hcm registry add git@github.com:owner/repo.git
```

Query strings and GitHub's own `#readme` / `#L42` anchors are ignored. A `/blob/`
URL points at a file, so the bundle is taken to be the directory containing it —
linking straight at a bundle's `hcm.yaml` does the right thing. Any other
fragment is treated as a ref, so `.../repo#v1.2.0` works.

One ambiguity is unavoidable: in `/tree/feature/login/bundles/kit`, GitHub itself
can't tell the branch `feature/login` from a branch `feature` containing
`login/bundles/kit` without asking the server. `hcm` takes the first segment as
the ref, so for a branch name containing a slash use the shorthand instead:
`owner/repo/bundles/kit#feature/login`.

Tarballs are cached under `~/.hcm/cache`; `--refresh` re-downloads. See
[Settings](#settings) to put the cache somewhere else.

### The store: where registered bundles live

Registering **copies** the bundle into one central directory, `~/.hcm/store`,
with a folder per entry:

```bash
hcm registry open           # prints the path, and opens it in your file manager
hcm registry open 1         # just that bundle's folder
hcm registry open --no-open # print only
```

```
~/.hcm/store/
├── 1-ts-review-kit/
└── 2-db-kit/
```

So a registered bundle is a **snapshot**. Installing it today and again next
month installs the same thing both times, whether it came from a GitHub ref that
has since moved or a working directory you have been editing. `hcm update` is
what goes back to the source; nothing else does.

### Authoring: `registry add --dev`

While you are writing a bundle, a snapshot is exactly wrong — you want the edit
you just made. `--dev` registers a local bundle *in place*:

```bash
hcm registry add ./my-kit --dev
# edit my-kit/subagents/reviewer.md
hcm install my-kit          # picks up the edit; nothing to refresh
```

Dev entries are marked `[dev]` in `hcm list`, are read from your directory every
time, and never have a copy in the store — so `hcm registry remove` unregisters
them without touching your files. `--dev` is refused for GitHub sources: there
is nothing to edit in place. Clone the repo and register the clone.

### Updating

`hcm update` re-reads a bundle from its source and puts the new version wherever
the old one already was — every target and scope the ledger knows about:

```bash
hcm update my-kit           # or: hcm update 1
hcm update all              # every registered bundle
hcm update 1 --dry-run      # show the swap without doing it
hcm update 1 -t claude-code -s project
```

It is a rollback followed by an install, not a write-over-the-top, because a new
version is defined as much by what it *removed*: a subagent deleted upstream has
to disappear from the harness too. Items you hand-edited since installing still
block the way they do for `hcm uninstall`, and `--force` still overrides — an
update never silently discards your changes. Anything the new version now
collides with is put to you the same way `hcm install` does, and `--on-conflict`
works here too.

Bundles that are registered but not installed anywhere just get their stored
copy refreshed.

### Removing

```bash
hcm registry remove 1              # or by name; several at once is fine
```

That unregisters the bundle and deletes its copy from the store. Anything it
installed stays where it is — removal tells you so, and `hcm uninstall` still
works afterwards, because uninstall replays receipts and never needs the bundle
files.

### Collections: many bundles in one place

A directory — local or a GitHub repo — can hold several bundles side by side.
Anything whose immediate subdirectories each contain an `hcm.yaml` is treated as
a collection:

```
agent-kits/
├── review-kit/
│   └── hcm.yaml
├── db-kit/
│   └── hcm.yaml
└── docs/            ← no manifest, ignored
```

Point any command at the collection and it acts on every bundle inside:

```bash
hcm registry add ./agent-kits        # registers review-kit and db-kit separately
hcm registry add acme/agent-kits     # same, straight from GitHub
hcm install ./agent-kits             # installs both
hcm info acme/agent-kits             # describes both
```

Each is registered, installed and tracked under its own name, so
`hcm uninstall review-kit` removes only that one. To work with a single bundle
out of a collection, name its subdirectory: `hcm install acme/agent-kits/db-kit`.

Only one level is searched. A bundle that happens to contain a nested `hcm.yaml`
is still one bundle, not a collection.

### Settings

`hcm config` shows every setting, its effective value, and where that value came
from:

```bash
hcm config                                  # list everything
hcm config get cacheDir
hcm config set cacheDir /srv/shared/hcm     # a path all your projects share
hcm config unset cacheDir                   # back to the default
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `cacheDir` | `~/.hcm/cache` | Where bundles downloaded from GitHub are stored |
| `storeDir` | `~/.hcm/store` | Where registered bundles themselves are kept |

Precedence is environment variable, then `config.json`, then the default:

| Variable | Overrides |
| --- | --- |
| `HCM_CACHE_DIR` | `cacheDir` |
| `HCM_STORE_DIR` | `storeDir` |
| `HCM_HOME` | The whole `~/.hcm` directory — config, registry, user state, cache and store |
| `HCM_CONFIG` | The path of `config.json` itself |

The cache is shared, so a bundle downloaded once installs into as many projects
as you like without re-fetching. Pointing `cacheDir` at a shared or synced
directory lets several machines reuse the same downloads. Changing it does not
move existing downloads; they are simply re-fetched on next use.

`storeDir` moves the registered bundles themselves. Changing it does not move
what is already there; entries whose folder has gone missing are re-fetched from
their source on next use, so a relocated store repopulates itself. A bundle
registered with `--dev` is never in the store at all — it is read from your
working directory.

### Sharing a setup: `bundles.txt`

`hcm export` writes the bundles you have as a plain list, one reference per
line, that `hcm import` can replay on another machine:

```bash
hcm export                       # what is installed here -> bundles.txt
hcm export --registry            # everything this machine knows about
hcm export --scope user          # user-scope installs only
hcm export --stdout              # print instead of writing
```

```
# hcm bundles file
# generated 2026-08-06T14:48:27.117Z
# source: installed bundles (project scope)
#
# Recreate this setup with:  hcm import bundles.txt --install

# review-kit v2.0.0 -> claude-code, copilot
acme/kits/bundles/review#v2.0.0
```

Then elsewhere:

```bash
hcm import bundles.txt              # register everything listed
hcm import bundles.txt --install    # register and install, honouring -t/-s
```

Commit `bundles.txt` and a new machine reproduces the setup in one command.
Notes are comments, so the file stays a simple list of references — a line may
be any form `hcm install` accepts, including a collection, which expands to
every bundle inside it.

**Only GitHub-backed bundles are exported.** A local path means nothing on
another computer, so those are listed as skipped rather than written out:

```
! Skipped 1 local bundle(s), which cannot be fetched elsewhere:
    local-kit (C:\work\local-kit)
```

Push a bundle to GitHub and re-register it if you want it to travel. An import
where some entries fail registers everything it can, reports the rest, and exits
non-zero.

## Layout of this repo

```
src/
├── cli.ts              # command wiring
├── commands/           # one file per command
├── core/               # bundle loading, planning, executing, rollback, state
│                       # state.ts -- receipts and the claims that refcount them
│                       # deps.ts + semver.ts -- the dependency graph
│                       # registry.ts + store.ts -- ids and the bundle snapshots
│                       # context.ts -- the cached instruction sections
│                       # refs.ts -- finding file references, and what they meant
│                       # refmap.ts -- repointing them at the installed layout
├── merge/              # json-merge.ts, blocks.ts, toml.ts -- the receipt machinery
└── targets/            # one adapter per harness
bundles/ts-review-kit/  # sample bundle exercising every resource kind
tests/                  # merge/rollback unit tests + install round-trip
└── fixtures/           # sample bundles and projects the tests run against,
                        # small enough to solve by hand -- see its README
```

## Development

`make help` lists every target. The ones you'll use:

| Target | What it does |
| --- | --- |
| `make setup` | Install dependencies, build, and run the checks |
| `make check` | Typecheck plus tests — run before committing |
| `make audit` | Report known vulnerabilities in dependencies |
| `make dev ARGS="targets"` | Run the CLI from source, no build step |
| `make run ARGS="list"` | Build, then run the built CLI |
| `make test-watch` | Tests in watch mode |
| `make link` / `make unlink` | Add or remove `hcm` on your PATH |
| `make demo` | Show where the sample bundle would install |
| `make pack` | Build a publishable tarball |
| `make publish` | Run checks and publish to npm |
| `make version-patch\|minor\|major` | Bump the version and tag it |
| `make clean` | Remove `dist/` and tarballs |
| `make distclean` | Also remove `node_modules/` |
| `make reinstall` | `distclean` followed by `setup` |

Every recipe is a single shell-agnostic command, because make on Windows may
hand recipes to either `sh` or `cmd.exe`. If you add one, avoid shell builtins
and pipes — `node -e` handles file operations portably.

Adding a harness means writing one file in `src/targets/` — a `scopeRoot`, a list
of supported kinds, and a function mapping each resource to writes. The receipt
and rollback machinery is shared.
