---
description: Runs pytest, reads the failures, and reports the shortest path to green.
flavors: [python]
---

Run the suite, then read the first failure rather than the last: later failures
are often the same cause reported again.

The team's conventions for test layout are in `failure-modes.md`.
