import os from 'node:os';
import path from 'node:path';
import type { BundleResource, PlanAction, Scope } from '../core/types.js';
import { blockId } from '../merge/blocks.js';
import { assetFile, markdownFile, settingsActions, skillFiles } from './shared.js';
import type { Target, TargetContext } from './types.js';
import { toList } from './types.js';

/**
 * GitHub Copilot.
 * https://awesome-copilot.github.com/learning-hub/copilot-configuration-basics/
 *
 *   .github/agents/<name>.agent.md          .vscode/mcp.json -> servers.<name>
 *   .github/skills/<name>/**                .github/copilot-instructions.md
 *   .github/prompts/<name>.prompt.md        .github/copilot/settings.json
 *   .github/instructions/<name>.instructions.md
 *
 * User scope maps to ~/.copilot, which holds personal agents and skills.
 */
export const copilot: Target = {
  id: 'copilot',
  title: 'GitHub Copilot',
  docs: 'https://awesome-copilot.github.com/learning-hub/copilot-configuration-basics/',
  supports: ['subagent', 'skill', 'command', 'rule', 'context', 'mcp', 'settings', 'asset'],

  scopeRoot(scope: Scope, cwd: string): string {
    return scope === 'user' ? path.join(os.homedir(), '.copilot') : cwd;
  },

  // `.github` on its own means nothing -- every repository has one -- so the
  // markers are the directories inside it that only Copilot reads.
  markers(scope: Scope): string[] {
    return scope === 'user'
      ? ['.']
      : [
          '.github/agents',
          '.github/prompts',
          '.github/instructions',
          '.github/skills',
          '.github/copilot',
          '.github/copilot-instructions.md',
          '.vscode/mcp.json',
        ];
  },

  actions(resource: BundleResource, ctx: TargetContext): PlanAction[] {
    // At user scope the root is already ~/.copilot, so we drop the .github prefix.
    const base = ctx.scope === 'user' ? '' : '.github/';

    switch (resource.kind) {
      case 'subagent':
        return [
          markdownFile(`${base}agents/${resource.name}.agent.md`, resource, {
            name: resource.name,
            description: resource.frontmatter.description,
            // Copilot agent files take a YAML list of tools.
            tools: listOrUndefined(resource.frontmatter.tools),
            model: resource.frontmatter.model,
          }),
        ];

      case 'skill':
        return skillFiles(resource, `${base}skills/${resource.name}`);

      case 'command':
        return [
          markdownFile(`${base}prompts/${resource.name}.prompt.md`, resource, {
            description: resource.frontmatter.description,
            mode: resource.frontmatter.mode ?? 'agent',
            tools: listOrUndefined(resource.frontmatter.allowedTools ?? resource.frontmatter.tools),
            model: resource.frontmatter.model,
          }),
        ];

      case 'rule': {
        const globs = toList(resource.frontmatter.appliesTo ?? resource.frontmatter.paths);
        return [
          markdownFile(`${base}instructions/${resource.name}.instructions.md`, resource, {
            description: resource.frontmatter.description,
            // Copilot expects a single comma-separated glob string; '**' means all files.
            applyTo: globs.length ? globs.join(', ') : '**',
          }),
        ];
      }

      case 'context':
        return [
          {
            path: `${base}copilot-instructions.md`,
            describe: `copilot-instructions.md ← ${resource.name}`,
            payload: {
              kind: 'block',
              blockId: blockId(ctx.bundle, resource.name),
              syntax: 'markdown',
              body: resource.body ?? '',
            },
          },
        ];

      case 'mcp':
        return [
          {
            // VS Code Copilot reads MCP servers from .vscode/mcp.json under `servers`.
            path: ctx.scope === 'user' ? 'mcp.json' : '.vscode/mcp.json',
            describe: `servers.${resource.name}`,
            payload: {
              kind: 'json-value',
              pointer: ['servers', resource.name],
              value: toCopilotServer(resource.data),
            },
          },
        ];

      case 'settings':
        return settingsActions(resource, ctx.scope === 'user' ? 'config.json' : '.github/copilot/settings.json');

      case 'asset':
        return [assetFile(resource, `${base}assets/${resource.name}`)];

      default:
        return [];
    }
  },
};

function listOrUndefined(value: unknown): string[] | undefined {
  const list = toList(value);
  return list.length ? list : undefined;
}

/**
 * Copilot's MCP entries use `type: 'stdio' | 'http'` where Claude infers it
 * from the presence of `command` vs `url`. Fill it in when it is missing.
 */
function toCopilotServer(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const server = { ...(data as Record<string, unknown>) };
  if (!server.type) server.type = typeof server.url === 'string' ? 'http' : 'stdio';
  return server;
}
