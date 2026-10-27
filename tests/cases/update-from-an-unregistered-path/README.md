# Test case: update-from-an-unregistered-path

## What this proves

A bundle installed from a path, with no registration, updates from that path.
The bare `hcm update` reads the path again and installs the new version.

Before installations could follow their source, hcm reported this bundle as
"installed here but not registered" and did not update it.

**Unit under test:** `src/commands/update.ts::updateCommand`
**Layer:** use case over an injected project directory
**Requirement:** "Follow the registry or the source" in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | install by path, upgrade, bare update | 3 steps |
| `inputs/bundles/my-lib/` | version 1.0.0 | one skill |
| `inputs/bundles/my-lib-v1-1/` | the same bundle, version 1.1.0 | one skill |

### Why each row exists

| Bundle | Demonstrates |
| --- | --- |
| `my-lib` | the path that the project installs from; nothing registers it |
| `my-lib-v1-1` | the new version at the same path, which the update must pick up |

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/.claude/skills/my-lib/SKILL.md` | the skill, version 1.1.0 | one file |
| `outputs/state.json` | version `1.1.0`, no `track` | by installation id |

## Baseline provenance

- [x] **Computed by hand** from the rule below. The generated baseline was then read line by line, and it agrees.

## Walkthrough

### The rule, stated once

An installation with no recorded mode follows the registry when a bundle of
that name is registered. Otherwise it follows its source.

### Step by step

1. `install my-lib`: the project gets 1.0.0 from the path. Nobody chose a mode, so the record has no `track`.
2. `replaceBundle my-lib`: the path now has 1.1.0.
3. `update` with no bundle name: the ledger has `my-lib`. No bundle of that name is registered, so it follows its source. hcm reads the path and installs 1.1.0.

`state.json` has no `track`: the mode is inferred each time, and nothing chose
it. A later `hcm registry add` of `my-lib` makes the installation follow the
registry. To prevent that, install with `--track source`.

## Why this proves the code is correct

- **It pins:** that an unregistered installation is updated, and from the path that it recorded.
- **It would catch:** an update that skips every installation with no registry entry.
- **It does not cover:** an installation pinned with `--track source`. The case `update-follows-the-pinned-source` covers it.

## How to run and debug

```bash
make test-case CASE=update-from-an-unregistered-path
make debug-case CASE=update-from-an-unregistered-path
```

**Start here:** breakpoint in `src/commands/update.ts`, in `updateFromSource`,
and step over `loadBundle` to see the path read again.
