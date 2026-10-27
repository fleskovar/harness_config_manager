# Strategy: an entry point of a library

Use this strategy for a library or package that a project installs as a
dependency, with pip, uv, Poetry, npm, pnpm or Yarn. The bundle ships inside
the package. A small entry point of the package installs the bundle into the
project. The user runs it with the package manager of the project, so no global
command is necessary. Read the shared rules in [the skill](./SKILL.md) first.

If the library ships a bundle with an older integration already, for example
an `init` command that registers the bundle, read
[Upgrade an existing integration](./migrate.md) too.

| Language | The user runs | The entry point is |
| --- | --- | --- |
| Python | `python -m my_library hcm install -t claude-code` | the module `my_library.hcm`, called from the `__main__.py` of the package |
| Node.js | `npx --no my-lib-hcm install -t claude-code` | the `bin` command `my-lib-hcm` of the package |

## Why the library does not use the registry

Each project has its own environment: a `.venv/`, a `node_modules/`. Project A
can pin version 1 of the library, and project B version 2. Each project needs
the bundle of its own version. The hcm registry has one entry for each bundle
name, for each user. Thus one registration cannot serve both projects.

So the entry point installs the bundle straight into the current project, from
the folder in the environment of that project. It gives hcm `--track source`.
hcm records that folder in the `.hcm/state.json` file of the project, and does
not change the registry. Then:

- After an upgrade of the library, `hcm update` in the project reads the folder again, and installs the new version.
- `hcm update` does not read the registry for this bundle. A registered `my-lib` in another version does not replace the version of the project.
- If the registry has a different version of the bundle, `hcm install` and `hcm update` show a warning. `hcm list --installed` marks the installation `[source]`.
- When the folder is inside the project, hcm also records it as a path relative to the project. A teammate's checkout then reads its own environment.

## The commands of the entry point

