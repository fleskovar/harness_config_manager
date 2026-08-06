# ts-review-kit

A sample bundle showing every resource kind `hcm` understands.

| Resource | File | Becomes |
| --- | --- | --- |
| agent | `agents/code-reviewer.md` | `.claude/agents/`, `.github/agents/`, `.reasonix/agents/` |
| skill | `skills/dependency-audit/` | `.claude/skills/`, `.github/skills/`, `.reasonix/skills/` |
| command | `commands/review-pr.md` | `.claude/commands/`, `.github/prompts/`, `.reasonix/commands/` |
| rule | `rules/typescript.md` | `.claude/rules/`, `.github/instructions/`, `.reasonix/rules/` |
| context | `context/conventions.md` | `CLAUDE.md`, `.github/copilot-instructions.md`, `REASONIX.md` |
| mcp | `mcp/filesystem.json` | `.mcp.json`, `.vscode/mcp.json`, `reasonix.toml` |
| settings | `settings/settings.json` | `.claude/settings.json`, `.github/copilot/settings.json`, `reasonix.toml` |

## Try it

```bash
hcm registry add ./bundles/ts-review-kit
hcm info ts-review-kit                 # see where every item would land
hcm install ts-review-kit --dry-run    # confirm without writing
hcm install ts-review-kit -t claude-code
hcm uninstall ts-review-kit -t claude-code
```
