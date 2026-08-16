# Failure modes worth recognising

- **A fixture raised.** Every test using it fails identically; fix the fixture.
- **Collection failed.** An import error, not a test failure — read the top of
  the output, not the summary.
- **Only the last test fails.** Usually state left behind by the one before it.
