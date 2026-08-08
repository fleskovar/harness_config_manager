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
 * Paths: docs/CONFIG_PATHS.md. Subagents: docs/SUBAGENT_PROFILES.md.
 *
 *   .reasonix/skills/<name>/**      REASONIX.md   -> marker block (context, rules)
 *   .reasonix/commands/<name>.md    reasonix.toml -> [[plugins]] (MCP)
 *                                   reasonix.toml -> [tables] (settings)
 *
 * Two things differ from the other harnesses:
 *
 *  - There is no agents directory. A subagent is a Skill carrying
 *    `runAs: subagent`, so subagents and skills share `skills/`.
 *  - There is no per-file rule format either -- standing instructions are the
 *    REASONIX.md hierarchy -- so rules join context in REASONIX.md.
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
      // A subagent profile is a Skill with `runAs: subagent` -- same directory,
      // same file format, distinguished only by frontmatter. `invocation: manual`
      // keeps it out of the pinned Skill index so it is only ever called by name.
      case 'subagent':
        return [
          markdownFile(`${base}skills/${resource.name}/SKILL.md`, resource, {
            name: resource.name,
            description: resource.frontmatter.description,
            color: resource.frontmatter.color,
            invocation: 'manual',
            runAs: 'subagent',
            model: resource.frontmatter.model,
            effort: resource.frontmatter.effort,
            'read-only': resource.frontmatter.readOnly ?? resource.frontmatter['read-only'],
            // A profile-level allowlist, written as a YAML list.
            'allowed-tools': listOrUndefined(resource.frontmatter.tools),
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

      // Reasonix has no glob-scoped rule files: standing instructions are the
      // REASONIX.md hierarchy, scoped by directory. So a rule becomes a block in
      // REASONIX.md whose globs are stated in the text for the model to honour.
      case 'rule': {
        const paths = toList(resource.frontmatter.appliesTo ?? resource.frontmatter.paths);
        const scope = paths.length ? `**Applies to:** ${paths.map((p) => `\`${p}\``).join(', ')}\n\n` : '';
        return [
          standingInstructions(ctx, `rules/${resource.name}`, resource.name, scope + (resource.body ?? '')),
        ];
      }

      case 'context':
        return [standingInstructions(ctx, resource.name, resource.name, resource.body ?? '')];

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

/**
 * Reasonix home: %AppData%\reasonix on Windows, ~/.reasonix elsewhere,
 * overridden by REASONIX_HOME (docs/CONFIG_PATHS.md).
 */
export function reasonixHome(): string {
  if (process.env.REASONIX_HOME) return process.env.REASONIX_HOME;
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'reasonix');
  }
  return path.join(os.homedir(), '.reasonix');
}

/** One bundle's contribution to REASONIX.md, the standing-instruction file. */
function standingInstructions(
  ctx: TargetContext,
  id: string,
  name: string,
  body: string,
): PlanAction {
  return {
    path: 'REASONIX.md',
    describe: `REASONIX.md ← ${name}`,
    payload: {
      kind: 'block',
      blockId: blockId(ctx.bundle, id),
      syntax: 'markdown',
      body,
    },
  };
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
