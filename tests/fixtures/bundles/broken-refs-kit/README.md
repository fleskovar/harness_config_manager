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
