# Test case: conflict-skip-keeps-existing

## What this proves

`--on-conflict skip` keeps what the project already had and installs everything
else. The skip is per **resource**, not per file and not per run.

**Unit under test:** `src/core/conflicts.ts::resolvePlanConflicts`
**Layer:** use case over an injected project directory
**Requirement:** "When something is already there" in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | one `install`, `onConflict: skip` | 1 step |
| `inputs/bundles/review-kit/` | the bundle | one resource of every kind |
| `inputs/project/` | a project that already disagrees | 2 files |

### The project before

`inputs/project/` holds a real setup that disagrees with the bundle:

| What it has | Why it is there |
| --- | --- |
| `.mcp.json` -> `filesystem` pointed at `/srv/docs` | the **collision**: same name, different value |
| `.mcp.json` -> `postgres` | an unrelated server that must survive whatever is decided |
| `CLAUDE.md`, hand-written | notes a person wrote, which must survive too |

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 8 files: 6 installed, plus the 2 the project had | path order |

## Baseline provenance

- [x] **Computed by hand** - 8 resources, 1 skipped, and the project's two files
  still present (one of them now also holding hcm's context blocks).

## Walkthrough

### `.mcp.json` - untouched

Not "merged carefully", not "rewritten identically": **not opened for writing at
all**. The whole `mcp` resource was dropped from the plan, so both servers are
exactly as the project fixture has them, `/srv/docs` and all.

```bash
diff tests/cases/conflict-skip-keeps-existing/inputs/project/.mcp.json \
     tests/cases/conflict-skip-keeps-existing/outputs/tree/.mcp.json
```

No output.

### Everything else - installed

The other six resources land normally: the subagent, the skill (two files), the
command, the rule, and the settings fragment. Count them in `outputs/tree/`.

### `CLAUDE.md` - appended to, not replaced

This is the subtle one. The file already existed and was hand-written, but it
was not in *conflict*: hcm adds marker blocks to an instruction file rather than
owning it, so there was nothing to collide with.

`outputs/tree/CLAUDE.md` therefore starts with the project's own notes and ends
with hcm's two blocks below them. The hand-written text is untouched -
`hand-written-context-survives` follows that thread to its conclusion.

### The scope of a skip

Skipping dropped one *resource*, which happened to be one JSON key. Had the
conflict been in a skill, the whole skill would have gone - half a skill on disk
is worse than none. Settings are the exception: their keys are independent, so
only the colliding key is dropped.

## Why this proves the code is correct

- **It pins:** that a skipped resource is dropped whole, that the rest of the
  bundle still installs, and that an instruction file is appended to rather than
  contested.
- **It would catch:** a skip that abandoned the whole install, one that wrote a
  partial `.mcp.json`, and one that replaced the hand-written `CLAUDE.md`.
- **It does not cover:** what happens on uninstall afterwards, which is
  `hand-written-context-survives`.

## How to run and debug

```bash
make test-case CASE=conflict-skip-keeps-existing
make debug-case CASE=conflict-skip-keeps-existing
```

**Start here:** breakpoint in `src/core/conflicts.ts`, in `dropSkipped`.
