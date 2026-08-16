# Test case: conflict-overwrite-then-restore

## What this proves

`--on-conflict overwrite` replaces the project's value with the bundle's - and
the displaced value is kept in the receipt, so uninstalling **puts it back**.

**Unit under test:** `src/core/executor.ts::applyPlan` and
`src/core/rollback.ts::rollback`
**Layer:** use case over an injected project directory
**Requirement:** "When something is already there" in the top-level `README.md`

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | install `onConflict: overwrite`, then uninstall | 2 steps |
| `inputs/bundles/review-kit/` | the bundle | one resource of every kind |
| `inputs/project/` | a project that already disagrees | 2 files |

### The project before

`inputs/project/` holds a real setup that disagrees with the bundle:

| What it has | Why it is there |
| --- | --- |
| `.mcp.json` -> `filesystem` pointed at `/srv/docs` | the **collision**: same name, different value |
| `.mcp.json` -> `postgres` | an unrelated server that must survive whatever is decided |
| `CLAUDE.md`, hand-written | notes a person wrote, which must survive too |

### Why each row exists

The `postgres` server earns its place here more than anywhere: it is the control.
It has nothing to do with the collision, so if it is disturbed by either the
overwrite or the restore, the mechanism is operating on the file rather than on
the item.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 2 files - the project's own, restored | path order |

## Baseline provenance

- [x] **Computed by hand** - after a full round trip the project must hold what
  it held before, so the baseline is the input project. The interesting state is
  the one *between* the steps, which the walkthrough derives.

## Walkthrough

### After the install (not in the baseline - run it to see)

`.mcp.json` holds two servers:

- `postgres` - untouched.
- `filesystem` - now the **bundle's**, pointed at `.` rather than `/srv/docs`.

The receipt for that key records `hadPrevious: true` and keeps the displaced
value verbatim. That is the only copy of it anywhere.

### After the uninstall (the baseline)

```json
{
  "mcpServers": {
    "postgres": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres"] },
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/docs"] }
  }
}
```

1. `filesystem` is `/srv/docs` again - the value the project chose, restored
   from the receipt rather than recomputed.
2. `postgres` is exactly where it was, in the same position.
3. The file was **not** deleted, because it still holds keys hcm does not own.
   Compare `uninstall-leaves-project-empty`, where the same code removes the
   file outright because nothing was left in it.

### Why this is worth a case of its own

`--force` reads like "damage the project and hope". It is not: the damage is
recorded, and it is reversible. That is the promise this case exists to keep,
and it is one no unit test on a single function can make.

## Why this proves the code is correct

- **It pins:** the displaced value being stored on the receipt, restored on
  removal, and the unrelated key surviving both operations untouched.
- **It would catch:** an overwrite that did not record what it displaced, a
  restore that wrote the bundle's value back instead of the project's, and a
  file deleted despite still holding a foreign key.
- **It does not cover:** overwriting a *file* rather than a JSON key, where
  there is no partial ownership to reason about.

## How to run and debug

```bash
make test-case CASE=conflict-overwrite-then-restore
make debug-case CASE=conflict-overwrite-then-restore
```

**Start here:** breakpoint in `src/core/executor.ts` where `previous` is written
onto the receipt, then in `src/core/rollback.ts` where it is read back.
