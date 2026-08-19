---
description: Audit third-party dependencies for known vulnerabilities, unmaintained packages and licence problems. Use before a release or when adding a new dependency.
---

# Dependency audit

Work through the checklist in `./checklist.md`, then report what you found.
Match the tone the reviewer uses in
[the code reviewer](subagents/code-reviewer.md).

The first is written against this file, the second from the bundle root, and
`hcm` accepts either and rewrites both relative to wherever this file lands. The
checklist is installed beside it and stays as written; the reviewer moves, so
the second becomes:

```
Claude Code   ../../agents/code-reviewer.md
Reasonix      ../code-reviewer/SKILL.md      (a subagent is a skill there)
```

Both forms are what `hcm refs check` reads: the `./` says outright that this is
a path, and a link's target is one by construction. A bare `checklist.md` would
still be rewritten on the way in, but the checker would take it for prose.

## Steps

1. Identify the manifest and lockfile in use (`package.json` + `package-lock.json`,
   `pnpm-lock.yaml`, `yarn.lock`).
2. Run the ecosystem's audit command, e.g. `npm audit --json`.
3. For each advisory, check whether the vulnerable path is actually reachable
   from this project's code before treating it as urgent.
4. Flag direct dependencies with no release in over two years.
5. Flag licences incompatible with the project's own licence.

## Reporting

Group findings as **act now**, **plan a fix**, and **noted, no action**. For
each, name the package, the version in use, and the smallest upgrade that
resolves it. An advisory in a dev-only dependency that never runs in production
belongs in the third group — say why.
