# Examples: `my-cli hcm init`

Each example registers the bundle with `hcm registry add`, and optionally
installs it. With `--dev`, it registers the working copy of the bundle with
`hcm registry add --dev` instead. See
[Development mode](./cli.md#development-mode). For a library, extend this code
as [the library strategy](./library.md) shows. Change `my-cli` to the name of your tool. Connect the
functions to the argument parser of your tool.

## Node.js

The package layout:

```
my-cli/
├── package.json          # "files": ["dist", "hcm-bundle"]
├── hcm-bundle/
│   ├── hcm.yaml          # name: my-cli
│   └── skills/my-cli/SKILL.md
└── src/commands/hcm.js
```

```js
// src/commands/hcm.js: the "my-cli hcm init" and "my-cli hcm remove" subcommands.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE_NAME = 'my-cli';
// This file is in src/commands/, two levels below the package root. After
// "npm link", this is the folder of your checkout.
const BUNDLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hcm-bundle');

const isWindows = process.platform === 'win32';

/**
 * Run hcm. On Windows, npm installs hcm as hcm.cmd, and Node runs a .cmd file
 * only through a shell. The shell splits arguments at spaces, so quote each one.
 */
function hcm(args, options = {}) {
  const quoted = isWindows ? args.map((arg) => `"${arg}"`) : args;
  return spawnSync('hcm', quoted, { shell: isWindows, stdio: 'inherit', ...options });
}

/**
 * "my-cli hcm init [--dev [path]] [--install ...]".
 * `dev`: register the working copy in place. `devPath`: the path after --dev.
 */
export function hcmInit({ install = false, installArgs = [], dev = false, devPath } = {}) {
  const probe = hcm(['--version'], { stdio: 'pipe', encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.error('my-cli: hcm is not installed. Install it with: npm install -g harness-config-manager');
    return 1;
  }

  // A relative --dev path is read from the current folder.
  const bundleDir = dev && devPath ? path.resolve(devPath) : BUNDLE_DIR;

  if (dev) {
    if (!existsSync(path.join(bundleDir, 'hcm.yaml'))) {
      console.error(`my-cli: ${bundleDir} has no hcm.yaml. Give the bundle folder: my-cli hcm init --dev <path>`);
      return 1;
    }
    // An installed copy does not change when you edit the working copy.
    if (bundleDir.split(path.sep).includes('node_modules')) {
      console.warn(
        `my-cli: ${bundleDir} is an installed copy, not a working copy. ` +
          'Run "npm link" in your checkout, or give the path: my-cli hcm init --dev <path>',
      );
    }
  }

  const added = hcm(['registry', 'add', bundleDir, ...(dev ? ['--dev'] : [])]);
  if (added.status !== 0) return added.status ?? 1;

  if (install) return hcm(['install', BUNDLE_NAME, ...installArgs]).status ?? 1;

  console.log(
    dev
      ? `Development mode: hcm reads ${bundleDir} in place. ` +
          `After each edit, run "hcm update ${BUNDLE_NAME}" in each test project.`
      : `Next: hcm install ${BUNDLE_NAME} -t <harness>`,
  );
  return 0;
}

export function hcmRemove() {
  return hcm(['registry', 'remove', BUNDLE_NAME]).status ?? 1;
}
```

A test that keeps the two versions equal:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the hcm bundle has the version of the package', () => {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const manifest = readFileSync('hcm-bundle/hcm.yaml', 'utf8');
  assert.match(manifest, new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm'));
});
```

## Python

Ship the bundle as package data. With setuptools:

```toml
# pyproject.toml
[tool.setuptools.package-data]
my_cli = ["hcm_bundle/**/*"]
```

```python
# my_cli/hcm.py: the "my-cli hcm init" and "my-cli hcm remove" subcommands.
import shutil
import subprocess
import sys
from pathlib import Path

BUNDLE_NAME = "my-cli"
# The bundle folder is package data, beside this file. After
# "pip install -e .", this is the folder of your checkout.
BUNDLE_DIR = Path(__file__).resolve().parent / "hcm_bundle"


def _find_hcm() -> str | None:
    # shutil.which also finds hcm.cmd on Windows.
    return shutil.which("hcm")


def hcm_init(
    install: bool = False,
    install_args: list[str] | None = None,
    dev: bool = False,
    dev_path: str | None = None,
) -> int:
    """my-cli hcm init [--dev [path]] [--install ...]"""
    hcm = _find_hcm()
    if hcm is None:
        print(
            "my-cli: hcm is not installed. Install it with: npm install -g harness-config-manager",
            file=sys.stderr,
        )
        return 1

    # A relative --dev path is read from the current folder.
    bundle_dir = Path(dev_path).resolve() if dev and dev_path else BUNDLE_DIR

    if dev:
        if not (bundle_dir / "hcm.yaml").is_file():
            print(
                f"my-cli: {bundle_dir} has no hcm.yaml. "
                "Give the bundle folder: my-cli hcm init --dev <path>",
                file=sys.stderr,
            )
            return 1
        # An installed copy does not change when you edit the working copy.
        if "site-packages" in bundle_dir.parts:
            print(
                f"my-cli: {bundle_dir} is an installed copy, not a working copy. "
                'Run "pip install -e ." in your checkout, or give the path: my-cli hcm init --dev <path>',
                file=sys.stderr,
            )

    command = [hcm, "registry", "add", str(bundle_dir)]
    if dev:
        command.append("--dev")
    added = subprocess.run(command)
    if added.returncode != 0:
        return added.returncode

    if install:
        return subprocess.run([hcm, "install", BUNDLE_NAME, *(install_args or [])]).returncode

    if dev:
        print(
            f"Development mode: hcm reads {bundle_dir} in place. "
            f'After each edit, run "hcm update {BUNDLE_NAME}" in each test project.'
        )
    else:
        print(f"Next: hcm install {BUNDLE_NAME} -t <harness>")
    return 0


