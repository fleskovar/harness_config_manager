import YAML from 'yaml';

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseMarkdown(text: string): ParsedMarkdown {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { frontmatter: {}, body: text.trim() };

  const parsed = YAML.parse(match[1] as string) as unknown;
  const frontmatter =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  return { frontmatter, body: text.slice(match[0].length).trim() };
}

export function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const entries = Object.entries(frontmatter).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return `${body.trim()}\n`;

  const yaml = YAML.stringify(Object.fromEntries(entries)).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}
