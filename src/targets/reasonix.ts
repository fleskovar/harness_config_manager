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
 * Config schema: docs/SPEC.md section 5 (Configuration TOML).
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
  supports: ['subagent', 'skill', 'command', 'rule', 'context', 'mcp', 'settings', 'asset'],

  scopeRoot(scope: Scope, cwd: string): string {
    return scope === 'user' ? reasonixHome() : cwd;
  },

  actions(resource: BundleResource, ctx: TargetContext): PlanAction[] {
    // At user scope the root is already the Reasonix home directory.
    const base = ctx.scope === 'user' ? '' : '.reasonix/';
    const configFile = ctx.scope === 'user' ? 'config.toml' : 'reasonix.toml';

    switch (resource.kind) {
      case 'subagent':
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

/** Read a canonical field written in either camelCase or snake_case. */
function field(server: Record<string, unknown>, camel: string, snake: string): unknown {
  return server[camel] ?? server[snake];
}

/**
 * Map a canonical MCP server definition onto a Reasonix `[[plugins]]` entry,
 * per docs/SPEC.md section 5:
 *
 *   [[plugins]]
 *   name = "example"
 *   command = "reasonix-plugin-example"
 *   args = []
 *   env = { FOO = "bar" }
 *   type = "stdio"   # stdio (default) | http | sse
 *   url = "https://mcp.stripe.com"
 *   headers = { Authorization = "Bearer ${STRIPE_KEY}" }
 *   startup_timeout_seconds = 60
 *   call_timeout_seconds = 600
 *   tool_timeout_seconds = { generate_video = 1800 }
 *
 * `${VAR}` expansion is Reasonix's job, so values pass through untouched.
 * TOML has no null, so absent values are omitted rather than emitted empty.
 */
function toPlugin(name: string, data: unknown): Record<string, unknown> {
  const server = asRecord(data);
  const plugin: Record<string, unknown> = { name };

  // Transport. stdio is the documented default, so it is left implicit; http
  // and sse must be stated or Reasonix would try to spawn a command.
  const declared = server.type;
  const type =
    typeof declared === 'string' ? declared : typeof server.url === 'string' ? 'http' : 'stdio';
  if (type !== 'stdio') plugin.type = type;

  if (typeof server.command === 'string') plugin.command = server.command;
  if (Array.isArray(server.args)) plugin.args = server.args;
  if (typeof server.url === 'string') plugin.url = server.url;

  const env = server.env;
  if (env && typeof env === 'object' && !Array.isArray(env)) plugin.env = env;

  const headers = server.headers;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) plugin.headers = headers;

  const startup = field(server, 'startupTimeoutSeconds', 'startup_timeout_seconds');
  if (typeof startup === 'number') plugin.startup_timeout_seconds = startup;

  const call = field(server, 'callTimeoutSeconds', 'call_timeout_seconds');
  if (typeof call === 'number') plugin.call_timeout_seconds = call;

  // Per-tool overrides, e.g. { generate_video = 1800 }.
  const toolTimeouts = field(server, 'toolTimeoutSeconds', 'tool_timeout_seconds');
  if (toolTimeouts && typeof toolTimeouts === 'object' && !Array.isArray(toolTimeouts)) {
    plugin.tool_timeout_seconds = toolTimeouts;
  }

  return plugin;
}
