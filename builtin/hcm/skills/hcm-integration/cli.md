# Strategy: a CLI subcommand

Use this strategy for a CLI tool or app with its own command. The bundle ships
inside the package of the tool, and a subcommand gives the bundle to hcm. In
this file, that subcommand is `my-cli hcm init`. Read the shared rules in
[the skill](./SKILL.md) first.

After `my-cli hcm init`, the bundle is in the hcm registry. The user then
installs it with hcm, in any project and for any harness:

```bash
my-cli hcm init
hcm install my-cli -t claude-code
```

## Procedure

1. Make the bundle. Use the `hcm-bundle-authoring` skill to write it.
2. Put the bundle in a folder of the tool package, for example `hcm-bundle/`.
3. Include the bundle folder in the package. For npm, add the folder to `files` in `package.json`. For Python, add it as package data. For a single binary, embed it.
4. Add the `my-cli hcm init` subcommand. See [What hcm init does](#what-hcm-init-does).
5. Add a `--dev` option to `my-cli hcm init` for the developers of the tool. See [Development mode](#development-mode).
6. Optional: add `my-cli hcm remove`. It runs `hcm registry remove my-cli`.
7. Test the subcommands as the shared rules tell, and with the steps in [Test development mode](#test-development-mode).
8. Document the two commands for your users: `my-cli hcm init`, then `hcm install my-cli -t <harness>`.

## What hcm init does

1. Find hcm. Run `hcm --version`. If the command fails, print `npm install -g harness-config-manager` as the install command, and exit with a non-zero code. Do not install hcm without the consent of the user.
2. Find the bundle folder. Get it from the location of the installed tool, not from the current folder.
3. If the bundle is embedded in a binary, write it to a permanent folder of the tool, for example `~/.cache/my-cli/hcm-bundle/`. Replace the old contents each time.
4. Register the bundle: `hcm registry add <bundle-folder>`. If the command fails, show its output and exit with its exit code.
5. Optional: if the user gives `--install`, run `hcm install my-cli` in the current folder. Pass through the `-t`, `-s`, `--flavor`, `--param` and `--no-prompt` options of the user.
6. Print the next step: `hcm install my-cli -t <harness>`.

For a released tool, do not register with `hcm registry add --dev`. A `--dev`
entry has no stored copy. If the package folder moves, the entry stops working.
Use `--dev` only for the development mode below.

On Windows, npm installs hcm as `hcm.cmd`. Some subprocess functions do not find
a `.cmd` file without a shell. [The examples](./examples.md) show how to find it.

## Development mode

When you develop the tool, you change its bundle often. You also want each test
project to get the changes fast. Development mode does this. `my-cli hcm init
--dev` registers the bundle folder of your working copy with
`hcm registry add <folder> --dev`. hcm then reads that folder in place, and it
keeps no stored copy.

After this registration, `hcm update` in a project installs the latest files of
the working copy:

- It writes the files that you changed.
- It adds the files that you added, and removes the files that you deleted.
- It does this when the bundle version is the same. You do not change the version for each edit.

### What hcm init --dev does

1. Find hcm, as in [What hcm init does](#what-hcm-init-does).
2. Find the working copy of the bundle. If the user gives a path (`--dev <path>`), use it. Resolve a relative path from the current folder. If the user gives no path, use the bundle folder beside the code that runs.
3. If the folder does not contain `hcm.yaml`, print an error and exit with a non-zero code.
4. If the folder is in an installed copy of the tool, print a warning. Examples are a folder in `node_modules` or `site-packages`. Changes to the working copy do not go to that folder.
5. Run `hcm registry add <folder> --dev`.
6. Print the mode and the next step: `hcm update my-cli -t <harness>` in each test project.

A single binary has no working copy beside its code. For a binary, make the path
mandatory: `my-cli hcm init --dev ./hcm-bundle`.

The entry keeps the name `my-cli` and its id in both modes. Thus the projects
that have the bundle need no change when you switch the mode.

### The development loop

1. Run the tool from your working copy. For Node.js, run `npm link` in the checkout. For Python, run `pip install -e .`. For a binary, give the path to `--dev`.
2. Register the working copy one time: `my-cli hcm init --dev`.
3. Make sure that hcm reads the working copy. `hcm list` shows `[dev]` after `my-cli`. In `hcm registry list --json`, the entry has `"dev": true`.
4. Install the bundle one time in each test project: `hcm install my-cli -t <harness> --no-prompt`.
5. Edit the bundle in the working copy.
6. Optional: check the bundle with `hcm validate <folder>`.
7. In each test project, run `hcm update my-cli -t <harness> --no-prompt`.

To update many test projects with one command, use a script. See
[the sync scripts](./examples.md#sync-many-test-projects).

You can also install the bundle at user scope: `hcm install my-cli -t <harness>
-s user`. Then one `hcm update my-cli -s user` updates all projects of the user.
Do not install the same bundle at user scope and at project scope. The agent
then loads two copies.

### Rules for development mode

- Edit the bundle only in the working copy. Do not edit the installed files in a test project. hcm reports an edited file as `modified`, and `hcm update` stops for that bundle in that project.
- To discard the edits in a test project, run `hcm update my-cli -t <harness> --force`.
- Do not make `--dev` the default. A user of the released tool needs the stored copy.
- In development mode, do not show the upgrade notice of [Upgrades](#upgrades). The versions are equal on purpose.
- Do not move or delete the working copy while the entry is in development mode. If you do, `hcm install` and `hcm update` fail for `my-cli`. Run `my-cli hcm init --dev <new-path>` to fix the entry.

### Back to the released bundle

Run `my-cli hcm init` without `--dev` from the installed release of the tool.
hcm stores a copy of the released bundle again, and it keeps the id. Then run
`hcm update my-cli` in each project to install the released files.

If the tool still runs from the working copy, for example through `npm link`,
`my-cli hcm init` stores a copy of the working copy. Thus install the released
tool first. For Node.js, run `npm unlink -g my-cli`, then
`npm install -g my-cli`.

## Upgrades

After an upgrade of the tool, tell the user to run these commands:

```bash
my-cli hcm init        # register the new bundle version
hcm update my-cli      # install it into each project that has the old version
```

You can also show a notice when the tool starts. Compare the tool version with
the version of the `my-cli` entry in `hcm registry list --json`. If the two are
different, print the two commands. Do not show the notice when the entry has
`"dev": true`. Do not run hcm automatically each time the tool starts.

## Test development mode

Do these steps after the shared test steps, with the same temporary `HCM_HOME`:

1. Run `my-cli hcm init --dev <bundle-folder>`. Make sure that the entry has `"dev": true` and the same id.
2. Change a file in the bundle folder. Run `hcm update my-cli -t claude-code --no-prompt` in the project folder. Make sure that the installed file has the change.
