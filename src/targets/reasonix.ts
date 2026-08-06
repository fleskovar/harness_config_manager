import os from 'node:os';
import path from 'node:path';
import type { BundleResource, PlanAction, Scope } from '../core/types.js';
import { blockId } from '../merge/blocks.js';
import { renderArrayOfTables, renderToml } from '../merge/toml.js';
import { assetFile, markdownFile, skillFiles } from './shared.js';
import type { Target, TargetContext } from './types.js';
import { toList } from './types.js';

/**
 * Reasonix.
 * https://github.com/esengine/DeepSeek-Reasonix/blob/main-v2/docs/GUIDE.md
 *
 *   .reasonix/agents/<name>.md      reasonix.toml -> [[plugins]] (MCP)
 *   .reasonix/skills/<name>/**      REASONIX.md   -> marker block
 *   .reasonix/commands/<name>.md    reasonix.toml -> [tables] (settings)
 *   .reasonix/rules/<name>.md
 *
 * Reasonix keeps its config in TOML, which has comments -- so unlike the JSON
 * targets we write marker-delimited blocks and never rewrite the whole file.
 */
export const reasonix: Target = {
  id: 'reasonix',
  title: 'Reasonix',
  docs: 'https://github.com/esengine/DeepSeek-Reasonix/blob/main-v2/docs/GUIDE.md',
  supports: ['agent', 'skill', 'command', 'rule', 'context', 'mcp', 'settings', 'asset'],

  scopeRoot(scope: Scope, cwd: string): string {
    return scope === 'user' ? reasonixHome() : cwd;
  },

  actions(resource: BundleResource, ctx: TargetContext): PlanAction[] {
    // At user scope the root is already the Reasonix home directory.
    const base = ctx.scope === 'user' ? '' : '.reasonix/';
    const configFile = ctx.scope === 'user' ? 'config.toml' : 'reasonix.toml';

    switch (resource.kind) {
      case 'agent':
        return [
          markdownFile(`${base}agents/${resource.name}.md`, resource, {
            name: resource.name,
            description: resource.frontmatter.description,
            tools: listOrUndefined(resource.frontmatter.tools),
            model: resource.frontmatter.model,
          }),
        ];

      case 'skill':
        return skillFiles(resource, `${base}skills/${resource.name}`);

      case 'command':
        return [
          markdownFile(`${base}commands/${resource.name}.md`, resource, {
            description: resource.frontmatter.description,
            'argument-hint': resource.frontmatter.argumentHint ?? resource.frontmatter['argument-hint'],
          }),
        ];

      case 'rule': {
        const paths = toList(resource.frontmatter.appliesTo ?? resource.frontmatter.paths);
        return [
          markdownFile(`${base}rules/${resource.name}.md`, resource, {
            description: resource.frontmatter.description,
            paths: paths.length ? paths : undefined,
          }),
        ];
      }

      case 'context':
        return [
          {
            path: 'REASONIX.md',
            describe: `REASONIX.md ← ${resource.name}`,
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
            path: configFile,
            describe: `[[plugins]] ${resource.name}`,
            payload: {
              kind: 'block',
              blockId: blockId(ctx.bundle, `plugins/${resource.name}`),
              syntax: 'toml',
              body: renderArrayOfTables('plugins', toPlugin(resource.name, resource.data)),
            },
          },
        ];

      case 'settings':
        return [
          {
            path: configFile,
            describe: `[${Object.keys(asRecord(resource.data)).join('], [')}]`,
            payload: {
              kind: 'block',
              blockId: blockId(ctx.bundle, `settings/${resource.name}`),
              syntax: 'toml',
              body: renderToml(asRecord(resource.data)),
            },
          },
        ];

      case 'asset':
        return [assetFile(resource, `${base}assets/${resource.name}`)];

      default:
        return [];
    }
  },
};

/** Reasonix home: %AppData%\reasonix on Windows, ~/.reasonix elsewhere. */
export function reasonixHome(): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'reasonix');
  }
  return path.join(os.homedir(), '.reasonix');
}

function listOrUndefined(value: unknown): string[] | undefined {
  const list = toList(value);
  return list.length ? list : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Map a canonical MCP server definition onto a Reasonix `[[plugins]]` entry.
 * TOML has no null, so undefined values are dropped rather than emitted.
 */
function toPlugin(name: string, data: unknown): Record<string, unknown> {
  const server = asRecord(data);
  const plugin: Record<string, unknown> = { name };

  if (typeof server.command === 'string') plugin.command = server.command;
  if (Array.isArray(server.args)) plugin.args = server.args;
  if (typeof server.url === 'string') plugin.url = server.url;
  if (server.env && typeof server.env === 'object') plugin.env = server.env;
  if (typeof server.startupTimeoutSeconds === 'number') {
    plugin.startup_timeout_seconds = server.startupTimeoutSeconds;
  }
  if (typeof server.callTimeoutSeconds === 'number') {
    plugin.call_timeout_seconds = server.callTimeoutSeconds;
  }

  return plugin;
}
