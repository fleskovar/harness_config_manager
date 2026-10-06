# hcm command reference

Run `hcm <command> --help` for the options of the installed version.

## Options that most commands take

| Option | Meaning |
| --- | --- |
| `-t, --target <harness...>` | The harnesses: `claude-code`, `copilot`, `copilot-cli`, `reasonix`, `opencode`, `pi`, or `all`. A unique prefix is also correct, for example `claude`. |
| `-s, --scope <scope>` | `project` (the current folder, the default) or `user` (the home folder of each harness). |
| `-f, --flavor <flavor...>` | Install the common part and only these parts of the bundle. `all` selects the full bundle. |
| `--param NAME=value` | A parameter value. You can give the option more than one time. `bundle:NAME=value` sets it for one bundle. `bundle@harness:NAME=value` sets it for one bundle in one harness. |
| `--params-file <file>` | Parameter values from a YAML or JSON file. |
| `--no-prompt` | Do not ask questions. Use the values on the command line, then the defaults. |
| `--dry-run` | Show the changes. Do not write. |
| `--on-conflict <policy>` | For an item that is already there and different: `prompt`, `skip`, `overwrite` or `abort`. |
| `--force` | Overwrite conflicts, and remove items that somebody edited. |

`-t` and `-f` take all the values after them. Put bundle names before these
options.

## Install and remove

| Command | What it does |
| --- | --- |
| `hcm install <bundle...>` | Install bundles, and the bundles that they require. Also `--no-deps`, `--refresh`, `--pi-subagents`. |
| `hcm update [<bundle...>\|all]` | Read the bundles from their source again. Install each new version where the old version is. No argument: the bundles of this project. `all`: all registered bundles. `--reconfigure` asks for the parameters again. |
| `hcm uninstall <bundle...>` | Remove exactly what hcm installed. Also `--cascade`, `--ignore-dependents`, `--keep-orphans`. |

## Inspect

| Command | What it does |
| --- | --- |
| `hcm list` | The available bundles, with ids. `●` marks an installed bundle. `--descriptions`, `--json`. |
| `hcm list --installed` | The installed bundles. `--scope project\|user\|all`, `--json`. |
| `hcm info <bundle...>` | The contents of a bundle, its flavors and parameters, and the destination of each item in each harness. |
| `hcm status` | The harnesses of this folder, and if each installed item is present and not changed. |
| `hcm targets` | The supported harnesses, their paths, and the files that two harnesses share. |
| `hcm params [bundle...]` | The parameter values of each installation. |
| `hcm params init [bundle...]` | Write a parameters file to fill in. |

## Context sections

| Command | What it does |
| --- | --- |
| `hcm context` | Each context section, and if it is in its file. |
| `hcm context append [bundle...]` | Write back the missing sections. |
| `hcm context override [bundle...]` | Clear the instruction file and write the sections again. This deletes text that hcm did not write. |
| `hcm context remove [bundle...]` | Remove the sections, and keep the cached copies. |

## Bundles and the registry

| Command | What it does |
| --- | --- |
| `hcm init [dir]` | Make a new bundle from a template. |
| `hcm validate [dir]` | Check a bundle for common mistakes. |
| `hcm refs check -p <path>` | Report file references that point to no file. |
| `hcm refs fix -p <path>` | Repair broken references from a list of candidates. |
| `hcm registry add <source...>` | Register bundles from a path, `owner/repo`, or a GitHub URL. `--dev` reads a local bundle in place. `-n, --name` sets a different name. |
| `hcm registry remove <bundle...>` | Unregister bundles and delete their stored copies. |
| `hcm registry list` | The registered bundles, with ids. `--json`. |
| `hcm registry open [bundle]` | Show the folder of the store or of one bundle. `--no-open` only prints the path. |
| `hcm export [file]` | Write the installed bundles, or the registry with `--registry`, to `bundles.txt`. |
| `hcm import [file]` | Register the bundles in a bundles file. `--install` installs them too. |
| `hcm config` | Show the settings. `config set\|get\|unset` changes them. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `HCM_HOME` | The hcm home folder: config, registry, user state, cache and store. The default is `~/.hcm`. |
| `HCM_PARAM_<NAME>` | A parameter value. |
| `HCM_REQUIRE_TARGET` | When hcm requires `-t`: `auto`, `always` or `never`. |
| `HCM_CACHE_DIR`, `HCM_STORE_DIR` | Different folders for the download cache and the bundle store. |
