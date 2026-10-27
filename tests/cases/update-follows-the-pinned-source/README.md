# Test case: update-follows-the-pinned-source

## What this proves

An installation made with `--track source` follows its source. `hcm update`
reads that source again, and it does not read the registry. This is true also
when the registry has a bundle with the same name, and also when the update
names the bundle.

This is the Python library story. The machine has `my-lib` registered from a
global install. The project has its own `my-lib` in its `.venv/`, in a
different version. After `pip install -U my-lib`, `hcm update` must install
the new version from the `.venv/`, not the registered version.

**Unit under test:** `src/commands/update.ts::updateCommand`
**Layer:** use case over an injected project directory
**Requirement:** "Follow the registry or the source" in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | register, install pinned, two upgrades, update | 5 steps |
| `inputs/bundles/my-lib-global/` | the registered copy, version 1.0.0 | one skill |
| `inputs/bundles/my-lib-global-v1-5/` | the global install after an upgrade, version 1.5.0 | one skill |
| `inputs/bundles/my-lib-venv/` | the copy in the `.venv/` of the project, version 2.0.0 | one skill |
| `inputs/bundles/my-lib-venv-v2-1/` | the `.venv/` copy after `pip install -U`, version 2.1.0 | one skill |

### Why each row exists

All four bundles have the name `my-lib`. The only difference is the version,
and the skill text says the version. Thus the installed `SKILL.md` tells which
copy the update read.

| Bundle | Demonstrates |
| --- | --- |
| `my-lib-global` | the registry has a bundle of the same name, so a name match alone would pick it |
| `my-lib-global-v1-5` | the global source also changed, so a registry refresh would install 1.5.0 |
| `my-lib-venv` | the pinned source |
| `my-lib-venv-v2-1` | the upgrade that the update must pick up |

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/.claude/skills/my-lib/SKILL.md` | the skill, version 2.1.0 | one file |
| `outputs/state.json` | version `2.1.0`, `track: source`, source `my-lib-venv` | by installation id |

## Baseline provenance

- [x] **Computed by hand** from the rule below. The generated baseline was then read line by line, and it agrees.

## Walkthrough

### The rule, stated once

An installation follows the registry or its source. `--track source` records
`source`. `hcm update` reads a source installation from its recorded source,
and it does not read or write the registry.

### Step by step

1. `register my-lib-global`: the registry has `my-lib` 1.0.0.
2. `install my-lib-venv --track source`: the project gets `my-lib` 2.0.0. The record has `track: source`, and its source is `my-lib-venv`.
3. `replaceBundle my-lib-venv`: the `.venv/` now has 2.1.0.
4. `replaceBundle my-lib-global`: the global install now has 1.5.0. The registry still has its stored copy of 1.0.0.
5. `update my-lib`: the record follows `source`. hcm reads `my-lib-venv` and installs 2.1.0.

### What a wrong implementation gives

| Wrong behaviour | Installed version |
| --- | --- |
| The update follows the registry and refreshes it | 1.5.0 |
| The update follows the stored copy of the registry | 1.0.0 |
| The update ignores the source installation | 2.0.0 |

Only the correct behaviour gives 2.1.0.

## Why this proves the code is correct

- **It pins:** that a pinned installation reads its own source, that the registered bundle of the same name does not replace it, and that the record keeps `track: source` after the update.
- **It would catch:** an update that picks the registry entry by name, and an update that skips the installation because it is "not registered".
- **It does not cover:** the project-relative path of a source inside the project, `--from`, `--no-registry` and `--track registry`. `tests/tracking.test.ts` covers them.

## How to run and debug

```bash
make test-case CASE=update-follows-the-pinned-source
make debug-case CASE=update-follows-the-pinned-source
```

**Start here:** breakpoint in `src/commands/update.ts`, in `planUpdate`, at the
call to `modeFor`. Step over it to see the record become a source job.
