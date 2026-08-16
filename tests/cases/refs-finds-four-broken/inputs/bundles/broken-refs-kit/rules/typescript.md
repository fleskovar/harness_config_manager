---
description: TypeScript conventions for this repository
appliesTo:
  - "**/*.ts"
---

- Prefer named exports; use a default export only when a module has one subject.
- No `any`. Reach for `unknown` plus a narrowing check instead.
