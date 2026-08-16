<!-- hcm:begin sample-kit/10-conventions -->
## Review conventions

- Every behavioural change needs a test that fails without it.
- Run `npm run typecheck && npm test` before saying a change is done.
- Before releasing, work through `.reasonix/skills/dependency-audit/checklist.md`.
<!-- hcm:end sample-kit/10-conventions -->

<!-- hcm:begin sample-kit/20-pull-requests -->
## Pull requests

- Describe what changed and why; the diff already says how.
- Keep unrelated refactors out of a review branch.
<!-- hcm:end sample-kit/20-pull-requests -->

<!-- hcm:begin sample-kit/rules/typescript -->
**Applies to:** `**/*.ts`, `**/*.tsx`

- Prefer named exports; use a default export only when a module has one subject.
- No `any`. Reach for `unknown` plus a narrowing check instead.
- Model absence with `undefined`; reserve `null` for values crossing a JSON boundary.
<!-- hcm:end sample-kit/rules/typescript -->
