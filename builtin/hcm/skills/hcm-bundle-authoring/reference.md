# hcm bundle reference

## Manifest: `hcm.yaml`

```yaml
name: my-kit                  # mandatory; also a file name, so use letters, digits and dashes
version: 1.0.0                # mandatory; a semantic version
description: What the bundle is for, and when to install it
author: Your Name
homepage: https://github.com/acme/my-kit
tags: [review, typescript]
targets: [claude-code, pi]    # optional; omit it to support all harnesses
dependencies: [jira-board@^1.2.0]
flavors:
  python: Python tooling
parameters:
  TEAM:
    description: The team that owns the project
```

The harness ids are `claude-code`, `copilot`, `copilot-cli`, `reasonix`,
`opencode` and `pi`. hcm refuses to install a bundle into a harness that
`targets` does not list.

## Resource kinds

### Subagent: `subagents/<name>.md`

```markdown
---
description: Reviews changed code for correctness. Use before you open a pull request.
tools: [Read, Grep, Glob, Bash]
model: sonnet
---

You are a code reviewer...
```

- The body is the system prompt.
- `name` in the frontmatter replaces the file name as the subagent name.
- hcm changes the shape of `tools` for each harness. It does not change the tool names. OpenCode and Pi without the `pi-subagents` extension do not use `tools`.
- Reasonix and Pi keep a subagent as a skill. Thus a subagent and a skill with the same name collide there.

### Skill: `skills/<name>/SKILL.md`

```markdown
---
description: Audits dependencies for known vulnerabilities. Use before a release.
---

Work through `./checklist.md`, then report the results.
```

- hcm copies all files in the skill folder. It changes only the frontmatter of `SKILL.md`.
- Put long reference material in supporting files beside `SKILL.md`, and link to them.

### Command: `commands/<name>.md`

```markdown
---
description: Review the current branch against a base branch
argumentHint: "[base-branch]"
allowedTools: [Read, Grep, Bash]
---

Review this branch against `$ARGUMENTS`.
```

Copilot CLI has no folder for commands, so hcm writes a command there as a
skill. Thus a command and a skill with the same name collide there.

### Rule: `rules/<name>.md`

```markdown
---
description: TypeScript conventions
appliesTo: ["**/*.ts", "**/*.tsx"]
---

- Use named exports.
```

Without `appliesTo`, the rule loads in each session. Reasonix, OpenCode and Pi
have no glob-scoped rules. There, the rule loads in each session, with the globs
written as text. Keep rules short.

### Context: `context/<NN>-<name>.md`

Each file becomes one section of the instruction file of the harness:
`CLAUDE.md`, `.github/copilot-instructions.md`, `REASONIX.md` or `AGENTS.md`.
Start each file with a level-2 heading. The file names set the order of the
sections. If you rename a context file, the old section stays in the projects
of your users until they run `hcm update`.

### MCP server: `mcp/<name>.json`

```json
{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
```

```json
{ "url": "https://mcp.example.com", "headers": { "Authorization": "Bearer ${EXAMPLE_TOKEN}" } }
```

The file name is the server name. The keys are `command`, `args`, `env`, `type`,
`url`, `headers`, `startupTimeoutSeconds`, `callTimeoutSeconds` and
`toolTimeoutSeconds`. hcm writes `${VAR}` references without change. Each
harness expands them.

### Settings: `settings/<name>.json`

```json
{ "permissions": { "allow": ["Bash(npm test:*)"] } }
```

hcm merges the fragment into the settings file of the harness. hcm adds array
items to the existing array. A scalar value that is already there with a
different value is a conflict.

### Assets: `assets/**`

hcm copies these files without change. Use them for scripts, templates and
images that other resources refer to.

## Dependencies

```yaml
dependencies:
  - jira-board                     # any version
  - team-conventions@^2.0.0        # a version range
  - name: db-kit                   # the long form
    version: ">=2.1 <3"
    source: acme/agent-kits/db-kit # a GitHub reference or a relative path
```

- hcm looks for a dependency in this order: the bundles of the same run, the registry, a folder beside the bundle, and then `source`.
- Give a `source` for each dependency of a published bundle. Other machines do not have your registry.
- The version ranges are `1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2.3`, `1.2.x` and `*`. A space means "and". `||` means "or".
- Only one version of a bundle can be in a scope. Use wide ranges.
- Every hcm installation has the built-in bundle `hcm`. A bundle can require it by name.

## Flavors

A resource in no flavor is common, and it installs each time. A resource in a
flavor installs only when the user asks for that flavor, or asks for no flavor.

A markdown resource names its flavors in its frontmatter:

```markdown
---
description: Runs pytest and reports the failures.
flavors: [python]
---
```

The manifest names the other resources by path. A folder path includes all the
files in the folder. `*`, `**` and `?` are wildcards.

```yaml
flavors:
  python:
    description: Python typing, linting and test tooling
    includes:
      - mcp/pyright.json
      - assets/python
  csharp: C# analyzers
```

`all` is not a valid flavor name. `hcm validate` reports a flavor that a
resource names and the manifest does not declare.

## Parameters

A placeholder in the text of a resource gets a value at install time:

```markdown
You work for the <%%TEAM%> team.
```

```yaml
parameters:
  TEAM:
    description: The team that owns the project   # the help text for the user
    default: Platform           # also the suggested answer
    required: false             # true by default when there is no default
    choices: [Platform, Data]   # the value must be one of these
    pattern: '^[A-Za-z ]+$'     # the value must match this regular expression
    secret: false               # true: hcm does not record the value
    flavors: [python]           # ask only when this flavor is installed
    targets: [claude-code]      # ask only for this harness
```

- hcm fills placeholders in markdown, frontmatter, context, all skill files, string values of MCP and settings files, and text assets. It never fills a placeholder in a path.
- To write a literal placeholder, double the first `%`.
- Give a default to each parameter that can have one.
- `hcm validate` reports a placeholder with no declared parameter, a parameter that no file uses, and a placeholder in a `name:` field.
