# Test fixtures

Real bundles and real projects, checked in as files.

The rest of the suite builds its bundles from strings inside the test. These do
not: everything here is a directory you can open, read, and run `hcm` against by
hand. That is the point. A test that asserts `hcm` found four broken references
is only worth as much as your ability to check that there really are four — so
each fixture is small enough to solve yourself, and this file is the answer key.

Nothing here is modified by the tests. Each one is copied into a temp directory
first, so you can run destructive commands against these files as often as you
like: `git checkout` puts them back.

## What is here

| Fixture | Used by | What it is |
| --- | --- | --- |
| `bundles/review-kit` | `install-fixtures`, `conflicts-fixtures`, `context-fixtures`, `lifecycle-fixtures` | A healthy bundle: one resource of every kind, with references between them |
| `bundles/review-kit-v2` | `lifecycle-fixtures` | The same bundle one version on — diff it against `review-kit` |
| `bundles/broken-refs-kit` | `refs-fixtures` | Four broken references, and a pile of paths that only look broken |
| `bundles/polyglot-kit` | `flavors` | One kit, two languages: five common resources, five Python, two C# |
| `bundles/invalid-kit` | `lifecycle-fixtures` | Three mistakes `hcm validate` is supposed to name |
| `collections/sprint-collection` | `deps-fixtures` | `sprint-kit`, the `team-conventions` it requires, and a skill they both ship |
| `projects/existing-setup` | `conflicts-fixtures` | A project with its own MCP servers and a hand-written `CLAUDE.md` |
| `projects/adopted-setup` | `conflicts-fixtures` | A project that already has exactly the server review-kit would write |
| `projects/agent-rewritten` | `context-fixtures` | `CLAUDE.md` as a coding agent leaves it after rewriting the file |

## The per-harness fixtures next door

The five `tests/target-<harness>/` folders work the same way but keep their
fixtures to themselves: each holds `input/sample-kit` (the same bundle in all
five, one resource of every kind), `expected/` (the whole tree that bundle has
to produce in that harness), and the test that installs one and compares it
against the other. Nothing is shared between them, so a folder can be read —
or diffed against its neighbour — on its own:

```bash
diff -r tests/target-claude-code/expected tests/target-pi/expected
```

Every difference that prints is something the two harnesses genuinely disagree
about, and the "Where things land" table in the top-level README says what.
Changing the sample bundle means changing it in all five and regenerating each
`expected/`, which is the price of each folder standing alone.

## Solving the reference one by hand

```bash
npx tsx src/cli.ts refs check --path tests/fixtures/bundles/broken-refs-kit
```

Before you run it: open the bundle and find the references that point at
nothing. There are four, and each has one obvious answer.

| Where | It says | It meant | Why |
| --- | --- | --- | --- |
| `commands/review-pr.md`, line 8 | `context/conventions.md` | `context/10-conventions.md` | `context/` holds `10-conventions.md` and `20-pull-requests.md`; only one is about conventions |
| `mcp/formatter.json`, line 3 | `assets/format.sh` | `assets/format-code.sh` | `assets/` holds exactly one file |
| `skills/release-audit/SKILL.md`, line 7 | `checklist.md` | `skills/release-audit/release-checklist.md` | The skill's own directory holds `release-checklist.md` |
| `subagents/code-reviewer.md`, line 11 | `rules/typescrpt.md` | `rules/typescript.md` | A typo, one letter out |

Suggestions are written from the bundle root, which is why the third answer
carries its whole path. Both readings resolve, so `release-checklist.md` on its
own would have worked too.

The same file also contains six paths that are **not** broken references, and
`refs check` must stay quiet about every one of them: a path inside a fenced
code block, a URL, `package.json` and `tsconfig.json` mentioned in prose, the
`.claude/…` install paths in the README, and one reference that is simply
correct. If a change to the scanner starts reporting those, the test fails.

To watch the repair happen, copy the bundle somewhere first — `refs fix`
rewrites the files it is given:

```bash
cp -r tests/fixtures/bundles/broken-refs-kit /tmp/kit
npx tsx src/cli.ts refs fix --path /tmp/kit --write /tmp/fixes.json
# delete the wrong candidates, leaving one per entry
npx tsx src/cli.ts refs fix --path /tmp/kit --file /tmp/fixes.json
```

## Solving the install one by hand

```bash
mkdir /tmp/project && cd /tmp/project
npx tsx <repo>/src/cli.ts install <repo>/tests/fixtures/bundles/review-kit -t claude-code
find . -type f
```

Every file that appears is in the table under "Where things land" in the
top-level README, and the test asserts that exact list. Two things are worth
checking by eye afterwards:

**The frontmatter changed shape.** `tools` was a YAML list in the bundle and is
a comma-separated string in `.claude/agents/code-reviewer.md`; the rule's
`appliesTo` came out as `paths`. Install into `-t copilot` instead and both
answers are different again.

**The references were repointed.** In the bundle, `SKILL.md` names
`subagents/code-reviewer.md`. Work out for yourself what that path has to say
once the skill is at `.claude/skills/dependency-audit/SKILL.md` and the subagent
is at `.claude/agents/code-reviewer.md` — up two, then down one — and compare it
against the installed file.

## The others, in one line each

- **Dependencies.** `skills/jira-board/SKILL.md` is byte-for-byte identical in
  `sprint-kit` and `team-conventions` (`diff` them). Install `sprint-kit` and
  the file is written once and claimed by both; their allow-lists ask for one
  permission each plus one in common, so three entries appear, not four.
- **Conflicts.** `projects/adopted-setup/.mcp.json` holds the same server
  review-kit ships, with the keys in a different order and a different indent:
  it should be adopted, and the file should not be rewritten at all. Compare it
  with `projects/existing-setup/.mcp.json`, which points `filesystem` at
  `/srv/docs` — a genuine collision, and the only thing in that project hcm may
  ask about.
- **Context.** `projects/agent-rewritten/CLAUDE.md` has lost both of hcm's
  marker blocks, but the *text* of the pull-requests section survived. So
  `hcm context append` has one section to put back and one to leave alone —
  appending the second would say the same thing twice.
- **Update.** `diff -r bundles/review-kit bundles/review-kit-v2`: a renamed
  subagent, a deleted context section, one added checklist line. After
  `hcm update` the harness has to show all three, including the disappearance.
- **Validate.** `bundles/invalid-kit` has a subagent with no description, an MCP
  server with no command, and a subagent and skill sharing the name `helper`.
  Three problems, and `hcm validate` names three.

## Solving the flavors one by hand

```bash
mkdir /tmp/py && cd /tmp/py
npx tsx <repo>/src/cli.ts install <repo>/tests/fixtures/bundles/polyglot-kit \
  --flavor python -t claude-code
find . -type f
```

`polyglot-kit` has twelve resources. Before you run it, work out from the bundle
which of them a Python install writes — its own README is the answer key, but the
bundle says the same thing in two different places and that is the point of the
fixture:

- Five resources are tagged in **their own frontmatter** (`flavors: [python]` in
  `subagents/python-typer.md`, `skills/pytest-runner/SKILL.md`, and the two C#
  files).
- Four are tagged **by the manifest**, because `mcp/`, `rules/` and `assets/`
  files either have no frontmatter or read better named in one place. Note that
  `includes: assets/python` is a *directory*, and takes `lint.sh` inside it.
- The remaining five are in no flavor at all, so they install either way.

Then install `--flavor csharp` into another directory and diff the two. The five
common files should be byte-identical, and `.mcp.json` should not exist at all in
the C# one — the only MCP server in the kit belongs to the Python flavor.
