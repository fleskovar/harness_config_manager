# Upgrade an existing integration

Use this file when your software already ships an hcm bundle, and you want the
new update features of hcm. Read the shared rules in [the skill](./SKILL.md)
first.

## What changed in hcm

hcm now records, for each installation in a project, where `hcm update` reads
the next version:

| Mode | `hcm update` reads | Set by |
| --- | --- | --- |
| `registry` | the registered bundle of the same name | an install by name or id |
| `source` | the folder or repository that the installation came from; the registry is not read | `hcm install <folder> --track source` |

With no recorded mode, an installation follows the registry when a bundle of
its name is registered. Else it follows its source.

This changes what a library can do:

| Before | Now |
| --- | --- |
| `hcm update` skipped a bundle that was installed from a folder and not registered. | `hcm update` reads that folder again. |
| A registered bundle of the same name replaced a per-project install at the next `hcm update`. | An installation with `--track source` ignores the registry. |
| After each upgrade of the library, the user ran the `install` command of the library again. That command removed the bundle and installed it again, and the parameter values were lost. | The user runs `hcm update`. The update removes the files that the new version deleted, and it keeps the parameter values. |
| To point an installation at another folder, the user removed it and installed it again. | `hcm update <bundle> --from <folder>` points it at the new folder. |
| hcm recorded only the absolute path of the folder. | For a folder inside the project, hcm also records the path relative to the project. A teammate's checkout reads its own `.venv/` or `node_modules/`. |
| Nothing told the user that the project and the registry had different versions. | `hcm install` and `hcm update` warn. `hcm list --installed` marks the installation `[source]`, and shows the registered version. |

Also new: `hcm update --no-registry` reads each installation from its recorded
source one time, and does not change the registry.

## Find your case

