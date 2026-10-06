---
description: Install, update and remove hcm bundles in a project or for the user, and check the result. Use when the user asks to add skills, subagents, commands, rules or MCP servers with hcm, or to change what hcm installed.
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

The npm package name is `harness-config-manager`. The npm package `hcm` is a
different program.

## Rules for an agent

hcm asks questions only at an interactive terminal. An agent does not have one,
so hcm stops when it needs an answer. Give each answer on the command line:

- Always give `-t <harness...>`. Without it, hcm stops in a folder that more than one harness uses.
- Give `--no-prompt` to `hcm install`, `hcm update` and `hcm import`. Then hcm does not wait for input.
- Give each required parameter with `--param NAME=value`. To see the parameters of a bundle, run `hcm info <bundle>`.
- Give `--on-conflict skip` or `--on-conflict abort` when an item can already exist.
- Do not use `--force` or `--on-conflict overwrite` unless the user tells you to. These options replace files that the user wrote or edited.
- Run each command with `--dry-run` first, and read the plan. If the plan changes files that hcm did not write, ask the user before you continue.

## Install a bundle

1. Find the bundle with `hcm list`. To see its contents and the destination of each item, run `hcm info <bundle>`.
2. Preview the install: `hcm install <bundle> -t <harness> --no-prompt --dry-run`.
3. Install the bundle: `hcm install <bundle> -t <harness> --no-prompt`.
4. Check the result: `hcm status`.

A `<bundle>` is a registered name, a registered id, a local path, or a GitHub
reference such as `owner/repo/path#v1.0.0`. You can give more than one bundle and
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
hcm registry add ./my-kit --dev            # a folder that you edit; hcm reads it in place
```

hcm copies a registered bundle into its store. A change at the source has no
effect until `hcm update`. A `--dev` bundle has no copy, so each install reads
the latest edits.

## Update and remove

| Task | Command |
| --- | --- |
| Install the new version of each bundle in this project | `hcm update -t <harness> --no-prompt` |
| Install the new version of one bundle | `hcm update <bundle> -t <harness> --no-prompt` |
| Remove a bundle, and the dependencies that no other bundle needs | `hcm uninstall <bundle> -t <harness>` |
| Unregister a bundle | `hcm registry remove <bundle>` |

`hcm update` and `hcm uninstall` do not change an item that somebody edited
after the install. hcm reports the item as `modified` and stops for that bundle.
Tell the user. Use `--force` only if the user agrees to lose the edit.

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
