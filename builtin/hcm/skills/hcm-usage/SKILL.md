---
description: Install, update and remove hcm bundles in a project or for the user, and check the result. Also decide if an installation follows the registry or its own source, for example a library bundle in .venv or node_modules, and repair an update whose source moved. Also manage the hcm registry. Use when the user asks to add skills, subagents, commands, rules or MCP servers with hcm, or to change what hcm installed. Also use it to register, group or unregister bundles, for example all bundles of one repository or named collection.
---

# Use hcm

hcm installs bundles into agent harnesses. A bundle is a folder of subagents,
skills, commands, rules, context, MCP servers and settings. hcm writes each item
in the format of each harness, and it records a receipt for each write. The
receipts let hcm remove exactly what it wrote.

All commands and options are in [the command reference](./commands.md). For the
exact options of the installed version, run `hcm <command> --help`.

## Before you start

1. Run `hcm --version`. If the command is not found, tell the user to install hcm with `npm install -g harness-config-manager`.
2. Run `hcm targets`. The output shows the harnesses that this folder uses, and the files that two harnesses share.
3. Run `hcm list`. The output shows the bundles that you can install, with their ids. A `●` marks a bundle that is installed.
4. Run `hcm list --installed`. The output shows the bundles of this project. A `[source]` mark shows a bundle that `hcm update` reads from its own folder or repository, not from the registry.

The npm package name is `harness-config-manager`. The npm package `hcm` is a
different program.

## Rules for an agent

hcm asks questions only at an interactive terminal. An agent does not have one,
so hcm stops when it needs an answer. Give each answer on the command line:

- Always give `-t <harness...>`. Without it, hcm stops in a folder that more than one harness uses.
- Give `--no-prompt` to `hcm install`, `hcm update` and `hcm import`. Then hcm does not wait for input.
- Give each required parameter with `--param NAME=value`. To see the parameters of a bundle, run `hcm info <bundle>`.
- Give `--on-conflict skip` or `--on-conflict abort` when an item can already exist.
- Give `--on-conflict rename` when the user wants to keep both items. hcm then installs the bundle item with the bundle name as a suffix, and changes the references in the bundle to the new name.
- Do not use `--force` or `--on-conflict overwrite` unless the user tells you to. These options replace files that the user wrote or edited.
- Run each command with `--dry-run` first, and read the plan. If the plan changes files that hcm did not write, ask the user before you continue.
- Before you run `hcm registry remove --collection`, show the user the bundles of the collection. Continue only when the user agrees.
- If `hcm registry add` reports a collection name clash, ask the user to choose. Then give `--on-collection-clash join`, `rename` or `abort`.

## Install a bundle

1. Find the bundle with `hcm list`. To see its contents and the destination of each item, run `hcm info <bundle>`.
2. Preview the install: `hcm install <bundle> -t <harness> --no-prompt --dry-run`.
3. Install the bundle: `hcm install <bundle> -t <harness> --no-prompt`.
4. Check the result: `hcm status`.

A `<bundle>` is a registered name, a registered id, a local path, a GitHub
reference such as `owner/repo/path#v1.0.0`, or the HTTPS clone URL of a
repository on another git host. You can give more than one bundle and
more than one harness. Put the bundle names before `-t`, because `-t` takes all
the values after it:

```bash
hcm install my-kit db-kit -t claude-code pi --no-prompt
```

The default scope is `project`, which is the current folder. Give `-s user` to
install for all projects of the user.

To install part of a bundle, give `--flavor <name...>`. `hcm info <bundle>`
lists the flavors of a bundle.

## Register a bundle

Register a bundle to install it by name or id:

```bash
hcm registry add ./my-kit                  # a local folder; hcm copies it
hcm registry add owner/repo/path#v1.0.0    # a folder in a GitHub repository, at a tag
hcm registry add https://dev.azure.com/org/project/_git/repo#v1.0.0:path   # the same, on another git host
hcm registry add ./my-kit --dev            # a folder that you edit; hcm reads it in place
hcm registry add ./agent-kits              # a collection: hcm registers each bundle in it
```

hcm copies a registered bundle into its store. A change at the source has no
effect until `hcm update` or `hcm registry update`. A `--dev` bundle has no copy, so each install reads
the latest edits.

