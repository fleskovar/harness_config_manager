# Test case: validate-names-every-mistake

## What this proves

`hcm validate` names all three mistakes in a bundle written to have exactly
three - and fails, so a broken bundle cannot be published by a green build.

**Unit under test:** `src/core/bundle.ts::validateBundle`
**Layer:** pure analysis over a bundle directory
**Requirement:** "Testing a bundle before publishing" in `docs/authoring-bundles.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | one `validate` step | no install at all |
| `inputs/bundles/invalid-kit/` | a bundle with three planted mistakes | 4 files |

### Why each row exists

Three mistakes, each of a different kind, and each one a real thing an author
does:

| Resource | The mistake | Why it matters |
| --- | --- | --- |
| `mcp/broken.json` | no `command` and no `url` | the server cannot be started by anything |
| `subagents/helper.md` | no `description` | harnesses use it to decide when to delegate; without it the subagent is unreachable in practice |
| `subagents/helper.md` + `skills/helper/` | same name, two kinds | on Reasonix and Pi both become `skills/helper/`, so one silently overwrites the other |

The third is the one no author would find by reading their own bundle, because
it is only a problem on two of the five harnesses - and only if you know that a
subagent is a skill there.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/report.json` | `ok: false` and the three problems | as `validateBundle` returns them |
| `outputs/tree/` | empty - nothing is installed | - |

## Baseline provenance

- [x] **Computed by hand** - three planted mistakes, three reported problems,
  and the fixture was written from this list rather than the other way round.

## Walkthrough

### Reading `report.json`

```
mcp/broken.json: MCP server needs a "command" or "url"
subagents/helper.md: missing "description" in frontmatter
Subagent "helper" collides with the skill of the same name (skills/helper,
  subagents/helper.md): Reasonix and Pi store both as skills/helper/
```

Three, and exactly three. The count is part of the assertion: a fourth would
mean a false positive, and the fixture is small enough to be sure there is
nothing else wrong with it.

### The messages name the file

Every problem starts with the path, because the author's next action is to open
it. The third names **both** paths, since the collision is a fact about the pair
rather than about either file.

### The third message explains itself

It does not merely say "name collision" - it says *why* two files that live in
different directories in the bundle are a collision at all: `Reasonix and Pi
store both as skills/helper/`. Someone who has never read the "Where things
land" table can act on that sentence alone.

### `ok: false`

`report.json` records the command's verdict as well as the list. `hcm validate`
sets a non-zero exit code, which is what makes it usable in a pre-publish check
- see `docs/authoring-bundles.md`.

### The other half of this assertion

The healthy fixtures are validated by a unit test in
`tests/lifecycle-fixtures.test.ts`. A checker that reports three problems in a
broken bundle and four in a healthy one is no use, so both halves are needed and
the healthy half belongs where it can loop over every fixture cheaply.

## Why this proves the code is correct

- **It pins:** the three checks, their exact wording, the paths in the messages,
  and the failing verdict.
- **It would catch:** a check silently dropped, a message that stopped naming
  the file, and a validator that returned problems but reported success.
- **It does not cover:** flavor and parameter validation, which have their own
  unit tests, or the healthy-bundle direction.

## How to run and debug

```bash
make test-case CASE=validate-names-every-mistake
make debug-case CASE=validate-names-every-mistake
```

Or by hand:

```bash
npx tsx src/cli.ts validate ./tests/cases/validate-names-every-mistake/inputs/bundles/invalid-kit
```

**Start here:** breakpoint in `src/core/bundle.ts`, in `validateBundle`.
