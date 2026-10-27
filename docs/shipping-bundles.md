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
| A library that a project installs as a dependency | `python -m my_library hcm install`, `npx --no my-lib-hcm install` | [`library.md`](../builtin/hcm/skills/hcm-integration/library.md) |
| Any software, when users need the bundle without the package | `hcm registry add owner/repo/hcm-bundle#v1.2.0`, or `hcm registry add <clone-url>#v1.2.0:hcm-bundle` | [`remote.md`](../builtin/hcm/skills/hcm-integration/remote.md) |

You can combine them. Use the same bundle folder and bundle name for all of them.

## Design

- **Your software calls the `hcm` command.** It does not import hcm as a library, and it does not write the files in `~/.hcm/`. The registry format belongs to hcm, and the hcm of the user can be a different version from the one that you tested.
- **A tool registers the bundle folder with `hcm registry add <folder>`.** hcm copies the folder into its store, and records the folder as the source of the bundle. `hcm update <name>` reads that folder again.
- **A library installs the bundle folder with `hcm install <folder> --track source`.** hcm records the folder in the project, and does not change the registry. `hcm update` in the project reads that folder again.
- **Registration is idempotent.** A second `hcm registry add` of the same bundle keeps its id and replaces the stored copy. Thus the registration command is safe to run again, and it is also the upgrade path.
- **The registered folder is permanent.** Use the bundle folder inside the installed package, or a permanent folder of your software. Do not register a temporary folder, for example from `npx` without a local install, `uvx` or `pipx run`.
- **A local path is absolute, or starts with `./`.** hcm reads `vendor/my-lib/hcm-bundle` as the GitHub reference `owner/repo/path`.
- **One entry for each bundle name, for each user.** The last registration wins. For projects that pin different versions, the library strategy installs the bundle into each project without registering it.
- **No install hooks.** Do not run hcm from an npm `postinstall` script or a Python build hook. Package managers can skip them, they run in CI, and they change the home folder of the user without consent.

## A CLI tool

```bash
npm install -g harness-config-manager   # once per machine
my-cli hcm init                         # registers the bundle of my-cli
hcm install my-cli -t claude-code       # in each project that needs it
```

After an upgrade of the tool, run `my-cli hcm init`, then `hcm update my-cli`.
hcm alone can do the same, because the registry records the bundle folder of
the tool:

```bash
npm update -g my-cli
hcm registry update my-cli          # read the new bundle into the registry
hcm update my-cli                   # in each project
hcm update my-cli --no-registry     # or: one project, from the tool folder, with no change to the registry
```

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
python -m my_library hcm install -t claude-code   # my_library/__main__.py calls my_library/hcm.py
npx --no my-lib-hcm install -t claude-code        # the bin command my-lib-hcm of the package
```

- Run the entry point in the environment of the project: `.venv/bin/python`, `uv run`, `poetry run`, `npx`, `pnpm exec` or `yarn run`.
- `--no` stops `npx` when the package is not a dependency of the project. Without it, `npx` can download a different package with that name.
- A Python module name cannot contain `-`. Use the import name: `python -m my_library`.

The `install` command does not register the bundle. Each project can pin its own
version of the library, and one registry entry cannot serve two versions. So the
command installs the bundle from the environment of the current project:

1. If the bundle is installed in the project already, it runs `hcm update my-lib --from <bundle-folder> -t <harness...>`. The installations then follow the folder of this environment.
2. Else it runs `hcm install <bundle-folder> --track source -t <harness...>`.

The installation follows that folder. After each upgrade of the library, run
`hcm update` in the project. hcm reads the folder again, and does not read the
registry for this bundle. If the registry has a different version of the same
bundle, hcm warns, and `hcm list --installed` marks the installation `[source]`.

A folder inside the project, for example in `.venv/` or `node_modules/`, is
also recorded relative to the project. A teammate's checkout then reads its own
environment.

The entry point can also supply `init`, which registers the bundle as the CLI
strategy does. Supply it only if the library is also installed one time per
machine, for example with `pipx install`.

### Upgrade an older library integration

An older library integration registers the bundle with `init`, or removes and
installs the bundle again after each upgrade. To change it, and to move the
projects of its users, follow
[`migrate.md`](../builtin/hcm/skills/hcm-integration/migrate.md). In short:

1. In the entry point, check that `hcm install --help` contains `--track`.
2. Make `install` run `hcm update <bundle> --from <bundle-folder>` where the bundle is installed, and `hcm install <bundle-folder> --track source` elsewhere. Remove the call to `hcm uninstall`.
3. Keep `init` only for an install one time for each machine. Keep the old meaning of `remove`, and add `uninstall` for the project.
4. Tell users to run the `install` command one time in each project, and then `hcm update` after each upgrade.

## A separate download

Keep the bundle in a folder of your repository, and tag each release. Users can
then get the bundle without the package. There are three methods:

- **hcm reads the repository:** `hcm registry add owner/repo/hcm-bundle#v1.2.0` for GitHub, or `hcm registry add <clone-url>#v1.2.0:hcm-bundle` for any other git host. hcm downloads the files of that ref, without history, and keeps the folder. It does not need git. For a private repository, the user sets a token in `HCM_GIT_TOKEN`. To update, register the new tag, then run `hcm update`.
- **Sparse partial clone:** git downloads only the bundle folder, from any host, with the git credentials of the user. To update, run `git fetch` and `git reset`, then `hcm update`.
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
```

A library needs no `--dev` option. Install the library from the checkout
(`pip install -e .`, `npm link`), and run its `install` command in each test
project. The installation then follows the bundle folder of the checkout, and
`hcm update` in the test project reads each edit.

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
- Put an `hcm_manifest.yml` file with a `collection` name in the collection folder. Then the user can remove all your bundles in one step. See [Shipping several bundles together](authoring-bundles.md#shipping-several-bundles-together).

## Test the integration

Set `HCM_HOME` to a temporary folder in each test, so that the tests do not
change the registry of the developer. `HCM_HOME` does not move the home folders
of the harnesses, so use only project scope in tests. An install with `-s user`
writes into the real `~/.claude/` and similar folders.