## Update and remove

| Task | Command |
| --- | --- |
| Get the latest version of the registered bundles from their sources, without a change to a project | `hcm registry update` |
| Install the new version of each bundle in this project | `hcm update -t <harness> --no-prompt` |
| Install the new version of one bundle | `hcm update <bundle> -t <harness> --no-prompt` |
| Install the new version from the recorded sources, with no change to the registry | `hcm update --no-registry -t <harness> --no-prompt` |
| Install a bundle that must follow its own folder, for example a library in `.venv/` | `hcm install <folder> --track source -t <harness> --no-prompt` |
| Point an installation at a new folder, for example after the `.venv/` moved | `hcm update <bundle> --from <folder> -t <harness> --no-prompt` |
| Make an installation follow the registry again | `hcm update <bundle> --track registry -t <harness> --no-prompt` |
| Remove a bundle, and the dependencies that no other bundle needs | `hcm uninstall <bundle> -t <harness>` |
| Unregister a bundle | `hcm registry remove <bundle>` |
| Unregister each bundle of a named collection, for example each bundle of one repository | `hcm registry remove --collection <name>`. See [Remove a named collection](#remove-a-named-collection). |

Each installation follows the registry or its source. `hcm update` reads the
next version from there:

- An installation made by name or id follows the registry.
- An installation made with `--track source` follows its folder or repository. `hcm update` does not read the registry for it. Libraries use this mode, because each project can pin another version.
- With no `--track`, an installation from a path follows the registry if a bundle with that name is registered. Else it follows the path.
- `hcm list --installed` marks a source installation `[source]`. It also shows the registered version when the two versions are different. Tell the user about a different version. Do not change the mode without the agreement of the user.

### A library that follows the environment of the project

Some libraries install their bundle from the environment of the project, for
example from `.venv/` or `node_modules/`. The library supplies the command, for
example `python -m my_library hcm install -t <harness>` or
`npx --no my-lib-hcm install -t <harness>`. Use that command, not
`hcm install <name>`. A registered bundle of the same name can have another
version than the library of the project.

After an upgrade of such a library, run `hcm update -t <harness> --no-prompt`.

### When an update fails

| hcm reports | Cause | Do this |
| --- | --- | --- |
| `Bundle directory no longer exists` | The source folder moved or is gone, for example after the `.venv/` was made again. | Run the `install` command of the library again. Or run `hcm update <bundle> --from <new-folder> -t <harness> --no-prompt`. |
| `now holds the bundle "<other>"` | The recorded folder now holds a different bundle. | Find the correct folder, then use `--from`. |
| `the registry has <bundle> v<x>, but the source has v<y>` | The project pins one version, and the registry has another. This is a warning, not an error. | Tell the user. Change nothing, unless the user asks. |
| `<bundle> is also registered, from <place>` | The bundle came from a path, and the registry has a bundle of that name from another place. `hcm update` reads the registered copy. | Ask the user which copy the project must follow. For the path, install again with `--track source`. |

hcm continues with the other bundles when one source fails, and exits with
code 1. Read all of the output.

`hcm update` and `hcm uninstall` do not change an item that somebody edited
after the install. hcm reports the item as `modified` and stops for that bundle.
Tell the user. Use `--force` only if the user agrees to lose the edit.

## Manage the registry

The registry is the list of bundles that the user can install by name or id.
There is one registry for each user, for all projects.

| Task | Command |
| --- | --- |
| See the registered bundles, with their ids, sources and collection names | `hcm registry list` |
| See the bundles of one named collection | `hcm registry list --collection <name>` |
| See the full data of each entry | `hcm registry list --json` |
| Register each bundle of a collection | `hcm registry add <collection>` |
| Give the bundles of a source a collection name | `hcm registry add <source> --collection <name>` |
| Read the registered bundles from their sources again | `hcm registry update` |
| Unregister bundles | `hcm registry remove <bundle...>` |
| Unregister each bundle of a named collection | `hcm registry remove --collection <name>` |
| Show the folder that holds the copies of the bundles | `hcm registry open --no-open` |

### Named collections

The registry records a collection name on each bundle of a named collection.
Usually, these are the bundles of one repository. The name comes from one of
these:

- The `collection` in the `hcm_manifest.yml` file of the collection. hcm reads it when you register the collection folder.
- The `--collection <name>` option of `hcm registry add`. It replaces the name of the collection manifest.

Rules:

- When you register a bundle again with no collection name, the bundle keeps its collection.
- `hcm registry update` does not change a collection name. To get a new name from the collection manifest, register the collection again.
- hcm ignores the case of collection names.
- `hcm export` does not record collection names. After `hcm import`, give the names again with `--collection`.

### Collection name clashes

A clash occurs when a registration asks for a collection name, and bundles of
a different source already have that name. hcm writes nothing until the clash
is resolved. The choices are:

| Choice | Result |
| --- | --- |
| `join` | The new bundles go into the existing collection. One removal command then removes the bundles of both sources. |
| `rename` | The new bundles go into a collection with another name. The default is `<name>-2`. hcm records the rename, and does not ask again for the same source. |
| `abort` | hcm registers nothing. |

hcm asks only at a terminal. An agent has no terminal, so hcm stops with the
message `The collection name "<name>" is in use by ...`. Then do these steps:

1. Tell the user the name, and the source that already uses it.
2. Ask the user to choose `join`, `rename` or `abort`. Recommend `rename` when the two sources are not related.
3. Run the same command again with `--on-collection-clash <choice>`.

Do not give `--on-collection-clash join` without the consent of the user.

These cases are not clashes, and hcm does not ask:

- The source already has bundles in the collection.
- The sources differ only in the ref, for example `#v1.0.0` and `#v1.1.0`.
- One source is inside the other, for example a collection folder and one of its bundle folders.
- The only bundles with the name are bundles that the registration replaces.

### Remove a named collection

`hcm registry remove` changes only the registry. It does not remove the items
that a bundle installed in a project.

1. Run `hcm registry list --collection <name>`. Show the list to the user, and ask for confirmation.
2. If the user also wants the installed items removed, run `hcm list --installed` in each project.
3. For each project that has a bundle of the collection, run `hcm uninstall <bundle...> -t <harness>` there.
4. Run `hcm registry remove --collection <name>`.
5. Read the output. hcm warns when a bundle is still installed in this project or for the user. Tell the user about each warning.

To remove a named collection and other bundles in one command, give both:
`hcm registry remove 7 --collection <name>`.

### Name bundles that you registered before

Bundles of one source can be in the registry with no collection name. Give
them a name:

1. Run `hcm registry list --json`. Find the entries of the source. Note the `source` and the `dev` value of each entry.
2. If the source has an `hcm_manifest.yml` file with a `collection`, register the collection folder again: `hcm registry add <collection>`.
3. If not, give the name: `hcm registry add <collection> --collection <name>`.
4. For an entry with `"dev": true`, give `--dev` again. Without it, hcm replaces the entry with a copy.
5. If the entries are a mix of `--dev` entries and copies, register each `--dev` bundle from its own folder: `hcm registry add <bundle-folder> --dev --collection <name>`.
6. If hcm reports a clash, follow [Collection name clashes](#collection-name-clashes).
7. Run `hcm registry list --collection <name>`. Make sure that each bundle of the source is in the list.

A second registration keeps the id of each bundle. It does not change a
project. To add a manifest to the collection itself, use the
`hcm-bundle-authoring` skill.

## Repair the instruction file

The agent of a harness can rewrite `CLAUDE.md`, `AGENTS.md` or a similar file,
and remove the hcm sections. hcm keeps a copy of each section in
`.hcm/context/`.

- `hcm context` shows each section, and if the section is in its file.
- `hcm context append` writes back the missing sections. It does not change other text.

## Share a setup

- `hcm export` writes the installed bundles to `bundles.txt`.
- `hcm import bundles.txt --install -t <harness> --no-prompt` registers and installs them on another machine.
- `hcm params init` writes the parameter values of this project to `params.yaml`. Give that file back with `--params-file params.yaml`.

## The built-in bundle

The bundle `hcm`, with the id `0`, ships with hcm. It contains this skill. It is
always available, and you cannot unregister it. To add it to a project, run
`hcm install hcm -t <harness> --no-prompt`. After an upgrade of hcm, run
`hcm update hcm -t <harness> --no-prompt`.
