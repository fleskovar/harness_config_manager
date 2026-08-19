---
description: Audit a release candidate for dependency and licence problems.
---

# Release audit

Work through `./checklist.md`, then report what you found. The long form of the
same list is [[release-checklist]], which says why each line is there.

Identify the manifest and lockfile in use (`package.json` + `package-lock.json`)
and read `tsconfig.json` for the compiler settings the project actually uses.
None of those three ship with this bundle; they are files in whatever project
the skill is run against.

A file will be created named `audit-summary.md`, and a second one under
`reports/dependency-tree.txt`. Neither is a file this bundle ships either: they
are named by the sentence that creates them.

The release notes are not part of this bundle either:

```bash
cat docs/release-notes.md
```