| Command | Effect |
| --- | --- |
| `install [-t <harness...>]` | Installs the bundle of this package version into the current project. It follows the folder in the environment. With no `-t`, it repairs the harnesses that have the bundle, for example after the environment moved. |
| `uninstall` | Optional. Runs `hcm uninstall my-lib -t all` in the current project. |
| `init` | Optional. Registers the bundle for the user, as [the CLI strategy](./cli.md#what-hcm-init-does) does. Supply it only if the library is also installed one time per machine, for example with `pipx install` or `npm install -g`. It takes the `--dev` option of [development mode](./cli.md#development-mode). |
| `remove` | Optional, with `init` only. Unregisters the bundle: `hcm registry remove my-lib`. |

## What install does

1. Find hcm. Run `hcm --version`. If the command fails, print `npm install -g harness-config-manager` as the install command, and exit with a non-zero code.
2. Run `hcm install --help`. If the output does not contain `--track`, the hcm is too old. Print `npm install -g harness-config-manager@latest` as the upgrade command, and exit with a non-zero code.
3. Find the bundle folder from the location of the installed package, not from the current folder.
4. Run `hcm list --installed --scope project --json`. Find the harnesses that have the bundle in this project.
5. If the bundle is installed already, run `hcm update my-lib --from <bundle-folder> -t <those harnesses> --no-prompt`. This points the installations at the folder of this environment. It removes the files of the old version, and it keeps the parameter values.
6. For each requested harness that does not have the bundle, run `hcm install <bundle-folder> --track source -t <harness...> --no-prompt`.
7. Print the next step: after each upgrade of the library, run `hcm update`.

Use the full harness ids in step 6, for example `claude-code`. The list of step
4 has full ids, and a short form such as `claude` does not compare equal to it.

## Python

### Package the bundle

Put the bundle beside the code, as package data:

```
my_library/
├── __init__.py
├── __main__.py         # python -m my_library hcm ...
├── hcm.py              # the entry point
└── hcm_bundle/
    ├── hcm.yaml        # name: my-library
    └── skills/my-library/SKILL.md
```

```toml
# pyproject.toml, with setuptools
[tool.setuptools.package-data]
my_library = ["hcm_bundle/**/*"]
```

Hatchling and Poetry include the files in the package folder by default. Make
sure that the built wheel contains `hcm_bundle/`, for example with
`unzip -l dist/*.whl`.

### The module

Start from the Python code in [the examples](./examples.md#python). Copy
`_find_hcm`, and change `BUNDLE_NAME`. Copy `hcm_init` and `hcm_remove` only if
you supply `init`. Then add these functions:

```python
# my_library/hcm.py, after the functions from the examples.
import argparse
import json


def _hcm_tracks_sources(hcm: str) -> bool:
    """True when this hcm has "hcm install --track"."""
    help_text = subprocess.run([hcm, "install", "--help"], capture_output=True, text=True).stdout
    return "--track" in help_text


def hcm_install_here(targets: list[str]) -> int:
    """Install the bundle of this environment into the current project.

    The installation follows this folder (--track source). After an upgrade of
    the library, "hcm update" in the project reads the folder again.
    """
    hcm = _find_hcm()
    if hcm is None:
        print("my-library: hcm is not installed. Install it with: npm install -g harness-config-manager", file=sys.stderr)
        return 1
    if not _hcm_tracks_sources(hcm):
        print("my-library: this hcm is too old. Upgrade it with: npm install -g harness-config-manager@latest", file=sys.stderr)
        return 1

    listed = subprocess.run(
        [hcm, "list", "--installed", "--scope", "project", "--json"],
        capture_output=True,
        text=True,
    )
    if listed.returncode != 0:
        print(listed.stderr, file=sys.stderr)
        return listed.returncode
    installed_in = sorted({r["target"] for r in json.loads(listed.stdout) if r["bundle"] == BUNDLE_NAME})

    # Installed already: follow the folder of this environment from now on.
    # The update removes the files of the old version, and keeps the parameters.
    if installed_in:
        updated = subprocess.run(
            [hcm, "update", BUNDLE_NAME, "--from", str(BUNDLE_DIR), "-t", *installed_in, "--no-prompt"]
        )
        if updated.returncode != 0:
            return updated.returncode

    missing = [target for target in targets if target not in installed_in]
    if not installed_in and not missing:
        print("my-library: name the harnesses, for example: -t claude-code", file=sys.stderr)
        return 2
    if missing:
        added = subprocess.run(
            [hcm, "install", str(BUNDLE_DIR), "--track", "source", "-t", *missing, "--no-prompt"]
        )
        if added.returncode != 0:
            return added.returncode

    print('After each upgrade of my-library, run "hcm update" in this project.')
    return 0


def hcm_uninstall_here() -> int:
    """Remove the bundle from the current project."""
    hcm = _find_hcm()
    if hcm is None:
        return 1
    return subprocess.run([hcm, "uninstall", BUNDLE_NAME, "-t", "all"]).returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m my_library hcm", description="Connect my-library to hcm.")
    commands = parser.add_subparsers(dest="command", required=True)

    install = commands.add_parser("install", help="install the bundle of this environment into the current project")
    install.add_argument("-t", "--target", nargs="+", default=[],
                         help="the harnesses, by full id, for example claude-code")

    commands.add_parser("uninstall", help="remove the bundle from the current project")

    args = parser.parse_args(argv)
    if args.command == "install":
        return hcm_install_here(args.target)
    return hcm_uninstall_here()


if __name__ == "__main__":
    sys.exit(main())
```

To supply `init` and `remove` too, add their parsers, and call `hcm_init` and
`hcm_remove` from the examples.

Make `python -m my_library hcm install` work with a `__main__.py`. If the
package has a `__main__.py` already, add the `hcm` branch to it:

```python
# my_library/__main__.py
import sys

from my_library.hcm import main as hcm_main

if len(sys.argv) > 1 and sys.argv[1] == "hcm":
    sys.exit(hcm_main(sys.argv[2:]))
```

A module name cannot contain `-`. Thus the user runs `python -m my_library`,
with the import name of the package, not with its distribution name.
`python -m my_library.hcm install` also works, without the `__main__.py`.

### Run it with the interpreter of the project

The bundle folder is in the environment of the project. Run the module with the
Python of that environment:

```bash
.venv/bin/python -m my_library hcm install -t claude-code    # a virtual environment
uv run python -m my_library hcm install -t claude-code       # uv
poetry run python -m my_library hcm install -t claude-code   # Poetry
```

Do not run it with `uvx` or `pipx run`. These tools use a temporary
environment, and `hcm update` cannot read the bundle folder again after the
environment is gone.

## Node.js and TypeScript

### Package the bundle

Add a `bin` command for hcm to the library, and include the bundle folder:

```json
{
  "name": "my-lib",
  "bin": { "my-lib-hcm": "./hcm/cli.js" },
  "files": ["dist", "hcm", "hcm-bundle"]
}
```

```
my-lib/
├── package.json
├── hcm/
│   ├── cli.js          # the bin command
│   └── hcm.js          # hcmInstallHere, hcmUninstallHere
└── hcm-bundle/
    ├── hcm.yaml        # name: my-lib
    └── skills/my-lib/SKILL.md
```

Give the command a name with the package name in it, for example `my-lib-hcm`.
A short name such as `hcm` collides with hcm itself.

For a TypeScript library, the `bin` file must be JavaScript. Compile it, point
`bin` to the compiled file, and get the bundle folder from the location of the
compiled file.

### The bin command

Start from the Node.js code in [the examples](./examples.md#nodejs). Copy the
`hcm` function, and change `BUNDLE_NAME`. Copy it into the `hcm` folder of the
package, as the layout above shows. The file is one level below the package
root, so change the bundle folder:

```js
const BUNDLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hcm-bundle');
```

Then add the per-project install:

```js
// hcm/hcm.js, after the functions from the examples.

/**
 * Install the bundle of this node_modules into the current project. The
 * installation follows this folder, so "hcm update" reads it again after an
 * upgrade of the package.
 */
export function hcmInstallHere(targets) {
  const help = hcm(['install', '--help'], { stdio: 'pipe', encoding: 'utf8' });
  if (help.error || help.status !== 0) {
    console.error('my-lib: hcm is not installed. Install it with: npm install -g harness-config-manager');
    return 1;
  }
  if (!help.stdout.includes('--track')) {
    console.error('my-lib: this hcm is too old. Upgrade it with: npm install -g harness-config-manager@latest');
    return 1;
  }

  const listed = hcm(['list', '--installed', '--scope', 'project', '--json'], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (listed.status !== 0) return listed.status ?? 1;

  const installedIn = [
    ...new Set(
      JSON.parse(listed.stdout)
        .filter((record) => record.bundle === BUNDLE_NAME)
        .map((record) => record.target),
    ),
  ];

  // Installed already: follow the folder of this node_modules from now on.
  // The update removes the files of the old version, and keeps the parameters.
  if (installedIn.length > 0) {
    const updated = hcm(['update', BUNDLE_NAME, '--from', BUNDLE_DIR, '-t', ...installedIn, '--no-prompt']);
    if (updated.status !== 0) return updated.status ?? 1;
  }

  const missing = targets.filter((target) => !installedIn.includes(target));
  if (installedIn.length === 0 && missing.length === 0) {
    console.error('my-lib: name the harnesses, for example: -t claude-code');
    return 2;
  }
  if (missing.length > 0) {
    const added = hcm(['install', BUNDLE_DIR, '--track', 'source', '-t', ...missing, '--no-prompt']);
    if (added.status !== 0) return added.status ?? 1;
  }

  console.log('After each upgrade of my-lib, run "hcm update" in this project.');
  return 0;
}

/** Remove the bundle from the current project. */
export function hcmUninstallHere() {
  return hcm(['uninstall', BUNDLE_NAME, '-t', 'all']).status ?? 1;
}
```

```js
#!/usr/bin/env node
// hcm/cli.js: my-lib-hcm install [-t <harness...>] | uninstall
import { hcmInstallHere, hcmUninstallHere } from './hcm.js';

const [command, ...rest] = process.argv.slice(2);

function targetsOption(args) {
  const index = args.findIndex((arg) => arg === '-t' || arg === '--target');
  return index < 0 ? [] : args.slice(index + 1).filter((arg) => !arg.startsWith('-'));
}

let status;
if (command === 'install') {
  status = hcmInstallHere(targetsOption(rest));
} else if (command === 'uninstall') {
  status = hcmUninstallHere();
} else {
  console.error('Usage: my-lib-hcm install [-t <harness...>] | uninstall');
  status = 2;
}
process.exit(status);
```

### Run it with the package manager of the project

```bash
npx --no my-lib-hcm install -t claude-code     # npm
pnpm exec my-lib-hcm install -t claude-code    # pnpm
yarn run my-lib-hcm install -t claude-code     # Yarn
```

`--no` stops `npx` when the package is not a dependency of the project. Without
it, `npx` can download a package with that name from the npm registry and run
it. That package can be a different program, and its folder is temporary.

## Test the entry point

Set `HCM_HOME` to a temporary folder in each test, as
[the skill](./SKILL.md#test-the-integration) tells. Then do these steps:

1. Make a temporary project folder with an environment that has the library.
2. In that folder, run `python -m my_library hcm install -t claude-code`, or `npx --no my-lib-hcm install -t claude-code`.
3. Run `hcm list --installed --scope project --json`. Make sure that the record of the bundle has `"track": "source"` and the version of the package.
4. Make sure that `hcm registry list --json` does not list the bundle.
5. Run the `install` command again, with no `-t`. Make sure that it succeeds.
6. Copy the bundle folder, change the version in the copy, and register the copy: `hcm registry add <copy>`. Run `hcm update`. Make sure that the installed version did not change.
7. Run `hcm validate <bundle-folder>` and `hcm refs check --path <bundle-folder>`.

## A teammate's checkout

Commit `.hcm/state.json` with the installed files. When the bundle folder is
inside the project, the record has its path relative to the project, for example
`.venv/lib/python3.12/site-packages/my_library/hcm_bundle`. A teammate creates
the environment, installs the dependencies, and runs `hcm update`. hcm reads the
bundle folder of the teammate's environment.

The relative path can be different on another machine, for example with another
Python version, or with an environment outside the project. Then `hcm update`
reports that the folder does not exist. Run the `install` command of the entry
point again. It points the installation at the folder of that environment.

## Upgrades

After an upgrade of the library, run `hcm update` in the project. Put this in
the upgrade notes of each release:

```bash
pip install -U my-library          # or: npm update my-lib
hcm update                         # reads the bundle of the new version
```

If the environment moved, for example after you created the `.venv/` again in
another place, run the `install` command of the entry point again.

## Development mode

To test changes to the bundle in other projects, install the library from your
working copy in those projects. For Python, run `pip install -e <checkout>`.
For Node.js, run `npm link` in the checkout and `npm link my-lib` in the
project. Then run the `install` command of the entry point in each test project.
The bundle folder is then the folder of your working copy, and the installation
follows it. After each edit, run `hcm update` in each test project.
