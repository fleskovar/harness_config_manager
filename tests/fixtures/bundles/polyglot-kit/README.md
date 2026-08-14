# polyglot-kit

A review kit that covers Python and C#, and can be installed a language at a
time.

```bash
hcm install ./polyglot-kit --flavor python -t claude-code
```

| Resource | Flavor | Said where |
| --- | --- | --- |
| `subagents/code-reviewer.md` | — | common |
| `commands/review-pr.md` | — | common |
| `skills/pr-checklist/` | — | common |
| `context/10-conventions.md` | — | common |
| `settings/settings.json` | — | common |
| `subagents/python-typer.md` | python | its own frontmatter |
| `skills/pytest-runner/` | python | its own frontmatter |
| `rules/python.md` | python | `includes` in the manifest |
| `mcp/pyright.json` | python | `includes` in the manifest |
| `assets/python/lint.sh` | python | `includes: assets/python` — a directory |
| `subagents/csharp-analyzer.md` | csharp | its own frontmatter |
| `rules/csharp.md` | csharp | `includes` in the manifest |

Five common resources, five Python, two C#.
