import os from 'node:os';
import type { BundleResource, PlanAction, Scope } from '../core/types.js';
import { blockId } from '../merge/blocks.js';
import { assetFile, joinTools, markdownFile, settingsActions, skillFiles } from './shared.js';
import type { Target, TargetContext } from './types.js';
import { toList } from './types.js';

/**
 * Claude Code.
 * https://code.claude.com/docs/en/claude-directory
 *
 *   .claude/agents/<name>.md       .mcp.json  -> mcpServers.<name>
 *   .claude/skills/<name>/**       CLAUDE.md  -> marker block
 *   .claude/commands/<name>.md     .claude/settings.json
 *   .claude/rules/<name>.md
 */
export const claudeCode: Target = {
  id: 'claude-code',
  title: 'Claude Code',
  docs: 'https://code.claude.com/docs/en/claude-directory',
  supports: ['subagent', 'skill', 'command', 'rule', 'context', 'mcp', 'settings', 'asset'],

  scopeRoot(scope: Scope, cwd: string): string {
    return scope === 'user' ? os.homedir() : cwd;
  },

  actions(resource: BundleResource, ctx: TargetContext): PlanAction[] {
    switch (resource.kind) {
      case 'subagent':
        return [
          markdownFile(`.claude/agents/${resource.name}.md`, resource, {
            name: resource.name,
            description: resource.frontmatter.description,
            // Claude Code expects a comma-separated string, not a YAML list.
            tools: joinTools(resource.frontmatter.tools),
            model: resource.frontmatter.model,
          }),
        ];

      case 'skill':
        return skillFiles(resource, `.claude/skills/${resource.name}`);

      case 'command':
        return [
          markdownFile(`.claude/commands/${resource.name}.md`, resource, {
            description: resource.frontmatter.description,
            'argument-hint': resource.frontmatter.argumentHint ?? resource.frontmatter['argument-hint'],
            'allowed-tools': joinTools(
              resource.frontmatter.allowedTools ?? resource.frontmatter['allowed-tools'],
            ),
          }),
        ];

      case 'rule': {
        const paths = toList(resource.frontmatter.appliesTo ?? resource.frontmatter.paths);
        return [
          markdownFile(`.claude/rules/${resource.name}.md`, resource, {
            description: resource.frontmatter.description,
            // A rule without `paths:` loads at session start.
            paths: paths.length ? paths : undefined,
          }),
        ];
      }

      case 'context':
        return [
          {
            path: ctx.scope === 'user' ? '.claude/CLAUDE.md' : 'CLAUDE.md',
            describe: `CLAUDE.md ← ${resource.name}`,
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
            // Project servers live in .mcp.json; user-level ones in ~/.claude.json.
            path: ctx.scope === 'user' ? '.claude.json' : '.mcp.json',
            describe: `mcpServers.${resource.name}`,
            payload: {
              kind: 'json-value',
              pointer: ['mcpServers', resource.name],
              value: resource.data,
            },
          },
        ];

      case 'settings':
        return settingsActions(resource, '.claude/settings.json');

      case 'asset':
        return [assetFile(resource, `.claude/${resource.name}`)];

      default:
        return [];
    }
  },
};
