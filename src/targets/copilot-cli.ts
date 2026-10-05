import os from 'node:os';
import path from 'node:path';
import type { BundleResource, PlanAction, Scope } from '../core/types.js';
import {
  assetFile,
  instructionBlock,
  markdownFile,
  settingsActions,
  skillFiles,
} from './shared.js';
import type { Target, TargetContext } from './types.js';
import { compact, toList } from './types.js';

/**
 * GitHub Copilot CLI.
 * https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/overview
 * Config directory: docs/reference/copilot-cli-reference/cli-config-dir-reference.
 * Plugins: docs/concepts/agents/about-plugins.
 *
 *   .github/agents/<name>.agent.md               .github/mcp.json -> mcpServers.<name>
 *   .github/skills/<name>/**                     .github/copilot-instructions.md
 *   .github/instructions/<name>.instructions.md  .github/copilot/settings.json
 *
 * User scope is `$COPILOT_HOME`, else `~/.copilot` -- the CLI's own directory,
 * which mirrors the repository layout without the `.github` prefix and holds
 * `mcp-config.json`, `settings.json` and `copilot-instructions.md` at its root.
 *
 * This is a different harness from `copilot`, which is Copilot in the IDE, and
 * the two deliberately overlap: both read `.github/agents/`, `.github/skills/`,
 * `.github/instructions/` and `.github/copilot-instructions.md` out of a
 * repository, so a bundle installed into one is visible to the other. What they
 * do *not* share is where the servers are declared -- the CLI reads
 * `.github/mcp.json` and `~/.copilot/mcp-config.json`, the IDE reads
 * `.vscode/mcp.json` -- which is why this is its own adapter rather than a flag
 * on that one. `core/overlap.ts` reports the files they share.
 *
 * Two things differ from the other harnesses:
 *
 *  - There is no standalone commands directory. `.github/prompts/*.prompt.md`
 *    is an IDE feature, and the CLI's own slash commands ship inside plugins,
 *    under `com.github.copilot/commands/` -- a packaging format, not a place to
 *    install one file into. A skill is the thing the CLI loads and is invoked
 *    by name (`/<name>`), so a command becomes a one-file skill.
 *  - `mcp-config.json` keys servers under `mcpServers` as Claude Code does, but
 *    wants `type` spelled out. `tools` defaults to every tool, so an entry that
 *    does not restrict them is written without one.
 */
