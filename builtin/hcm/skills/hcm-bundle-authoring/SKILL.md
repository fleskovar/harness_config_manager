---
description: Write, check and publish an hcm bundle of subagents, skills, commands, rules, context, MCP servers and settings. Use when the user asks to make an hcm bundle, to add a resource to a bundle, or to fix a problem that hcm validate or hcm refs check reports.
flavors: [authoring]
---

# Write an hcm bundle

A bundle is a folder with an `hcm.yaml` manifest. The name of each subfolder
tells hcm the kind of the resources in it. There is no list of resources to
keep up to date.

The manifest fields and the frontmatter of each kind are in
[the bundle reference](./reference.md).

## Layout

```
my-kit/
├── hcm.yaml                   # name, version, description, and optional fields
├── subagents/<name>.md        # a worker with its own prompt
├── skills/<name>/SKILL.md     # a skill, and its supporting files beside it
├── commands/<name>.md         # a slash command or prompt
├── rules/<name>.md            # instructions for the files that match a glob
├── context/<NN>-<name>.md     # instructions that load in each session, one section per file
├── mcp/<name>.json            # one MCP server per file
├── settings/settings.json     # a settings fragment that hcm merges
└── assets/                    # files that hcm copies without change
```

One file is one resource. The file name is the resource name. For a skill, the
folder name is the resource name.

## Procedure

1. Make the bundle: `hcm init my-kit`. Delete the example resources that you do not need.
2. Write the manifest. `name` and `version` are mandatory. Use a semantic version, for example `1.0.0`.
3. Write each resource in the folder for its kind.
4. Check the bundle: `hcm validate ./my-kit`. Fix each problem that it reports.
5. Check the references: `hcm refs check --path ./my-kit`. Fix each broken reference.
6. Register the bundle in place: `hcm registry add ./my-kit --dev`. Then each install reads your latest edits.
7. Preview the result: `hcm info my-kit`. The output shows the destination of each item in each harness.
8. Test the bundle in an empty folder. See [Test a bundle](#test-a-bundle).
9. Publish the bundle. Push it to GitHub and tag a version. Users then run `hcm registry add owner/repo/path#v1.0.0`.

## Rules for content

- Write each `description` as "what it does, and when to use it". The harness reads the description to decide when to use the subagent or skill.
- Start each context file with a level-2 heading. hcm puts the text into an instruction file that the user owns.
- Keep context short. The harness loads it in each session. Put long instructions in a skill.
- Use one context file for each section. Start each file name with a two-digit number, for example `10-`, to set the order.
- Do not give a subagent, a skill and a command the same name. Some harnesses keep them in one namespace.
- Put a prefix on the names of MCP servers, subagents and commands that belong to a team or product: `acme-postgres`, not `postgres`.
- Do not put secrets in a bundle. In MCP and settings files, refer to an environment variable: `"API_KEY": "${MY_API_KEY}"`.
- Keep settings fragments small. The user cannot change a key that the bundle sets without drift in `hcm status`.

## References between files

Write a path to a file of the bundle as the bundle is laid out, from the bundle
root. A file beside the referring file can also use its plain name. During the
install, hcm changes each path to the location of the file in each harness.

```markdown
Follow `./checklist.md`.                          <- a file beside this SKILL.md
See [the reviewer](subagents/code-reviewer.md).   <- a path from the bundle root
Run `assets/scripts/audit.sh`.                    <- a path from the bundle root
```

- `hcm refs check` reads links, `[[wikilinks]]`, `@paths`, and paths that start with `./` or `../`. It ignores a bare file name in a sentence. Thus, start a path to a file of the bundle with `./`.
- hcm does not change URLs, absolute paths, paths in fenced code blocks, or paths that start with a hidden folder such as `.claude/`.
- A path in an MCP or settings value is resolved by the harness, usually from the project root. Check these paths with `hcm info` before you publish.

## Optional features

Use these features only when the bundle needs them. The full syntax is in
[the bundle reference](./reference.md).

| Feature | Use it when | Manifest key |
| --- | --- | --- |
| Targets | The bundle has no use in some harnesses. | `targets` |
| Dependencies | The bundle needs the content of a different bundle. | `dependencies` |
| Flavors | Users want only part of the bundle, for example one language. | `flavors` |
| Parameters | A value is different in each project, for example a team name. | `parameters` |

## Test a bundle

Run these commands in an empty temporary folder:

```bash
hcm install /path/to/my-kit -t claude-code --no-prompt
hcm status
hcm uninstall my-kit -t claude-code
```

After the uninstall, the folder must be empty. Do these checks too:

- If the bundle has flavors, install each flavor in its own empty folder. Make sure that the common part works without the other flavors.
- If the bundle has dependencies, make sure that the uninstall removes them.
- To see what users get from a new version, run `hcm update my-kit --dry-run`. The output shows the items that the update removes and the items that it writes.

## Ship a bundle with your software

To ship the bundle with a CLI tool, with a library, or as a separate download,
use the `hcm-integration` skill.
