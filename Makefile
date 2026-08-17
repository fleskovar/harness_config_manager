# harness-config-manager
#
# Recipes are deliberately shell-agnostic: this repo is developed on Windows,
# where make may hand recipes to either sh or cmd.exe. So every recipe is a
# single command, file removal goes through `node -e` rather than rm/del, and
# any quoting uses double quotes (the only kind both shells strip).

NPM ?= npm
NODE ?= node
CLI := dist/cli.js
SAMPLE := ./bundles/ts-review-kit

# Extra arguments for `make dev` / `make run`, e.g. make run ARGS="list --installed"
ARGS ?=

.DEFAULT_GOAL := help

.PHONY: help check-node install setup build dev run test test-watch typecheck check \
        audit audit-fix link unlink pack publish release demo clean distclean \
        reinstall version-patch version-minor version-major

## ---------------------------------------------------------------- help

# Dot leaders rather than spaces: sh collapses runs of whitespace in an
# unquoted echo, and quoting would print literal quotes under cmd.exe.
help:
	@echo harness-config-manager - available targets
	@echo   setup .......... install dependencies, build, and verify
	@echo   install ........ install dependencies from the lockfile
	@echo   build .......... compile TypeScript to dist/
	@echo   dev ............ run the CLI from source, e.g. make dev ARGS=targets
	@echo   run ............ run the built CLI, e.g. make run ARGS=list
	@echo   test ........... run the test suite once
	@echo   test-watch ..... run the test suite in watch mode
	@echo   test-cases ..... run the human-readable case folders
	@echo   test-case ...... run one case, e.g. make test-case CASE=pi-every-kind
	@echo   debug-case ..... run one case under the debugger, no test framework
	@echo   bless .......... regenerate case baselines - read the diff before committing
	@echo   typecheck ...... typecheck without emitting
	@echo   check .......... typecheck plus tests - run this before committing
	@echo   audit .......... report known vulnerabilities in dependencies
	@echo   audit-fix ...... apply non-breaking security updates
	@echo   link ........... install hcm globally from this checkout
	@echo   unlink ......... remove the global hcm link
	@echo   pack ........... build a publishable tarball
	@echo   publish ........ run checks and publish to npm
	@echo   release ........ check, build, and pack without publishing
	@echo   version-patch .. bump the patch version and tag it
	@echo   version-minor .. bump the minor version and tag it
	@echo   version-major .. bump the major version and tag it
	@echo   demo ........... show where the sample bundle would install
	@echo   clean .......... remove build output and tarballs
	@echo   distclean ...... clean, and remove node_modules
	@echo   reinstall ...... distclean followed by setup

## ---------------------------------------------------------------- dev environment

# The test toolchain (vitest -> vite -> rolldown) imports styleText from
# node:util, which only exists from Node 20.12 on, and vite itself asks for
# 20.19+. npm downgrades that mismatch to a warning you scroll past, so the
# first sign of it is an unreadable crash three layers down in `make check`.
# Check it up front instead, and say what to do about it.
check-node:
	@$(NODE) -e "var v=process.versions.node,p=v.split('.').map(Number),ok=(p[0]===20&&p[1]>=19)||(p[0]===22&&p[1]>=12)||p[0]>22;if(!ok){console.error('Node '+v+' is too old for this project. Install Node 20.19+, 22.12+ or 24 LTS and try again.');process.exit(1)}"

# `npm ci` is reproducible but needs the lockfile; fall back when it is absent.
ifeq ($(wildcard package-lock.json),)
install:
	$(NPM) install
else
install:
	$(NPM) ci
endif

setup: check-node install build check
	@echo Environment ready. Run "make link" to put hcm on your PATH.

## ---------------------------------------------------------------- build & run

build:
	$(NPM) run build

dev:
	$(NPM) run dev -- $(ARGS)

run: build
	$(NODE) $(CLI) $(ARGS)

## ---------------------------------------------------------------- quality

test:
	$(NPM) test

test-watch:
	$(NPM) run test:watch

## ---------------------------------------------------------------- readable cases

# The human-readable layer: tests/cases/<name>/{inputs,outputs,README.md}.
# See tests/cases/README.md for what a case is and how to add one.
CASE ?=

test-cases:
	$(NPM) run test:cases

# One case by folder name. `-t` matches the describe, which is the folder name.
test-case:
	$(NPM) run test:case -- "$(CASE)"

# No test framework in the call stack: breakpoints land in src/ three frames in.
debug-case:
	$(NPM) run debug:case -- "$(CASE)"

# Rewrites every baseline from what the code does now. A regenerated baseline is
# a diff a human reads line by line, in a commit that changes nothing else.
bless:
	$(NPM) run bless

typecheck:
	$(NPM) run typecheck

check: typecheck test

audit:
	$(NPM) audit

# Only applies updates that stay within existing semver ranges. A fix needing a
# major bump is reported but not applied -- `npm audit fix --force` can break
# the build, so that stays a deliberate manual step.
audit-fix:
	$(NPM) audit fix

## ---------------------------------------------------------------- distribution

# npm link makes `hcm` resolve to this working copy, so edits take effect
# after a `make build` with no reinstall.
link: build
	$(NPM) link

unlink:
	$(NPM) unlink -g harness-config-manager

pack: check build
	$(NPM) pack

publish: check build
	$(NPM) publish --access public

release: pack
	@echo Tarball built. Inspect it, then run "make publish" to release.

version-patch:
	$(NPM) version patch

version-minor:
	$(NPM) version minor

version-major:
	$(NPM) version major

## ---------------------------------------------------------------- demo

demo: build
	$(NODE) $(CLI) info $(SAMPLE)

## ---------------------------------------------------------------- cleanup

clean:
	$(NODE) -e "const fs=require('fs');fs.rmSync('dist',{recursive:true,force:true});for(const f of fs.readdirSync('.')) if(f.endsWith('.tgz')) fs.rmSync(f,{force:true});console.log('Removed dist/ and any .tgz tarballs')"

distclean: clean
	$(NODE) -e "require('fs').rmSync('node_modules',{recursive:true,force:true});console.log('Removed node_modules/')"

reinstall: distclean setup
