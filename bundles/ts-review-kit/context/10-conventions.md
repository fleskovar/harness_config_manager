## Review conventions

- Every behavioural change needs a test that fails without it.
- Run `npm run typecheck && npm test` before saying a change is done.
- Report test failures with their output; never describe a red suite as passing.
- Prefer fixing the root cause over widening a type or adding a cast.
