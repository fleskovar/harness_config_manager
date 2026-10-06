## hcm

hcm (harness-config-manager) manages the agent configuration of this project.
hcm writes subagents, skills, commands, rules, MCP servers and settings into the
harness folders, for example `.claude/`, `.github/` and `.pi/`.

- Do not edit a file that hcm installed. Change the bundle that supplies it, then run `hcm update <bundle>`.
- An edit to an installed file stops `hcm update` and `hcm uninstall` for that bundle.
- To see the files that hcm installed, and the files that changed after the install, run `hcm status`.
- hcm keeps its sections of this file between `hcm:begin` and `hcm:end` comments. Keep these comments when you edit this file.
- If an hcm section is missing from this file, run `hcm context append`.
- Do not edit the `.hcm/` folder. It holds the install ledger.
- For a task about hcm, use the `hcm-usage`, `hcm-bundle-authoring` or `hcm-integration` skill.
