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
hcm registry add ./my-kit        # make it installable by name
hcm list                         # what can I install?
hcm info my-kit                  # where would everything land?
hcm install my-kit --dry-run     # check before writing
hcm install my-kit               # install into every supported target
hcm list --installed             # what is installed here?
hcm status                       # is it all still intact?
hcm uninstall my-kit             # remove exactly what was installed
```

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
- **Conflicts are caught before writing.** Installing a bundle that would claim
  an item another bundle already owns fails with the owner named, unless you
  pass `--force`.

## Commands

| Command | What it does |
| --- | --- |
| `hcm install <bundle>` | Install. `-t/--target`, `-s/--scope`, `--dry-run`, `--force`, `--refresh` |
| `hcm uninstall <bundle>` | Remove exactly what was installed. `-t`, `-s`, `--dry-run`, `--force` |
| `hcm list` | Registered bundles (`●` = installed somewhere) |
| `hcm list --installed` | Installed bundles. `--scope project\|user\|all`, `--json` |
| `hcm info <bundle>` | Contents, plus where every item would land in each target |
| `hcm status` | Verify installed items are still present and unmodified |
| `hcm validate [dir]` | Check a bundle for common mistakes |
| `hcm init [dir]` | Scaffold a new bundle |
| `hcm targets` | Supported harnesses and their paths on this machine |
| `hcm registry add <source>` | Register a bundle by path, `owner/repo`, or GitHub URL |
| `hcm registry list\|remove` | Manage the registry |
| `hcm export [file]` | Write installed (or `--registry`) bundles to `bundles.txt` |
| `hcm import [file]` | Register everything a bundles file lists; `--install` to install too |
| `hcm config` | Show settings; `config set\|get\|unset` to change them |

`<bundle>` accepts a registered name, a local path, or a GitHub reference — so
`hcm install ./my-kit` and `hcm install acme/kits/review#v2` both work without
registering first.

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

Precedence is environment variable, then `config.json`, then the default:

| Variable | Overrides |
| --- | --- |
| `HCM_CACHE_DIR` | `cacheDir` |
| `HCM_HOME` | The whole `~/.hcm` directory — config, registry, user state and the default cache |
| `HCM_CONFIG` | The path of `config.json` itself |

The cache is shared, so a bundle downloaded once installs into as many projects
as you like without re-fetching. Pointing `cacheDir` at a shared or synced
directory lets several machines reuse the same downloads. Changing it does not
move existing downloads; they are simply re-fetched on next use.

Local bundles are *referenced in place*, not copied into the cache — so while
you are authoring one, editing it and re-running `hcm install` picks up your
changes with nothing to invalidate.

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
