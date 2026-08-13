import os from 'node:os';
import path from 'node:path';
import { renderMarkdown } from '../core/frontmatter.js';
import type { BundleResource, PlanAction, Scope } from '../core/types.js';
import {
  appliesToPrefix,
  assetFile,
  instructionBlock,
  markdownFile,
  settingsActions,
  skillFiles,
} from './shared.js';
import type { Target, TargetContext } from './types.js';
import { compact } from './types.js';

/**
 * OpenCode.
 * https://opencode.ai/docs/config/
 *
 *   .opencode/agents/<name>.md      opencode.json -> mcp.<name>
 *   .opencode/skills/<name>/**      opencode.json -> instructions[]
 *   .opencode/commands/<name>.md    AGENTS.md     -> marker block
 *   .opencode/rules/<name>.md
 *
 * User scope is ~/.config/opencode, which mirrors the project layout without
 * the `.opencode` prefix. Both scopes keep `opencode.json` at the root of the
 * scope, and paths inside it resolve relative to that file -- which is what
 * makes one `instructions` entry work unchanged in either scope.
 *
 * Two things differ from the other harnesses:
 *
 *  - There is no glob-scoped rule format. Extra instruction files are listed in
 *    `instructions`, loaded whole, so a rule becomes a file *plus* an entry in
 *    that array -- appended, never replaced, so bundles do not fight over it.
 *  - Subagent tool access is a `permission` object keyed by OpenCode's own
 *    categories (edit, bash, read, ...), not a list of tool names, so a
 *    canonical `tools:` allowlist has no faithful translation and is dropped.
 *    Restrict tools in the target's own config if you need it.
 */
export const opencode: Target = {
  id: 'opencode',
  title: 'OpenCode',
  docs: 'https://opencode.ai/docs/config/',
  supports: ['subagent', 'skill', 'command', 'rule', 'context', 'mcp', 'settings', 'asset'],

  scopeRoot(scope: Scope, cwd: string): string {
    return scope === 'user' ? opencodeHome() : cwd;
  },

  // Not `AGENTS.md`: Pi reads that too, so it identifies neither of them.
  markers(scope: Scope): string[] {
    return scope === 'user' ? ['.'] : ['.opencode', 'opencode.json'];
  },

  actions(resource: BundleResource, ctx: TargetContext): PlanAction[] {
    // At user scope the root is already ~/.config/opencode, so the prefix goes.
    const base = ctx.scope === 'user' ? '' : '.opencode/';
    const configFile = 'opencode.json';

    switch (resource.kind) {
      // The filename is the agent id, so there is no `name` field to write.
      case 'subagent':
        return [
          markdownFile(`${base}agents/${resource.name}.md`, resource, {
            description: resource.frontmatter.description,
            // Without this the file would define a primary agent -- one you Tab
            // into -- rather than something a primary agent delegates to.
            mode: 'subagent',
            model: resource.frontmatter.model,
            temperature: resource.frontmatter.temperature,
            color: resource.frontmatter.color,
          }),
        ];

      case 'skill':
        return skillFiles(resource, `${base}skills/${resource.name}`);

      // The body is the command template; `$ARGUMENTS` and `$1` work as they do
      // in Claude Code, so it passes through untouched.
      case 'command':
        return [
          markdownFile(`${base}commands/${resource.name}.md`, resource, {
            description: resource.frontmatter.description,
            agent: resource.frontmatter.agent,
            model: resource.frontmatter.model,
            subtask: resource.frontmatter.subtask,
          }),
        ];

      case 'rule': {
        const rulePath = `${base}rules/${resource.name}.md`;
        return [
          {
            path: rulePath,
            describe: rulePath,
            payload: {
              kind: 'file',
              contents: renderMarkdown(
                compact({ description: resource.frontmatter.description }),
                appliesToPrefix(resource) + (resource.body ?? ''),
              ),
            },
          },
          {
            // An array item, so two bundles can list their own rules in the
            // same config and each remove only its own on uninstall.
            path: configFile,
            describe: `instructions[] += ${rulePath}`,
            payload: { kind: 'json-array-item', pointer: ['instructions'], items: [rulePath] },
          },
        ];
      }

      case 'context':
        return [instructionBlock('AGENTS.md', ctx, resource.name, resource.name, resource.body ?? '')];

      case 'mcp':
        return [
          {
            path: configFile,
            describe: `mcp.${resource.name}`,
            payload: {
              kind: 'json-value',
              pointer: ['mcp', resource.name],
              value: toMcpServer(resource.data),
            },
          },
        ];

      case 'settings':
        return settingsActions(resource, configFile);

      case 'asset':
        return [assetFile(resource, `${base}assets/${resource.name}`)];

      default:
        return [];
    }
  },
};

/**
 * OpenCode's config directory: `$OPENCODE_CONFIG_DIR`, else `opencode` under
 * `$XDG_CONFIG_HOME`, else `~/.config/opencode` -- on Windows too, which is
 * why this does not go looking at %APPDATA%.
 */
export function opencodeHome(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  const configRoot = xdg && xdg.trim() ? xdg : path.join(os.homedir(), '.config');
  return path.join(configRoot, 'opencode');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Map a canonical MCP server definition onto OpenCode's shape:
 *
 *   { "type": "local",  "command": ["npx", "-y", "server"], "environment": {} }
 *   { "type": "remote", "url": "https://...", "headers": {} }
 *
 * Two differences from the Claude Code form. `type` is required rather than
 * inferred from `command` vs `url`, and the command is one argv array rather
 * than a command plus `args`. Environment variables are `environment`, not
 * `env`; both spellings are accepted on the way in.
 */
function toMcpServer(data: unknown): unknown {
  const server = asRecord(data);
  if (!server) return data;

  if (typeof server.url === 'string') {
    return compact({
      type: 'remote',
      url: server.url,
      headers: server.headers,
      enabled: server.enabled,
      timeout: server.timeout,
    });
  }

  const args = Array.isArray(server.args) ? server.args.map(String) : [];
  const command = Array.isArray(server.command)
    ? server.command.map(String)
    : typeof server.command === 'string'
      ? [server.command, ...args]
      : undefined;

  return compact({
    type: 'local',
    command,
    cwd: server.cwd,
    environment: server.environment ?? server.env,
    enabled: server.enabled,
    timeout: server.timeout,
  });
}