export const copilotCli: Target = {
  id: 'copilot-cli',
  title: 'GitHub Copilot CLI',
  docs: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/overview',
  supports: ['subagent', 'skill', 'command', 'rule', 'context', 'mcp', 'settings', 'asset'],
  notes: [
    'commands install as skills, which is how the CLI invokes a prompt by name;',
    'it shares .github/agents, .github/skills and .github/instructions with',
    'Copilot in the IDE',
  ],

  scopeRoot(scope: Scope, cwd: string): string {
    return scope === 'user' ? copilotHome() : cwd;
  },

  /**
   * Every repository directory the CLI reads is read by Copilot in the IDE too,
   * so none of them says which of the two a folder is set up for. The one
   * project file that is the CLI's alone is `.github/mcp.json`: the IDE keeps
   * its servers in `.vscode/mcp.json`.
   *
   * At user scope the config directory itself is the evidence, as it is for
   * every harness whose user root is its own directory.
   */
  markers(scope: Scope): string[] {
    return scope === 'user' ? ['.'] : ['.github/mcp.json'];
  },

  actions(resource: BundleResource, ctx: TargetContext): PlanAction[] {
    // At user scope the root is already ~/.copilot, so the .github prefix goes.
    const base = ctx.scope === 'user' ? '' : '.github/';

    switch (resource.kind) {
      case 'subagent':
        return [
          markdownFile(`${base}agents/${resource.name}.agent.md`, resource, {
            name: resource.name,
            description: resource.frontmatter.description,
            // The agent format takes a comma-separated string or a YAML list;
            // the list is what the documented examples use.
            tools: listOrUndefined(resource.frontmatter.tools),
            model: resource.frontmatter.model,
          }),
        ];

      case 'skill':
        return skillFiles(resource, `${base}skills/${resource.name}`);

      // No commands directory outside a plugin, so the command is filed as a
      // skill -- the same directory and the same file format, invoked the same
      // way. `argument-hint` has no field here and is dropped; an allowlist
      // does have one, under the name the Agent Skills frontmatter gives it.
      case 'command':
        return [
          markdownFile(`${base}skills/${resource.name}/SKILL.md`, resource, {
            name: resource.name,
            description: resource.frontmatter.description,
            'allowed-tools': listOrUndefined(
              resource.frontmatter.allowedTools ?? resource.frontmatter['allowed-tools'],
            ),
          }),
        ];

      case 'rule': {
        const globs = toList(resource.frontmatter.appliesTo ?? resource.frontmatter.paths);
        return [
          markdownFile(`${base}instructions/${resource.name}.instructions.md`, resource, {
            description: resource.frontmatter.description,
            // One comma-separated glob string, as the IDE wants; '**' is every file.
            applyTo: globs.length ? globs.join(', ') : '**',
          }),
        ];
      }

      // The CLI reads AGENTS.md as well, and treats it as the primary
      // instructions -- but OpenCode and Pi read that same file, while
      // `copilot-instructions.md` is Copilot's own and is loaded in full. So
      // context goes where it cannot be mistaken for another harness's.
      case 'context':
        return [
          instructionBlock(
            `${base}copilot-instructions.md`,
            ctx,
            resource.name,
            resource.name,
            resource.body ?? '',
          ),
        ];

      case 'mcp':
        return [
          {
            // `mcp-config.json` at user scope; in a repository the CLI reads
            // `.github/mcp.json`, which is the one MCP file the IDE does not.
            path: ctx.scope === 'user' ? 'mcp-config.json' : '.github/mcp.json',
            describe: `mcpServers.${resource.name}`,
            payload: {
              kind: 'json-value',
              pointer: ['mcpServers', resource.name],
              value: toCliServer(resource.data),
            },
          },
        ];

      // `config.json` beside it is state the CLI manages itself -- auth,
      // trusted folders, installed plugins -- and is not ours to write.
      case 'settings':
        return settingsActions(
          resource,
          ctx.scope === 'user' ? 'settings.json' : '.github/copilot/settings.json',
        );

      case 'asset':
        return [assetFile(resource, `${base}assets/${resource.name}`)];

      default:
        return [];
    }
  },
};

/**
 * The Copilot CLI config directory: `$COPILOT_HOME`, else `~/.copilot`
 * (docs/reference/copilot-cli-reference/cli-config-dir-reference).
 */
export function copilotHome(): string {
  if (process.env.COPILOT_HOME) return process.env.COPILOT_HOME;
  return path.join(os.homedir(), '.copilot');
}

function listOrUndefined(value: unknown): string[] | undefined {
  const list = toList(value);
  return list.length ? list : undefined;
}

/**
 * Map a canonical MCP server definition onto the CLI's shape:
 *
 *   { "type": "local", "command": "npx", "args": [...], "env": {} }
 *   { "type": "http",  "url": "https://...", "headers": {} }
 *
 * The keying (`mcpServers.<name>`) and the `command` / `args` split are Claude
 * Code's, so only `type` has to be supplied -- `local` or `http`, not the
 * `stdio` the IDE infers. `tools` is passed through when the bundle restricts
 * them and left out when it does not, because the CLI's own default is every
 * tool and writing it out would say the same thing less clearly.
 */
function toCliServer(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const server = { ...(data as Record<string, unknown>) };

  if (typeof server.url === 'string') {
    return compact({
      type: server.type ?? 'http',
      url: server.url,
      headers: server.headers,
      tools: server.tools,
    });
  }

  return compact({
    type: server.type ?? 'local',
    command: server.command,
    args: server.args,
    env: server.env,
    tools: server.tools,
  });
}
