# Strategy: an entry point of a library

Use this strategy for a library or package that a project installs as a
dependency, with pip, uv, Poetry, npm, pnpm or Yarn. The bundle ships inside
the package. A small entry point of the package gives the bundle to hcm. The
user runs it with the package manager of the project, so no global command is
necessary. Read the shared rules in [the skill](./SKILL.md) first.

| Language | The user runs | The entry point is |
| --- | --- | --- |
| Python | `python -m my_library.hcm init` | the module `my_library.hcm` |
| Node.js | `npx --no my-lib-hcm init` | the `bin` command `my-lib-hcm` of the package |

## Two modes

The entry point supplies two commands. They put the bundle into a project in
two different ways.

| Command | Effect | Use it when |
| --- | --- | --- |
| `init` | Registers the bundle for the user. Then `hcm install my-lib` and `hcm update` work in each project. | All projects of the user can use the same version of the bundle. This is the usual case. |
| `install -t <harness...>` | Installs the bundle of this exact package version into the current project. It does not register the bundle. | Projects of one user pin different versions of the library, and each project needs the matching bundle. |

`init` follows [What hcm init does](./cli.md#what-hcm-init-does) of the CLI
strategy, and it takes the same `--dev` option for
[development mode](./cli.md#development-mode).

## Python

### Package the bundle

Put the bundle beside the code, as package data:

```
my_library/
├── __init__.py
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

A module name cannot contain `-`. Thus the user runs
`python -m my_library.hcm`, with the import name of the package, not with its
distribution name.

Start from the Python code in [the examples](./examples.md#python). Copy
`_find_hcm`, `hcm_init` and `hcm_remove`, and change `BUNDLE_NAME`. Then add
these functions:

```python
# my_library/hcm.py, after the functions from the examples.
import argparse
import json


def hcm_install_here(targets: list[str]) -> int:
    """Install the bundle of this package version into the current project only."""
    hcm = _find_hcm()
    if hcm is None:
        print("my-library: hcm is not installed. Install it with: npm install -g harness-config-manager", file=sys.stderr)
        return 1

    # Remove the old version first. A second install over an installed bundle
    # does not remove the files that the new version deleted.
    listed = subprocess.run(
        [hcm, "list", "--installed", "--scope", "project", "--json"],
        capture_output=True,
        text=True,
    )
    if listed.returncode != 0:
        print(listed.stderr, file=sys.stderr)
        return listed.returncode
    installed_in = [r["target"] for r in json.loads(listed.stdout) if r["bundle"] == BUNDLE_NAME]
    if installed_in:
        removed = subprocess.run([hcm, "uninstall", BUNDLE_NAME, "-t", *installed_in])
        if removed.returncode != 0:
            return removed.returncode

    return subprocess.run([hcm, "install", str(BUNDLE_DIR), "-t", *targets, "--no-prompt"]).returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m my_library.hcm", description="Connect my-library to hcm.")
    commands = parser.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", help="register the bundle with hcm")
    init.add_argument("--dev", nargs="?", const="", default=None, metavar="PATH",
                      help="register a working copy in place, for development")

    install = commands.add_parser("install", help="install this version of the bundle into the current project")
    install.add_argument("-t", "--target", nargs="+", required=True, help="the harnesses, for example claude-code")

    commands.add_parser("remove", help="unregister the bundle")

    args = parser.parse_args(argv)
    if args.command == "init":
        return hcm_init(dev=args.dev is not None, dev_path=args.dev or None)
    if args.command == "install":
        return hcm_install_here(args.target)
    return hcm_remove()


if __name__ == "__main__":
    sys.exit(main())
```

To support `python -m my_library hcm init` too, add a `__main__.py`. If the
package has a `__main__.py` already, add the `hcm` branch to it:

```python
# my_library/__main__.py
import sys

from my_library.hcm import main as hcm_main

if len(sys.argv) > 1 and sys.argv[1] == "hcm":
    sys.exit(hcm_main(sys.argv[2:]))
```

### Run it with the interpreter of the project

The bundle folder is in the environment of the project. Run the module with the
Python of that environment:

```bash
.venv/bin/python -m my_library.hcm init         # a virtual environment
uv run python -m my_library.hcm init            # uv
poetry run python -m my_library.hcm init        # Poetry
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
│   └── hcm.js          # hcmInit, hcmRemove, hcmInstallHere
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

Start from the Node.js code in [the examples](./examples.md#nodejs). Copy it
into the `hcm` folder of the package, as the layout above shows. The file is
one level below the package root, so change the bundle folder:

```js
const BUNDLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hcm-bundle');
```

Then add the per-project install:

```js
// hcm/hcm.js, after the functions from the examples.

/** Install the bundle of this package version into the current project only. */
export function hcmInstallHere(targets) {
  // Remove the old version first. A second install over an installed bundle
  // does not remove the files that the new version deleted.
  const listed = hcm(['list', '--installed', '--scope', 'project', '--json'], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (listed.status !== 0) return listed.status ?? 1;

  const installedIn = JSON.parse(listed.stdout)
    .filter((record) => record.bundle === BUNDLE_NAME)
    .map((record) => record.target);
  if (installedIn.length > 0) {
    const removed = hcm(['uninstall', BUNDLE_NAME, '-t', ...installedIn]);
    if (removed.status !== 0) return removed.status ?? 1;
  }

  return hcm(['install', BUNDLE_DIR, '-t', ...targets, '--no-prompt']).status ?? 1;
}
```

```js
#!/usr/bin/env node
// hcm/cli.js: my-lib-hcm init [--dev [path]] | install -t <harness...> | remove
import { hcmInit, hcmInstallHere, hcmRemove } from './hcm.js';

const [command, ...rest] = process.argv.slice(2);

function devOption(args) {
  const index = args.indexOf('--dev');
  if (index < 0) return { dev: false };
  const next = args[index + 1];
  return { dev: true, devPath: next && !next.startsWith('-') ? next : undefined };
}

function targetsOption(args) {
  const index = args.findIndex((arg) => arg === '-t' || arg === '--target');
  return index < 0 ? [] : args.slice(index + 1).filter((arg) => !arg.startsWith('-'));
}

let status;
if (command === 'init') {
  status = hcmInit(devOption(rest));
} else if (command === 'install' && targetsOption(rest).length > 0) {
  status = hcmInstallHere(targetsOption(rest));
} else if (command === 'remove') {
  status = hcmRemove();
} else {
  console.error('Usage: my-lib-hcm init [--dev [path]] | install -t <harness...> | remove');
  status = 2;
}
process.exit(status);
```

### Run it with the package manager of the project

```bash
npx --no my-lib-hcm init          # npm
pnpm exec my-lib-hcm init         # pnpm
yarn run my-lib-hcm init          # Yarn
```

`--no` stops `npx` when the package is not a dependency of the project. Without
it, `npx` can download a package with that name from the npm registry and run
it. That package can be a different program, and its folder is temporary.

A project can also add a script that its developers run after an upgrade of the
library:

```json
{ "scripts": { "agents": "my-lib-hcm install -t claude-code" } }
```

## Pin the bundle to one project

The registry has one `my-lib` entry for each user. If project A uses version 1
of the library and project B uses version 2, one registration cannot serve
both. In each project, run the `install` command of the entry point instead:

```bash
python -m my_library.hcm install -t claude-code
npx --no my-lib-hcm install -t claude-code
```

- The command installs the bundle from the package folder of that project. It removes the old version first. A second `hcm install` over an installed bundle leaves the files that the new version deleted, and hcm stops tracking these files.
- `hcm update` does not update this installation. It reports the bundle as "installed here but not registered". After each upgrade of the library, run the `install` command again.
- If the user also registered `my-lib`, `hcm update` in the project installs the registered version over the pin. Then run the `install` command again. Use one mode in each project.

## Upgrades

| Mode | After an upgrade of the library, run |
| --- | --- |
| `init` | `python -m my_library.hcm init` (or `npx --no my-lib-hcm init`), then `hcm update my-lib` in each project |
| `install` | `python -m my_library.hcm install -t <harness...>` (or `npx --no my-lib-hcm install -t <harness...>`) in the project |

Put these commands in the upgrade notes of each release.

## Development mode

To test changes to the bundle in other projects, install the library from your
working copy in those projects. For Python, run `pip install -e <checkout>`.
For Node.js, run `npm link` in the checkout and `npm link my-lib` in the project.
Then run `init --dev`. The entry point finds the bundle folder in the working
copy. After each edit, run `hcm update my-lib` in each test project. The full
procedure is in [Development mode](./cli.md#development-mode).
