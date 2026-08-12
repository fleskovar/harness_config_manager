import fsSync from 'node:fs';
import { renderMarkdown } from '../core/frontmatter.js';
import type { BundleResource, PlanAction } from '../core/types.js';
import { blockId } from '../merge/blocks.js';
import { flattenLeaves } from '../merge/json-merge.js';
import type { TargetContext } from './types.js';
import { compact, toList } from './types.js';

/** Claude Code and Copilot both want a comma-separated tools string. */
export function joinTools(value: unknown): string | undefined {
  const list = toList(value);
  return list.length ? list.join(', ') : undefined;
}

export function readBytes(target: string): Buffer {
  return fsSync.readFileSync(target);
}

export function omit(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));
}

/** A markdown resource rendered with target-specific frontmatter. */
export function markdownFile(
  targetPath: string,
  resource: BundleResource,
  frontmatter: Record<string, unknown>,
): PlanAction {
  return {
    path: targetPath,
    describe: targetPath,
    payload: { kind: 'file', contents: renderMarkdown(compact(frontmatter), resource.body ?? '') },
  };
}

/**
 * Skills copy their whole directory: SKILL.md is re-rendered so its frontmatter
 * matches the target, supporting files are copied byte-for-byte.
 */
export function skillFiles(resource: BundleResource, targetDir: string): PlanAction[] {
  return resource.files.map((file) => {
    const targetPath = `${targetDir}/${file.relativePath}`;

    if (file.relativePath === 'SKILL.md') {
      return {
        path: targetPath,
        describe: targetPath,
        payload: {
          kind: 'file' as const,
          contents: renderMarkdown(
            compact({
              name: resource.name,
              description: resource.frontmatter.description,
              ...omit(resource.frontmatter, ['name', 'description']),
            }),
            resource.body ?? '',
          ),
        },
      };
    }

    return {
      path: targetPath,
      describe: targetPath,
      payload: { kind: 'file' as const, contents: readBytes(file.absolutePath) },
    };
  });
}

/**
 * One bundle's contribution to a harness's standing-instruction file --
 * `CLAUDE.md`, `AGENTS.md`, `REASONIX.md`. Written as a marker block so
 * uninstall removes exactly this section and leaves the rest of the file,
 * including anything hand-written, alone.
 */
export function instructionBlock(
  file: string,
  ctx: TargetContext,
  id: string,
  name: string,
  body: string,
): PlanAction {
  return {
    path: file,
    describe: `${file} ← ${name}`,
    payload: {
      kind: 'block',
      blockId: blockId(ctx.bundle, id),
      syntax: 'markdown',
      body,
    },
  };
}

/**
 * For harnesses with no glob-scoped rule format, the globs cannot be enforced
 * by the loader -- so state them in prose above the rule for the model to
 * honour. Empty when the rule applies everywhere.
 */
export function appliesToPrefix(resource: BundleResource): string {
  const paths = toList(resource.frontmatter.appliesTo ?? resource.frontmatter.paths);
  return paths.length ? `**Applies to:** ${paths.map((p) => `\`${p}\``).join(', ')}\n\n` : '';
}

export function assetFile(resource: BundleResource, targetPath: string): PlanAction {
  return {
    path: targetPath,
    describe: targetPath,
    payload: { kind: 'file', contents: readBytes(resource.primaryFile) },
  };
}

/**
 * A settings fragment becomes one receipt per leaf, so two bundles can each own
 * different keys in the same settings.json and uninstall independently.
 * Arrays are appended to rather than replaced -- what permission allow-lists need.
 */
export function settingsActions(resource: BundleResource, targetPath: string): PlanAction[] {
  return flattenLeaves(resource.data).map((leaf) => {
    const label = leaf.pointer.join('.');

    if (Array.isArray(leaf.value)) {
      return {
        path: targetPath,
        describe: `${label}[] +${leaf.value.length}`,
        payload: { kind: 'json-array-item' as const, pointer: leaf.pointer, items: leaf.value },
      };
    }

    return {
      path: targetPath,
      describe: label,
      payload: { kind: 'json-value' as const, pointer: leaf.pointer, value: leaf.value },
    };
  });
}
