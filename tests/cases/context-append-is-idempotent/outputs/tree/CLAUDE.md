# Acme web

Notes the coding agent wrote for itself after exploring the repository. This
file is what `CLAUDE.md` looks like *after* the agent rewrote it from scratch:
both of review-kit's marker blocks are gone.

- The build is `npm run build`; the tests are `npm test`.
- `src/server/` is the API, `src/web/` is the front end.

## Pull requests

- Describe what changed and why; the diff already says how.
- Keep unrelated refactors out of a review branch.

<!-- hcm:begin review-kit/10-conventions -->
## Review conventions

- Every behavioural change needs a test that fails without it.
- Run `npm run typecheck && npm test` before saying a change is done.
- Before releasing, work through `.claude/skills/dependency-audit/checklist.md`.
<!-- hcm:end review-kit/10-conventions -->
