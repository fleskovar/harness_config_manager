# Acme web

Hand-written project notes. Nothing `hcm` does may change or remove these lines:
installing adds marker blocks below them, uninstalling takes only those blocks
away again.

- The staging database resets every night at 02:00 UTC.
- Deploys go out from `main` only.

<!-- hcm:begin review-kit/10-conventions -->
## Review conventions

- Every behavioural change needs a test that fails without it.
- Run `npm run typecheck && npm test` before saying a change is done.
- Before releasing, work through `.claude/skills/dependency-audit/checklist.md`.
<!-- hcm:end review-kit/10-conventions -->

<!-- hcm:begin review-kit/20-pull-requests -->
## Pull requests

- Describe what changed and why; the diff already says how.
- Keep unrelated refactors out of a review branch.
<!-- hcm:end review-kit/20-pull-requests -->