| You ship today | What to change | Read |
| --- | --- | --- |
| A CLI tool with `my-cli hcm init` | Nothing is necessary. You can add the new commands to your upgrade notes. | [A CLI tool](#a-cli-tool) |
| A library with only `init`, which registers the bundle | Add an `install` command that follows the environment of the project. Make it the documented command. | [A library](#a-library) |
| A library with `init` and an `install` command that removes the bundle and installs it again | Change the `install` command. Make it the documented command. | [A library](#a-library) |
| A bundle that users download from a repository | Nothing is necessary. You can document a pin for each project. | [A separate download](#a-separate-download) |

## Check the hcm version

The new commands need an hcm that has the `--track` option. Check for the
option, not for a version number. Do this check in each command that uses
`--track` or `--from`:

1. Run `hcm install --help`.
2. If the output does not contain `--track`, print this message, and exit with a non-zero code: `my-lib needs a newer hcm. Upgrade it with: npm install -g harness-config-manager@latest`.

```python
def _hcm_tracks_sources(hcm: str) -> bool:
    """True when this hcm has "hcm install --track"."""
    help_text = subprocess.run([hcm, "install", "--help"], capture_output=True, text=True).stdout
    return "--track" in help_text
```

```js
/** True when this hcm has "hcm install --track". */
function hcmTracksSources() {
  const help = hcm(['install', '--help'], { stdio: 'pipe', encoding: 'utf8' });
  return help.status === 0 && help.stdout.includes('--track');
}
```

Do not go back to the old behavior on an old hcm. The old behavior loses
parameter values, and the registry can replace the version of the project.

## A library

### Change the entry point

1. Keep the bundle folder in the package, as package data. Do not change its name or its place. The installations of your users record that folder.
2. Add the `hcm` branch to the `__main__.py` of the package, so that `python -m my_library hcm install` works. Keep `python -m my_library.hcm` working too. Users and scripts can call it.
3. Add the hcm version check above to the `install` command.
4. Change the `install` command. Use the code in [the library strategy](./library.md#the-module) for Python, or in [the bin command](./library.md#the-bin-command) for Node.js. The change is:

   | Remove | Add |
   | --- | --- |
   | The call to `hcm uninstall` before the install | For the harnesses that have the bundle: `hcm update my-lib --from <bundle-folder> -t <harness...> --no-prompt` |
   | `hcm install <bundle-folder> -t <harness...>` | For the other harnesses: `hcm install <bundle-folder> --track source -t <harness...> --no-prompt` |

5. Make `-t` optional when the bundle is installed already. Then `python -m my_library hcm install` with no options repairs the installation, for example after the `.venv/` moved.
6. Change the message at the end of the command: `After each upgrade of my-lib, run "hcm update" in this project.`
7. Keep `init` only if users can also install the library one time for each machine, for example with `pipx install` or `npm install -g`. Else delete it, and delete its documentation. If you keep it, do not call it "the usual case" in the help text.
8. If your `remove` command unregisters the bundle today, keep that meaning. Users can have scripts that call it. Add an `uninstall` command that removes the bundle from the current project: `hcm uninstall my-lib -t all`.

Do not run the `install` command from a package hook. The rule in
[the skill](./SKILL.md#do-not-register-from-an-install-hook) applies to
`install` too.

### Change the tests

Replace the registration tests of the library with these steps. Set `HCM_HOME`
to a temporary folder, as [the skill](./SKILL.md#test-the-integration) tells.

1. Make a temporary project folder with an environment that has the library.
2. Run `python -m my_library hcm install -t claude-code`.
3. Run `hcm list --installed --scope project --json`. Make sure that the record of `my-lib` has `"track": "source"` and the version of the package.
4. Make sure that `hcm registry list --json` does not list `my-lib`.
5. Run the `install` command again. Make sure that it succeeds, and that the record is the same.
6. Register another version of the bundle: change the version in a copy of the bundle folder, and run `hcm registry add <copy>`. Run `hcm update`. Make sure that the installed version did not change.

### Change the documentation

Replace the install and upgrade instructions in the README of the library:

````markdown
## Agent configuration (hcm)

This library comes with agent skills for hcm (harness-config-manager).
Install them into a project, from the environment of that project:

```bash
npm install -g harness-config-manager        # one time for each machine
python -m my_library hcm install -t claude-code
```

After each upgrade of my-library, run `hcm update` in the project. Each project
gets the skills of the my-library version that it has.
````

Put a note in the release notes of the first version with the change. Use
the text of [Move the projects of your users](#move-the-projects-of-your-users).

### Move the projects of your users

A project that has the bundle from an older integration has one of two
shapes. `hcm list --installed` shows which one:

| The line of `my-lib` | Shape | Meaning |
| --- | --- | --- |
| No `[source]` mark | A | It follows the registry. It came from `init` and `hcm install my-lib`. |
| `[source]`, and a folder in the environment of the project | B | It follows that folder. It came from the old `install` command, and nothing registered `my-lib`. |

For both shapes, the user does the same steps in each project:

1. Upgrade hcm and the library.
2. Run `python -m my_library hcm install`. The bundle is installed, so the command runs `hcm update my-lib --from <bundle-folder>`.
3. Run `hcm list --installed`. Make sure that the line of `my-lib` has `[source]` and the folder of the environment.

Step 2 records the mode. A shape B project follows its folder already, but
only because `my-lib` is not registered. If somebody registers `my-lib` later,
it follows the registry again. Step 2 prevents that.

When no project follows the registry, the user can remove the registered entry:
`hcm registry remove my-lib`. Remove it only after step 2 in each project. A
shape A project that still follows the registry then reads the folder that the
registry recorded. Usually, that folder is in the environment of the project
that ran `init`, and it has the wrong version.

### A teammate's checkout

Tell the users to commit `.hcm/state.json` with the installed files. When the
bundle folder is inside the project, the record has its path relative to the
project. A teammate creates the environment, and runs `hcm update`.

If the environment of the teammate has another layout, for example another
Python version in the path, `hcm update` reports that the folder does not
exist. The teammate then runs `python -m my_library hcm install`.

## A CLI tool

The CLI strategy does not change. `my-cli hcm init` registers the bundle, and
each project follows the registry.

You can add these commands to your upgrade notes:

```bash
npm update -g my-cli
hcm registry update my-cli          # read the new bundle into the registry
hcm update                          # in each project
hcm update --no-registry            # or: one project, from the tool folder, with no change to the registry
```

If your tool is also a dependency of projects, for example a Python tool that
each project installs into its `.venv/`, also add the `install` command of
[the library strategy](./library.md). Then each project can follow its own
version of the tool.

## A separate download

Users can now pin a release for each project, with no registration. Add this
to the instructions for your users:

```bash
hcm install owner/repo/hcm-bundle#v1.2.0 --track source -t claude-code
hcm update my-lib --from owner/repo/hcm-bundle#v1.3.0    # move to a new release
```

See [Pin the version in a project](./remote.md#pin-the-version-in-a-project).

## Checklist

- [ ] The entry point checks that hcm has `--track`.
- [ ] `install` runs `hcm update --from` for the harnesses that have the bundle, and `hcm install --track source` for the others.
- [ ] `install` does not call `hcm uninstall`.
- [ ] `python -m my_library hcm install` works, or `npx --no my-lib-hcm install` for Node.js.
- [ ] `init` is gone, or documented only for one install for each machine.
- [ ] `remove` keeps its old meaning. `uninstall` removes the bundle from the project.
- [ ] The tests check `"track": "source"`, and that a registered version does not replace the project version.
- [ ] The README tells users to run `hcm update` after an upgrade.
- [ ] The release notes tell users to run the `install` command one time in each project.
