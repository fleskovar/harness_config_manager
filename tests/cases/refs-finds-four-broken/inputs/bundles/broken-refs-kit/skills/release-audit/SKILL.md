---
description: Audit a release candidate for dependency and licence problems.
---

# Release audit

Work through `checklist.md`, then report what you found.

Identify the manifest and lockfile in use (`package.json` + `package-lock.json`)
and read `tsconfig.json` for the compiler settings the project actually uses.
None of those three ship with this bundle; they are files in whatever project
the skill is run against.

The release notes are not part of this bundle either:

```bash
cat docs/release-notes.md
```
