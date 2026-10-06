---
description: Ship an hcm bundle with your software, so that its users can install its agent configuration with hcm. Covers a CLI subcommand such as "my-cli hcm init", an entry point of a library such as "python -m my_library.hcm init" or "npx --no my-lib-hcm init", and a bundle that users download separately from a git repository or a release. Use when the user builds a tool, app or library that comes with agent skills, subagents, MCP servers or other agent configuration. Also use it to sync bundle changes into test projects during development.
flavors: [integration]
---

# Ship an hcm bundle with your software

Software can come with agent configuration. Examples are a skill that explains
a library, a subagent that uses a tool, and an MCP server that a tool supplies.
Put this configuration in an hcm bundle. Then give the bundle to hcm with one of
the strategies below. Use the `hcm-bundle-authoring` skill to write the bundle.

## Choose a strategy

| Your software | Strategy | The user runs | Read |
| --- | --- | --- | --- |
| A CLI tool or app with its own command | A subcommand registers the bundle that ships in the package. | `my-cli hcm init` | [the CLI strategy](./cli.md) |
| A library or package that a project installs as a dependency | An entry point of the package registers the bundle, or installs it into the current project. | `python -m my_library.hcm init`, `npx --no my-lib-hcm init` | [the library strategy](./library.md) |
| Any software, when the bundle must be available without the package | The user downloads only the bundle folder, from a repository or a release. | `hcm registry add owner/repo/hcm-bundle#v1.2.0` | [the remote strategy](./remote.md) |

You can use more than one strategy. For example, a Python library can supply
`python -m my_library.hcm init` for its users, and a tag in its repository for
the users of other languages. Use the same bundle folder and the same bundle
name for all strategies.

Code for Node.js, Python and Go is in [the examples](./examples.md).

## Shared rules

### How hcm gets the bundle

- Your software runs the `hcm` command as a subprocess. It does not import hcm as a library, and it does not write the files in `~/.hcm/`. The registry format belongs to hcm, and the hcm of the user can be a different version.
- Your software registers the bundle with `hcm registry add <folder>`. hcm copies the folder into its store, and records the folder as the source of the bundle.
- Give hcm an absolute path, or a relative path that starts with `./`. hcm reads a path such as `vendor/my-lib/hcm-bundle` as the GitHub reference `owner/repo/path`, also when the local folder exists.
- `hcm update <name>` reads the source folder again. Thus the source folder must stay in place. Do not register a temporary folder. Examples of temporary folders are the environments of `npx` without a local install, `uvx` and `pipx run`.
- `hcm registry add` is idempotent. A second registration of the same bundle keeps its id and replaces the stored copy. Thus a user can run your registration command again at any time. This is also the upgrade path.
- The registry has one entry for each bundle name, for each user. The last registration of `my-lib` replaces the earlier one. If projects of one user need different versions of the bundle, use the per-project install of [the library strategy](./library.md#pin-the-bundle-to-one-project).

### Rules for the bundle

- Give the bundle the name of the package: `name: my-lib` in `hcm.yaml`. Use the same name as a prefix for its skills, subagents and MCP servers.
- Keep the bundle version equal to the package version. Add a test or a release step that compares the two versions.
- Keep all files of the bundle in its folder. A reference to a file outside the bundle folder breaks when hcm installs the bundle.
- Refer to a command by its name, for example `"command": "my-cli"` in an MCP file. Do not write an absolute path to an installed package. The path is different on each machine.
- If the bundle needs a value from the user, for example an API URL, declare a parameter. For a secret, declare `secret: true`, or use an environment variable in the MCP or settings file.
- If the bundle needs a feature of a newer hcm, compare the output of `hcm --version` in your registration command. If the version is too old, tell the user to upgrade hcm.
- If the agents need to know about hcm itself, add `hcm` to the `dependencies` of the bundle. Every hcm installation has the built-in `hcm` bundle.

### Do not register from an install hook

Do not run hcm from an npm `postinstall` script or a Python build hook. Package
managers can skip these hooks, for example with `--ignore-scripts`. The hooks
also run in CI and in containers, where hcm is not available. And they change
the home folder of the user without consent. Give the user an explicit command.

## Development mode

When you develop the software, you change its bundle often. Register the working
copy with `hcm registry add <folder> --dev`. Then `hcm update <name>` in each test
project installs the latest files of the working copy. The CLI strategy
describes this in [Development mode](./cli.md#development-mode). A library entry
point uses the same `--dev` option.

## Test the integration

hcm reads the `HCM_HOME` environment variable. In each test, set it to a
temporary folder. Then the test does not change the real registry of the user.

`HCM_HOME` moves only the files of hcm. It does not move the home folders of
the harnesses. An install with `-s user` writes into the real home folder of the
user, for example `~/.claude/`. Thus use only project scope in tests.

1. Make a temporary folder. Set `HCM_HOME` to it for each subprocess.
2. Run your registration command.
3. Run `hcm registry list --json`. Make sure that it lists the bundle with the correct version.
4. In a second temporary folder, run `hcm install <name> -t claude-code --no-prompt`, then `hcm status`.
5. Run the registration command again. Make sure that the id of the entry did not change.

Also run `hcm validate <bundle-folder>` and `hcm refs check --path <bundle-folder>`
in the test suite of your software.

## More than one bundle

To ship more than one bundle, put each bundle in its own subfolder of one
folder. That folder is a collection. `hcm registry add <folder>` registers each
bundle in it, and each bundle keeps its own name.
