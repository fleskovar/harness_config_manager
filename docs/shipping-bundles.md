# Shipping a bundle with your software

This guide is for developers of a CLI tool, an app or a library that ships
agent configuration: skills, subagents, commands, rules, context or MCP servers.
It shows how to put that configuration in an hcm bundle, and how your users get
the bundle into hcm.

The built-in `hcm` bundle contains this guide as an agent skill, with complete
code for Node.js, Python and Go. To let an agent write the integration, install
the skill into the repository of your software:

```bash
npm install -g harness-config-manager
hcm install hcm -t claude-code --flavor integration authoring
```

The skill files are also in this repository, in
[`builtin/hcm/skills/hcm-integration/`](../builtin/hcm/skills/hcm-integration/SKILL.md).

## Three strategies

| Your software | The user runs | Skill file |
| --- | --- | --- |
| A CLI tool or app | `my-cli hcm init` | [`cli.md`](../builtin/hcm/skills/hcm-integration/cli.md) |
| A library that a project installs as a dependency | `python -m my_library.hcm init`, `npx --no my-lib-hcm init` | [`library.md`](../builtin/hcm/skills/hcm-integration/library.md) |
| Any software, when users need the bundle without the package | `hcm registry add owner/repo/hcm-bundle#v1.2.0` | [`remote.md`](../builtin/hcm/skills/hcm-integration/remote.md) |

You can combine them. Use the same bundle folder and bundle name for all of them.

## Design

- **Your software calls the `hcm` command.** It does not import hcm as a library, and it does not write the files in `~/.hcm/`. The registry format belongs to hcm, and the hcm of the user can be a different version from the one that you tested.
- **It registers the bundle folder with `hcm registry add <folder>`.** hcm copies the folder into its store, and records the folder as the source of the bundle. `hcm update <name>` reads that folder again.
- **Registration is idempotent.** A second `hcm registry add` of the same bundle keeps its id and replaces the stored copy. Thus the registration command is safe to run again, and it is also the upgrade path.
- **The registered folder is permanent.** Use the bundle folder inside the installed package, or a permanent folder of your software. Do not register a temporary folder, for example from `npx` without a local install, `uvx` or `pipx run`.
- **A local path is absolute, or starts with `./`.** hcm reads `vendor/my-lib/hcm-bundle` as the GitHub reference `owner/repo/path`.
- **One entry for each bundle name, for each user.** The last registration wins. For projects that pin different versions, the library strategy installs the bundle into one project without registering it.
- **No install hooks.** Do not run hcm from an npm `postinstall` script or a Python build hook. Package managers can skip them, they run in CI, and they change the home folder of the user without consent.

## A CLI tool

```bash
npm install -g harness-config-manager   # once per machine
my-cli hcm init                         # registers the bundle of my-cli
hcm install my-cli -t claude-code       # in each project that needs it
```

After an upgrade of the tool, run `my-cli hcm init`, then `hcm update my-cli`.

`my-cli hcm init` does these steps:

1. Run `hcm --version`. If the command fails, print `npm install -g harness-config-manager` as the install command, and exit with a non-zero code.
2. Find the bundle folder from the location of the installed tool, not from the current folder.
3. Run `hcm registry add <bundle-folder>`. If it fails, exit with its exit code.
4. Optional: with `--install`, run `hcm install my-cli`. Pass through `-t`, `-s`, `--flavor`, `--param` and `--no-prompt`.
5. Print the next step: `hcm install my-cli -t <harness>`.

On Windows, npm installs hcm as `hcm.cmd`. Node.js runs a `.cmd` file only
through a shell. The examples show how to call it.

## A library

A library has no command of its own on the `PATH`. Give it a small entry point
that the package manager of the project runs:

```bash
python -m my_library.hcm init        # the module my_library/hcm.py
npx --no my-lib-hcm init             # the bin command my-lib-hcm of the package
```

