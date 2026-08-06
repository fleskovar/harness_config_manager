---
description: TypeScript conventions for this repository
appliesTo:
  - "**/*.ts"
  - "**/*.tsx"
---

- Prefer named exports; use a default export only when a module has one obvious subject.
- No `any`. Reach for `unknown` plus a narrowing check instead.
- Model absence with `undefined`; reserve `null` for values that cross a JSON boundary.
- Validate data entering the program at the boundary, then trust the types inside.
- Keep functions small enough to read without scrolling.
