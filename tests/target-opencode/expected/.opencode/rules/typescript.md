---
description: TypeScript conventions for this repository
---

**Applies to:** `**/*.ts`, `**/*.tsx`

- Prefer named exports; use a default export only when a module has one subject.
- No `any`. Reach for `unknown` plus a narrowing check instead.
- Model absence with `undefined`; reserve `null` for values crossing a JSON boundary.
