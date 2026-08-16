# Test case: context-append-restores-lost-section

## What this proves

`hcm context append` puts back the section the agent's rewrite **lost**, and
leaves alone the one it **kept without markers** - so nothing is said twice.

**Unit under test:** `src/core/context.ts::appendContext`
**Layer:** use case over an injected project directory
**Requirement:** "Context: sections that survive being overwritten"

## Inputs

| File | What it is | Rows / shape |
| --- | --- | --- |
| `inputs/case.json` | install, overwrite `CLAUDE.md`, `context append` | 3 steps |
| `inputs/bundles/review-kit/` | the bundle | two context sections |
| `inputs/rewritten-CLAUDE.md` | what the agent left behind | prose, no markers |

### The rewrite

`inputs/rewritten-CLAUDE.md` is `CLAUDE.md` as a coding agent leaves it after
rewriting the file from scratch. Two things about it matter, and they are
different on purpose:

| Section | What the agent did |
| --- | --- |
| `10-conventions` | **deleted entirely** - markers and text both |
| `20-pull-requests` | **kept the prose, dropped the markers** |

That asymmetry is the whole context family. An agent that rewrites a file does
not do one thing to it uniformly, and hcm has to tell the two apart.

## Expected outputs

| File | What it is | Ordering |
| --- | --- | --- |
| `outputs/tree/**` | 8 files; `CLAUDE.md` is the subject | path order |

## Baseline provenance

- [x] **Computed by hand** - one section is missing and comes back; one is
  present in substance and does not.

## Walkthrough

### Why a cache exists at all

A receipt records *where* a block was, not what it said. When the agent deletes
the block, the receipt cannot put it back. So every install also writes a copy
of each context section under `.hcm/context/`, and `append` works entirely from
that copy - no registry, no network, no bundle needed.

### Reading `outputs/tree/CLAUDE.md`

Top to bottom:

1. The agent's own notes about the repository - untouched.
2. `## Pull requests`, as **bare prose**, exactly where the agent left it. No
   markers around it.
3. `<!-- hcm:begin review-kit/10-conventions -->` ... `<!-- hcm:end ... -->` -
   restored, at the end.

Exactly **one** `hcm:begin` in the file. Count them.

### The two decisions

| Section | Marker present? | Text present? | Outcome |
| --- | --- | --- | --- |
| `10-conventions` | no | no | **appended** from the cache |
| `20-pull-requests` | no | yes | **unmarked** - left alone |

The second is the one worth understanding. hcm compares the cached body against
the file, ignoring blank lines and trailing spaces, and treats a match as "the
section survived, someone just took the markers off". Appending again would say
the same thing twice in one instruction file, which is worse than a missing
marker.

Very short sections are exempt from that check: `## Conventions` appearing
somewhere is no evidence a section survived, so bodies under 40 characters are
not matched this way.

### What is not restored

The agent's own notes stay. `append` adds; it does not judge. Throwing the
rewrite away is `override`, next door.

## Why this proves the code is correct

- **It pins:** restoration from the cache rather than the bundle, and the
  unmarked-but-present detection that stops a section being duplicated.
- **It would catch:** an append that duplicated `## Pull requests`, one that
  restored nothing because the markers were gone, and one that discarded the
  agent's notes.
- **It does not cover:** running it twice (next door), or `override`.

## How to run and debug

```bash
make test-case CASE=context-append-restores-lost-section
make debug-case CASE=context-append-restores-lost-section
```

**Start here:** breakpoint in `src/core/context.ts`, in `containsBody`.