def hcm_remove() -> int:
    hcm = _find_hcm()
    if hcm is None:
        return 1
    return subprocess.run([hcm, "registry", "remove", BUNDLE_NAME]).returncode
```

## Go (a single binary)

A binary has no package folder. Embed the bundle, and write it to a permanent
folder before you register it. `hcm update` reads that folder again, so do not
use a temporary folder.

In development mode, the binary cannot find your working copy. Thus the path
after `--dev` is mandatory.

```go
// hcm.go: the "my-cli hcm init" subcommand.
package main

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
)

// The "all:" prefix also embeds files whose names start with "." or "_".
//
//go:embed all:hcmbundle
var bundleFS embed.FS

const bundleName = "my-cli"

// hcmInit runs "my-cli hcm init". A non-empty devPath, from
// "my-cli hcm init --dev <path>", registers that working copy in place.
func hcmInit(devPath string) error {
	hcm, err := exec.LookPath("hcm") // also finds hcm.cmd on Windows
	if err != nil {
		return fmt.Errorf("hcm is not installed. Install it with: npm install -g harness-config-manager")
	}

	if devPath != "" {
		return hcmInitDev(hcm, devPath)
	}

	cache, err := os.UserCacheDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(cache, bundleName, "hcm-bundle")

	// Replace the old version, so that files deleted from the bundle go too.
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	sub, err := fs.Sub(bundleFS, "hcmbundle")
	if err != nil {
		return err
	}
	if err := os.CopyFS(dir, sub); err != nil { // Go 1.23 or later
		return err
	}

	if err := run(hcm, "registry", "add", dir); err != nil {
		return err
	}
	fmt.Printf("Next: hcm install %s -t <harness>\n", bundleName)
	return nil
}

// hcmInitDev registers a working copy with --dev, so that hcm reads it in place.
func hcmInitDev(hcm, devPath string) error {
	dir, err := filepath.Abs(devPath)
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(dir, "hcm.yaml")); err != nil {
		return fmt.Errorf("%s has no hcm.yaml. Give the bundle folder: my-cli hcm init --dev <path>", dir)
	}
	if err := run(hcm, "registry", "add", dir, "--dev"); err != nil {
		return err
	}
	fmt.Printf("Development mode: hcm reads %s in place. "+
		"After each edit, run \"hcm update %s\" in each test project.\n", dir, bundleName)
	return nil
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}
```

For Rust, the `include_dir` crate embeds a folder. Use the same procedure.

## Sync many test projects

After each edit of the bundle, run `hcm update` in each test project. Put the
list of projects in a script. Change the paths and the harness.

```bash
#!/usr/bin/env bash
# sync-hcm.sh: install the latest files of the my-cli bundle into each test project.
projects=(~/work/app-a ~/work/app-b ~/work/app-c)
for project in "${projects[@]}"; do
  echo "== $project"
  (cd "$project" && hcm update my-cli -t claude-code --no-prompt) || echo "update failed in $project"
done
```

```powershell
# sync-hcm.ps1: install the latest files of the my-cli bundle into each test project.
$projects = 'C:\work\app-a', 'C:\work\app-b', 'C:\work\app-c'
foreach ($project in $projects) {
  Write-Host "== $project"
  Push-Location $project
  hcm update my-cli -t claude-code --no-prompt
  if ($LASTEXITCODE -ne 0) { Write-Warning "update failed in $project" }
  Pop-Location
}
```

The tool can also supply this as a subcommand, for example
`my-cli hcm sync <project...>`. The subcommand runs `hcm update my-cli` in each
folder, with the `cwd` option of the subprocess.

## Test with a temporary hcm home

```bash
export HCM_HOME="$(mktemp -d)"    # the real registry of the user stays unchanged
my-cli hcm init
hcm registry list --json          # lists my-cli, with the version of the tool
cd "$(mktemp -d)"
hcm install my-cli -t claude-code --no-prompt
hcm status
my-cli hcm init                   # again: the id of my-cli stays the same
my-cli hcm init --dev /path/to/checkout/hcm-bundle
hcm registry list --json          # the same id, now with "dev": true
```

`HCM_HOME` does not move the home folders of the harnesses. Do not use
`-s user` in a test. It writes into the real `~/.claude/` and similar folders.
