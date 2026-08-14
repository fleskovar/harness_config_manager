#!/usr/bin/env bash
# Lint the Python in this repository the way CI does.
set -euo pipefail

ruff check .
ruff format --check .
