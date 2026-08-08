import path from 'node:path';
import { HcmError } from '../core/errors.js';
import { pathExists, writeText } from '../core/fsx.js';
import { color, log } from '../core/logger.js';

/** Scaffold a minimal but complete bundle so the layout is self-evident. */
export async function initCommand(
  directory: string,
  options: { name?: string; cwd: string },
): Promise<void> {
  const root = path.resolve(options.cwd, directory);
  const name = options.name ?? path.basename(root);

  if (await pathExists(path.join(root, 'hcm.yaml'))) {
    throw new HcmError(`A bundle already exists at ${root}`);
  }

  const files: Record<string, string> = {
    'hcm.yaml': `name: ${name}
version: 0.1.0
description: A harness config bundle
# Omit "targets" to support all of them.
# targets: [claude-code, copilot, reasonix]
`,

    'README.md': `# ${name}

Install with:

\`\`\`bash
hcm registry add ./${path.basename(root)}
hcm install ${name}
\`\`\`
`,

    'subagents/example-subagent.md': `---
description: Describe when this subagent should be delegated to
tools: [Read, Grep, Glob]
---

You are a specialised assistant. Describe the subagent's behaviour here; this
body becomes its system prompt.
`,

    'commands/example-command.md': `---
description: What this slash command does
argumentHint: "[file]"
---

Perform the task described here, using $ARGUMENTS when provided.
`,

    'rules/example-rule.md': `---
description: Conventions for TypeScript files
appliesTo:
  - "**/*.ts"
  - "**/*.tsx"
---

- Prefer named exports.
- Keep functions under 50 lines.
`,

    'context/project.md': `## ${name}

Instructions that should load in every session go here. They are merged into
CLAUDE.md / copilot-instructions.md / REASONIX.md inside a marker block, so
uninstalling removes exactly this section.
`,

    'mcp/example-server.json': `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
}
`,

    'settings/settings.json': `{
  "permissions": {
    "allow": ["Read(**)"]
  }
}
`,
  };

  for (const [relativePath, contents] of Object.entries(files)) {
    await writeText(path.join(root, ...relativePath.split('/')), contents);
  }

  log.success(`Created bundle ${color.bold(name)} at ${root}`);
  log.info(color.dim(`Next: hcm registry add ${directory} && hcm info ${name}`));
}
