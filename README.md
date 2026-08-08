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
├── context/conventions.md          # always-loaded instructions
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
targets: [claude-code, copilot, reasonix]
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

Frontmatter is translated per target. A rule written once as:

```yaml
appliesTo: ["**/*.ts", "**/*.tsx"]
```

becomes `paths: [...]` for Claude Code, `applyTo: '**/*.ts, **/*.tsx'` for
Copilot, and — since Reasonix has no glob-scoped rule format — a line of prose
above the rule text in `REASONIX.md`. Subagent `tools` become a comma-separated
string for Claude Code, a YAML list for Copilot, and `allowed-tools` for
Reasonix.

Note the deliberate asymmetry: bundles say **subagent**, but each harness keeps
its own word — and its own filing system — for the same thing. Claude Code and
Copilot each have an `agents/` directory; Reasonix has none, because there a
subagent profile *is* a skill, marked `runAs: subagent` and `invocation: manual`
so it is only invoked by name. `hcm` translates; you only learn one vocabulary.

One consequence: on Reasonix a subagent and a skill share one namespace, and
Reasonix refuses a profile whose name already belongs to another skill. Give
them distinct names — `hcm validate` flags a bundle that does not.

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
| `hcm install <bundle>` | Install. `-t/--target`, `-s/--scope`, `--dry-run`, `--force`, `--on-conflict`, `--refresh` |
| `hcm update <bundle>\|all` | Re-read a registered bundle and reinstall it. `-t`, `-s`, `--dry-run`, `--force`, `--on-conflict` |
| `hcm uninstall <bundle>` | Remove exactly what was installed. `-t`, `-s`, `--dry-run`, `--force` |
| `hcm list` | Registered bundles (`●` = installed somewhere) |
| `hcm list --installed` | Installed bundles. `--scope project\|user\|all`, `--json` |
| `hcm info <bundle>` | Contents, plus where every item would land in each target |
| `hcm status` | Verify installed items are still present and unmodified |
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
  `.hcm/state.json`, which you can commit so the team shares it.
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
├── core/               # bundle loading, planning, executing, rollback, state,
│                       # registry.ts + store.ts -- ids and the bundle snapshots
├── merge/              # json-merge.ts, blocks.ts, toml.ts -- the receipt machinery
└── targets/            # one adapter per harness
bundles/ts-review-kit/  # sample bundle exercising every resource kind
tests/                  # merge/rollback unit tests + install round-trip
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
