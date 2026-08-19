# broken-refs-kit

A sample bundle for `hcm refs check` and `hcm refs fix`. Four of its references
point at files that are not there; every other path in it is either correct or
something the checker is supposed to leave alone.

What it ships:

| Kind | File |
| --- | --- |
| subagent | `subagents/code-reviewer.md` |
| skill | `skills/release-audit/SKILL.md` |
| command | `commands/review-pr.md` |
| rule | `rules/typescript.md` |
| mcp | `mcp/formatter.json` |

After installation those land in `.claude/agents/`, `.claude/skills/` and
`.claude/commands/` — paths rooted at a hidden directory, which the checker
ignores because no bundle ships one.

The names in the table above are written as plain inline code and are *not*
references: a bare filename in a sentence is prose, whoever wrote it. The four
broken references are written as links, as wikilinks, or with an explicit `./`
or `../` in front of them, which is what tells the checker they were meant as
references at all.
