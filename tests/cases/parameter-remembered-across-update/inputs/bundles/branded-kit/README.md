# branded-kit

A kit that introduces itself by name. Nothing in it is finished until it is
installed: the agent's name, the owning team, the house tone and the model are
all `<%PLACEHOLDERS%>` filled in on the way in.

```bash
hcm install ./branded-kit -t claude-code --param TEAM=Platform --param AGENT_NAME=Ada
```

## What it asks for

| Parameter | Default | Scope | Where it is used |
| --- | --- | --- | --- |
| `AGENT_NAME` | `Claude` | global | context, subagent (body and frontmatter), command, rule, both skill files, settings |
| `TEAM` | — **required** | global | context, subagent, command, both skill files, MCP arguments, asset |
| `TONE` | `direct` | global, one of `direct`/`formal`/`playful` | context, subagent, rule |
| `PYTEST_ARGS` | `-q` | flavor `python` | `skills/pytest-runner/SKILL.md`, `assets/run-tests.sh` |
| `CLAUDE_MODEL` | `sonnet` | harness `claude-code` | context |
| `API_TOKEN` | `unset` | global, **secret** | `mcp/reporter.json` env |

`TEAM` is the only one with no default, so it is the only one an install has to
be told. Everything else has an answer already, which is what makes

```bash
hcm install ./branded-kit -t claude-code --param TEAM=Platform
```

a complete command with no terminal attached.

## The three points the fixture exists to make

**A narrowed parameter still fills its hole.** `CLAUDE_MODEL` is only *asked*
for on Claude Code, but `context/10-identity.md` mentions it and every harness
gets that file. Installing into Copilot therefore writes `Prefer the sonnet
model` — the default — rather than leaving `<%CLAUDE_MODEL%>` in the text. Give
it no default and `hcm validate` reports exactly that risk.

**A secret is used but not written down.** `API_TOKEN` reaches
`.mcp.json`, and the installation record in `.hcm/state.json` has no trace of
it. That is why `hcm update` has to be given it again.

**An escaped placeholder survives.** `subagents/reviewer.md` ends with
`<%%AGENT_NAME%>`, which installs as the literal `<%AGENT_NAME%>` — how a
bundle documents this feature without its own examples being filled in.

## Working it out by hand

```bash
npx tsx src/cli.ts info ./tests/fixtures/bundles/branded-kit --param TEAM=Platform
```

Before you run it: `TONE` is `direct` and `AGENT_NAME` is `Claude`, so the
first line of the installed `CLAUDE.md` block reads *You are a coding agent
called Claude, working on a project owned by the Platform team.*
