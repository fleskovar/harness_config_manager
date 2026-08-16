# Test case: hand-written-context-survives

## What this proves

A hand-written `CLAUDE.md` survives an install **and** an uninstall, to the byte.
hcm adds its sections below what it finds and removes exactly those again.

**Unit under test:** `src/merge/blocks.ts`, through install and uninstall
**Layer:** use case over an injected project directory
**Requirement:** "Context: sections that survive being overwritten"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | install `onConflict: skip`, then uninstall | 2 steps |
| `inputs/bundles/review-kit/` | the bundle | one resource of every kind |
| `inputs/project/CLAUDE.md` | notes a person wrote | prose, no markers |

### The project before

`inputs/project/` holds a real setup that disagrees with the bundle:

| What it has | Why it is there |
| --- | --- |
| `.mcp.json` -> `filesystem` pointed at `/srv/docs` | the **collision**: same name, different value |
| `.mcp.json` -> `postgres` | an unrelated server that must survive whatever is decided |
| `CLAUDE.md`, hand-written | notes a person wrote, which must survive too |

`skip` is used so the unrelated MCP collision does not stop the run: this case
is about `CLAUDE.md`, and the collision is somebody else's subject.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/CLAUDE.md` | the hand-written file, unchanged | - |
| `outputs/tree/.mcp.json` | the project's servers, unchanged | - |

## Baseline provenance

- [x] **Computed by hand** - the requirement is that hcm removes exactly what it
  added, so a round trip must be the identity on a file hcm did not create.

## Walkthrough

### The assertion, in one command

```bash
diff tests/cases/hand-written-context-survives/inputs/project/CLAUDE.md \
     tests/cases/hand-written-context-survives/outputs/tree/CLAUDE.md
```

No output - not even a trailing-newline difference. That is the case.

### What happened in between

1. **Install.** hcm appended two marker blocks below the existing prose:

   ```
   <the hand-written notes, untouched>

   <!-- hcm:begin review-kit/10-conventions -->
   ...
   <!-- hcm:end review-kit/10-conventions -->
   <!-- hcm:begin review-kit/20-pull-requests -->
   ...
   <!-- hcm:end review-kit/20-pull-requests -->
   ```

   The file was never rewritten, only extended. Run the install alone
   (`npm run case -- hand-written-context-survives --keep` after removing the
   uninstall step) to see this state.

2. **Uninstall.** Each block is found **by its id** and cut out, along with the
   blank line that separated it. What is left is the original prose.

3. The file is not deleted, because it is not effectively empty - it holds
   prose hcm never wrote. Compare `uninstall-leaves-project-empty`, where the
   same code *does* delete `CLAUDE.md`, because there the file held nothing but
   hcm's own blocks.

### Why markers rather than line numbers

The agent may rewrite this file at any time, and a receipt recording "lines
14-22" would be worthless the moment it did. An id in a comment survives
reordering, reindentation and everything else short of deletion - and when the
agent deletes it anyway, `hcm context append` puts it back from the cache.

## Why this proves the code is correct

- **It pins:** that an instruction file is extended rather than owned, that
  block removal is exact including its separator, and that a file with foreign
  content is never deleted.
- **It would catch:** an install that rewrote `CLAUDE.md` from scratch, an
  uninstall that left a stray blank line or a dangling marker, and one that
  deleted a file holding somebody's notes.
- **It does not cover:** an agent rewriting the file while hcm's blocks are in
  it - that is the `context-*` family.

## How to run and debug

```bash
make test-case CASE=hand-written-context-survives
make debug-case CASE=hand-written-context-survives
```

**Start here:** breakpoint in `src/merge/blocks.ts`, in `removeBlock`.