- Run the entry point in the environment of the project: `.venv/bin/python`, `uv run`, `poetry run`, `npx`, `pnpm exec` or `yarn run`.
- `--no` stops `npx` when the package is not a dependency of the project. Without it, `npx` can download a different package with that name.
- A Python module name cannot contain `-`. Use the import name: `python -m my_library.hcm`. A `__main__.py` can also accept `python -m my_library hcm init`.

The entry point has two commands:

| Command | Effect |
| --- | --- |
| `init` | Registers the bundle for the user, as the CLI strategy does. Then `hcm install my-lib` and `hcm update` work in each project. |
| `install -t <harness...>` | Installs the bundle of this package version into the current project only. Use it when projects of one user pin different versions of the library. |

The `install` command removes the old version first, then installs from the
package folder. A second `hcm install` over an installed bundle does not remove
the files that the new version deleted. `hcm update` does not update this
installation, so run `install` again after each upgrade of the library.

## A separate download

Keep the bundle in a folder of your repository, and tag each release. Users can
then get the bundle without the package. There are three methods:

- **hcm reads GitHub:** `hcm registry add owner/repo/hcm-bundle#v1.2.0`. hcm downloads an archive of all files of that ref, without history, and keeps the folder. This works for public GitHub repositories. To update, register the new tag, then run `hcm update`.
- **Sparse partial clone:** git downloads only the bundle folder, from any host, with the credentials of the user. To update, run `git fetch` and `git reset`, then `hcm update`.
- **Release archive:** the release job attaches the bundle as one `.tar.gz` file. The user extracts it into a permanent folder and registers that folder.

[`remote.md`](../builtin/hcm/skills/hcm-integration/remote.md) has the commands
for each method, and a README section to copy for your users.

## Development mode

The developers of the software change the bundle often, and want each test
project to get the changes fast. For them, add `--dev` to the registration
command:

```bash
my-cli hcm init --dev                     # the bundle folder beside the code that runs
my-cli hcm init --dev ./hcm-bundle        # or a path; mandatory for a single binary
python -m my_library.hcm init --dev       # the same option for a library
```

This runs `hcm registry add <folder> --dev`. hcm then reads the working copy in
place, with no stored copy. The entry keeps its name and id, so the test
projects need no change. After each edit of the bundle, run this command in each
test project:

```bash
hcm update my-cli -t claude-code --no-prompt
```

The update writes the changed files, adds the new files, and removes the
deleted files. The bundle version does not have to change. `hcm list` shows
`[dev]` after the bundle while the mode is on.

- Run the software from the checkout: `npm link` for Node.js, `pip install -e .` for Python. Otherwise the bundle folder beside the code is an installed copy, and `--dev` registers that copy.
- Edit the bundle only in the working copy. An edit to an installed file in a test project stops `hcm update` for that project.
- To leave the mode, run the registration command without `--dev` from the released software. hcm stores a copy again, with the same id.

The skill has sync scripts for many test projects, and the code for `--dev` in
each language.

## Rules for the bundle

- Give the bundle the name of the package, and keep its version equal to the package version.
- Keep all files of the bundle in its folder.
- Refer to a command by its name, for example `"command": "my-cli"` in an MCP file. Do not write an absolute path to an installed package.
- Declare a parameter for each value that the user must supply. For a secret, declare `secret: true`, or use an environment variable.
- If the bundle uses a feature of a newer hcm, compare the output of `hcm --version` in the registration command.
- To give your agents the hcm skills too, add `hcm` to `dependencies`. Every hcm installation has the built-in `hcm` bundle.
- To ship more than one bundle, put each bundle in its own subfolder of one folder. `hcm registry add <folder>` registers each bundle in that collection.

## Test the integration

Set `HCM_HOME` to a temporary folder in each test, so that the tests do not
change the registry of the developer. `HCM_HOME` does not move the home folders
of the harnesses, so use only project scope in tests. An install with `-s user`
writes into the real `~/.claude/` and similar folders.
