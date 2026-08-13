import os from 'node:os';
import path from 'node:path';
import type { BundleResource, PlanAction, Scope } from '../core/types.js';
import {
  appliesToPrefix,
  assetFile,
  instructionBlock,
  joinTools,
  markdownFile,
  settingsActions,
  skillFiles,
} from './shared.js';
import type { Target, TargetContext } from './types.js';

/**
 * Pi.
 * https://pi.dev/docs/latest/quickstart
 * Settings: docs/settings.md. Skills: docs/skills.md.
 * Prompt templates: docs/prompt-templates.md.
 *
 *   .pi/skills/<name>/**      AGENTS.md         -> marker block (context, rules)
 *   .pi/prompts/<name>.md     .pi/settings.json
 *   .pi/agents/<name>.md      .mcp.json         -> mcpServers.<name>
 *     (subagents, with --pi-subagents)
 *
 * User scope is ~/.pi/agent, which mirrors the project layout without the `.pi`
 * prefix -- and holds the global `AGENTS.md`, `skills/` and `prompts/`.
 *
 * Pi is deliberately smaller than the other harnesses: it ships no sub-agents
 * and no built-in MCP client, leaving both to extensions (docs/usage.md). Both
 * kinds still install, using the conventions those extensions build on:
 *
 *  - A subagent becomes a skill, as it does on Reasonix -- `/skill:<name>`
 *    invokes it by name. Pi has no profile-level tool allowlist or model
 *    override to carry, so `tools` and `model` are dropped; and with no
 *    delegation the prompt runs in the main context rather than its own.
 *
 *    Unless `pi-subagents` is installed, that is: with `--pi-subagents` the
 *    subagent is written to `.pi/agents/<name>.md` instead, which is the
 *    directory that extension scans, and `tools` and `model` survive because
 *    it has fields for them. Delegation is real there -- `subagent({ agent })`
 *    spawns a child session. https://github.com/nicobailon/pi-subagents
 *  - MCP servers go to the same `.mcp.json`, in the same `mcpServers` shape,
 *    that every other harness uses -- which is the convention Pi's MCP
 *    extensions read. Inert until one is installed, correct once it is.
 *
 * Like Reasonix, Pi has no per-file rule format either: standing instructions
 * are the `AGENTS.md` hierarchy, so rules join context there.
 */
export const pi: Target = {
  id: 'pi',
  title: 'Pi',
  docs: 'https://pi.dev/docs/latest/quickstart',
  supports: ['subagent', 'skill', 'command', 'rule', 'context', 'mcp', 'settings', 'asset'],
  notes: [
    'subagents install as skills; pass --pi-subagents if the pi-subagents',
    'extension is installed and they will go to agents/ instead',
  ],

  scopeRoot(scope: Scope, cwd: string): string {
    return scope === 'user' ? piHome() : cwd;
  },

  // Everything else Pi uses in a project -- `AGENTS.md`, `.mcp.json` -- it
  // shares with another harness, so `.pi` is the only thing that means Pi.
  markers(scope: Scope): string[] {
    return scope === 'user' ? ['.'] : ['.pi'];
  },

  actions(resource: BundleResource, ctx: TargetContext): PlanAction[] {
    // At user scope the root is already ~/.pi/agent, so the prefix goes.
    const base = ctx.scope === 'user' ? '' : '.pi/';

    switch (resource.kind) {
      // Stock Pi has no agents directory: a subagent is filed as a skill,
      // sharing the directory and the file format. Pi follows the Agent Skills
      // standard (docs/skills.md), whose frontmatter is just `name` and
      // `description` -- so nothing else from the subagent's frontmatter has a
      // home here. With `pi-subagents` installed there is somewhere better.
      case 'subagent':
        return ctx.options.piSubagents
          ? [
              markdownFile(`${base}agents/${resource.name}.md`, resource, {
                name: resource.name,
                description: resource.frontmatter.description,
                // The extension takes a comma-separated list or a YAML block
                // list; the comma form matches what Claude Code is given.
                tools: joinTools(resource.frontmatter.tools),
                model: resource.frontmatter.model,
              }),
            ]
          : [
              markdownFile(`${base}skills/${resource.name}/SKILL.md`, resource, {
                name: resource.name,
                description: resource.frontmatter.description,
              }),
            ];

      case 'skill':
        return skillFiles(resource, `${base}skills/${resource.name}`);

      // Pi calls these prompt templates: `/<name>` expands the body, with the
      // same `$1` / `$ARGUMENTS` substitution the other harnesses use.
      case 'command':
        return [
          markdownFile(`${base}prompts/${resource.name}.md`, resource, {
            description: resource.frontmatter.description,
            'argument-hint': resource.frontmatter.argumentHint ?? resource.frontmatter['argument-hint'],
          }),
        ];

      case 'rule':
        return [
          instructionBlock(
            'AGENTS.md',
            ctx,
            `rules/${resource.name}`,
            resource.name,
            appliesToPrefix(resource) + (resource.body ?? ''),
          ),
        ];

      case 'context':
        return [instructionBlock('AGENTS.md', ctx, resource.name, resource.name, resource.body ?? '')];

      // Pi has no MCP client of its own, but the extensions that add one read
      // the shared `.mcp.json` convention, so the definition is written as-is.
      // At user scope that is `.mcp.json` inside the Pi config directory, which
      // is where Pi resolves its other relative resource paths from.
      case 'mcp':
        return [
          {
            path: '.mcp.json',
            describe: `mcpServers.${resource.name}`,
            payload: {
              kind: 'json-value',
              pointer: ['mcpServers', resource.name],
              value: resource.data,
            },
          },
        ];

      case 'settings':
        return settingsActions(resource, `${base}settings.json`);

      case 'asset':
        return [assetFile(resource, `${base}assets/${resource.name}`)];

      default:
        return [];
    }
  },
};

/**
 * Pi's config directory: `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`
 * (docs/environment-variables.md).
 */
export function piHome(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  return path.join(os.homedir(), '.pi', 'agent');
}
