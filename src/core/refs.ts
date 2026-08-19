/**
 * Finding the file references a bundle's own text makes, and deciding which of
 * them point at nothing.
 *
 * A bundle is prose plus config, and both are full of paths: a SKILL.md that
 * says to work through `./checklist.md`, a command that links to
 * [the conventions](context/10-conventions.md), an MCP server whose args name a
 * script under `assets/`. Rename the file and every one of those becomes a lie
 * the agent will follow.
 *
 * The hard part is not finding paths. It is not finding the things that merely
 * look like paths. Prose about files is still prose:
 *
 *     A file will be created named `output.txt`.
 *     Identify the manifest (`package.json`) and read `tsconfig.json`.
 *
 * Not one of those is a reference to a file the bundle ships, and a checker
 * that says otherwise is a checker nobody runs. Filename-shaped text is far too
 * common in writing about software to be treated as a claim about the tree.
 *
 * So a reference has to be *written as one*, in one of two ways:
 *
 *   declared    the syntax says outright that its target is a path --
 *               [text](path), ![img](path), a [id]: definition, a [[wikilink]],
 *               or an @path mention. Nobody writes a markdown link to a turn of
 *               phrase.
 *   relative    written with an explicit `./` or `../`. That prefix is a
 *               deliberate act: `./output.txt` says "the file beside this one"
 *               where `output.txt` says only "a file called that".
 *
 * Everything else -- a bare filename or an implicit path in inline code or a
 * config value -- is left alone unless `--all-paths` asks for it, which is the
 * older, noisier behaviour kept for the bundles that were written against it.
 *
 * What a reference is relative to is still not stated anywhere, so resolution
 * tries both roots: `./checklist.md` next to a SKILL.md means the sibling;
 * `skills/audit/checklist.md` in a command means the same file, from the bundle
 * root.
 *
 * Under `--all-paths`, references also carry a confidence, and it decides how
 * loud the report is:
 *
 *   strong  declared, explicitly relative, or holding a separator. Always
 *           reported.
 *   weak    a bare filename in inline code or a config value. Reported only
 *           when something similar exists in the tree, which is also exactly
 *           when we have a fix to offer. `--strict` reports these regardless.
 *
 * @see refmap.ts for what happens to these references at install time.
 */

import path from 'node:path';
import { fs, isDirectory, listFiles, pathExists, toPosix } from './fsx.js';
import { findManifest } from './bundle.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RefConfidence = 'strong' | 'weak';

export type RefSyntax =
  | 'link' // [text](target)
  | 'image' // ![alt](target)
  | 'definition' // [id]: target
  | 'wikilink' // [[target]], [[target|alias]]
  | 'code' // `target`
  | 'mention' // @target
  | 'config'; // a string value in JSON/YAML/TOML

export const REF_SYNTAXES: readonly RefSyntax[] = [
  'link',
  'image',
  'definition',
  'wikilink',
  'code',
  'mention',
  'config',
];

/**
 * The syntaxes whose target is a path by construction.
 *
 * `[the rules](rules/typescript.md)` cannot be a turn of phrase the way
 * `` `rules.md` `` can: markdown has already said the thing in the parentheses
 * is somewhere to go. The same holds for a wikilink and for the `@file`
 * convention several harnesses read as "open this". These are checked as
 * written, without needing a `./` in front of them.
 */
export const DECLARED_SYNTAXES: ReadonlySet<RefSyntax> = new Set<RefSyntax>([
  'link',
  'image',
  'definition',
  'wikilink',
  'mention',
]);

/** What `--links` narrows to: the syntaxes that are a link of some kind. */
export const LINK_SYNTAXES: ReadonlySet<RefSyntax> = new Set<RefSyntax>([
  'link',
  'image',
  'definition',
  'wikilink',
]);

export interface FoundRef {
  /** Absolute path of the file the reference is written in. */
  file: string;
  /** `file`, relative to the scan root, POSIX separators. */
  fileRelative: string;
  /** The bundle `file` belongs to, absolute; absent for files outside any bundle. */
  bundleRoot?: string;
  /** The reference exactly as written. */
  ref: string;
  syntax: RefSyntax;
  confidence: RefConfidence;
  /** 1-based line of the reference, for the report. */
  line: number;
  /** Character offsets of `ref` within the file, for editing it in place. */
  start: number;
  end: number;
}

export interface ResolvedRef extends FoundRef {
  /** Absolute path the reference resolves to, when it resolves at all. */
  target?: string;
  /**
   * How it resolved -- against the containing file, against the bundle root,
   * or, for a wikilink, by the name of a file somewhere in the same bundle.
   */
  via?: 'file' | 'bundle' | 'name';
}

export interface RefSuggestion {
  /** The replacement, written the way the reference should be. */
  ref: string;
  /** Absolute path of the file suggested. */
  target: string;
  /** 0..1; only used for ordering. */
  score: number;
  /** True when the file is in a different bundle than the reference. */
  crossBundle: boolean;
}

export interface BrokenRef extends ResolvedRef {
  suggestions: RefSuggestion[];
}

export interface ScanResult {
  /** Absolute path that `fileRelative` values are relative to. */
  root: string;
  /** The rules this scan ran under, so a report can say what it looked at. */
  scope: RefScope;
  /** Every file that was read. */
  scanned: string[];
  /** Bundle roots found under the scan root. */
  bundles: string[];
  /** Every reference found, resolved or not. */
  refs: ResolvedRef[];
  broken: BrokenRef[];
}

/**
 * Which references a scan is about.
 *
 * The default -- every flag off -- is the narrow one: declared references, and
 * paths written with an explicit `./` or `../`. The flags widen or narrow it
 * from there, and they are the same three the CLI exposes.
 */
export interface RefScope {
  /** Only links, images, link definitions and wikilinks. */
  links?: boolean;
  /**
   * Also treat implicit paths and bare filenames in inline code and config
   * values as references -- noisier, and how this worked before.
   */
  allPaths?: boolean;
  /**
   * Implies `allPaths`, and additionally reports a bare filename even when
   * there is nothing similar in the tree to offer as a fix.
   */
  strict?: boolean;
}

export interface ScanOptions extends RefScope {
  /** How many replacements to offer per broken reference. */
  suggestions?: number;
}

/** The scope, resolved into the two questions extraction actually asks. */
export interface RefPolicy {
  /** Syntaxes worth looking at. */
  syntaxes: ReadonlySet<RefSyntax>;
  /**
   * Whether a path in a syntax that merely *might* hold one -- inline code, a
   * config value -- has to be written `./like/this` before it counts.
   */
  requireExplicitRelative: boolean;
}

/**
 * The scope a scan was asked for, as the rules extraction follows.
 *
 * `--strict` is a louder `--all-paths` rather than a scope of its own: it
 * changes which of the found references get *reported*, not which get found.
 */
export function refPolicy(scope: RefScope = {}): RefPolicy {
  const permissive = scope.allPaths === true || scope.strict === true;
  return {
    syntaxes: scope.links === true ? LINK_SYNTAXES : new Set(REF_SYNTAXES),
    requireExplicitRelative: !permissive,
  };
}

/**
 * What the installer reads, which is not what the checker reads.
 *
 * Remapping rewrites references it can prove point at a bundle file (see
 * refmap.ts), so a false positive costs nothing there -- an implicit
 * `skills/audit/checklist.md` that resolves is repointed, and prose that only
 * looks like a path resolves to nothing and is left alone. Wikilinks are the
 * exception in the other direction: they are resolved by *name* rather than by
 * path, so rewriting one into a relative path would break it.
 */
export const INSTALL_POLICY: RefPolicy = {
  syntaxes: new Set(REF_SYNTAXES.filter((syntax) => syntax !== 'wikilink')),
  requireExplicitRelative: false,
};

// ---------------------------------------------------------------------------
// What we read, and what we refuse to treat as a path
// ---------------------------------------------------------------------------

const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const CONFIG = new Set(['.json', '.yaml', '.yml', '.toml']);

const SKIP_DIRS = new Set(['.git', 'node_modules', '.hcm', 'dist', 'build', '.venv', '__pycache__']);

/**
 * Extensions a reference in a bundle plausibly points at. Anything else in
 * inline code is a command, an identifier or a version number -- `v1.2.3` and
 * `foo.bar()` would otherwise both read as filenames.
 */
const REFERENCE_EXTENSIONS = new Set([
  'md', 'markdown', 'mdx', 'txt', 'rst',
  'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'env',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'sh', 'bash', 'ps1',
  'sql', 'csv', 'tsv',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf',
  'html', 'css', 'tmpl', 'template', 'j2',
]);

/**
 * Filenames that turn up in prose about a project rather than as references to
 * files the bundle ships. Without this, every skill that mentions running an
 * audit reports `package.json` as a broken reference.
 */
const AMBIENT_FILENAMES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'tsconfig.json', 'jsconfig.json', 'eslintrc.json', '.eslintrc.json', '.prettierrc',
  'requirements.txt', 'pyproject.toml', 'poetry.lock', 'setup.py', 'setup.cfg', 'pipfile.lock',
  'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'gemfile', 'gemfile.lock',
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'makefile',
  '.gitignore', '.env', '.env.local', '.npmrc', '.editorconfig',
  'readme.md', 'license', 'license.md', 'changelog.md', 'contributing.md',
  // hcm's own vocabulary: these name a convention, not a file to point at.
  'hcm.yaml', 'hcm.yml', 'hcm.json', 'claude.md', 'agents.md', 'reasonix.md',
  'settings.json', 'mcp.json', '.mcp.json', 'opencode.json', 'reasonix.toml',
  'copilot-instructions.md',
]);

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Read every markdown file and config under `root`, extract the references, and
 * work out which of them point at nothing.
 *
 * `root` is normally a bundle or a collection of bundles; it does not have to
 * be either -- files outside any bundle are still read, they simply have no
 * bundle root to resolve against.
 */
export async function scanReferences(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const absoluteRoot = path.resolve(root);
  if (!(await isDirectory(absoluteRoot))) {
    // A single file is a legitimate thing to check; treat its directory as the
    // root so relative paths in the report still mean something.
    const parent = path.dirname(absoluteRoot);
    return scanFiles(parent, [absoluteRoot], options);
  }

  const files = (await listTree(absoluteRoot)).filter((file) => isScannable(file));
  return scanFiles(absoluteRoot, files, options);
}

async function scanFiles(
  root: string,
  files: string[],
  options: ScanOptions,
): Promise<ScanResult> {
  const bundles = await findBundleRoots(root);
  const index = await buildFileIndex(root);
  const policy = refPolicy(options);

  const refs: ResolvedRef[] = [];

  for (const file of files) {
    const text = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) continue;

    const bundleRoot = bundleRootFor(file, bundles);
    const found = extractRefs(file, text, policy);

    for (const ref of found) {
      refs.push({
        ...ref,
        fileRelative: toPosix(path.relative(root, file)),
        ...(bundleRoot ? { bundleRoot } : {}),
        ...(await resolveRef(ref.ref, file, bundleRoot, { syntax: ref.syntax, index })),
      });
    }
  }

  const limit = options.suggestions ?? 3;
  const broken: BrokenRef[] = [];

  for (const ref of refs) {
    if (ref.target !== undefined) continue;
    const suggestions = suggestFixes(ref, index, limit);
    // A weak reference with nothing like it in the tree is prose about a file
    // this bundle does not ship -- reported only when asked for explicitly.
    if (ref.confidence === 'weak' && suggestions.length === 0 && !options.strict) continue;
    broken.push({ ...ref, suggestions });
  }

  return {
    root,
    // The scope as it was *applied*, not as it was typed: `--strict` implies
    // `--all-paths`, and a report that said otherwise would be describing a
    // scan that did not happen.
    scope: {
      links: options.links === true,
      allPaths: options.allPaths === true || options.strict === true,
      strict: options.strict === true,
    },
    scanned: files,
    bundles,
    refs,
    broken,
  };
}

export function isScannable(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  return MARKDOWN.has(extension) || CONFIG.has(extension);
}

async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }

  await walk(root);
  return out;
}

/** Bundle roots at or under `root`, deepest first so lookup finds the innermost. */
async function findBundleRoots(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (await findManifest(dir)) found.push(dir);
    // Bundles do not nest, and a collection is one level deep -- but a scan
    // root two levels above a bundle is an easy mistake, so allow a little.
    if (depth >= 3) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  return found.sort((a, b) => b.length - a.length);
}

function bundleRootFor(file: string, bundles: string[]): string | undefined {
  // Sorted deepest-first, so the first containing root is the innermost.
  return bundles.find((bundle) => isInside(file, bundle));
}

function isInside(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Every reference candidate in one file, with its offsets.
 *
 * `policy` decides what counts as one. It defaults to `INSTALL_POLICY` -- the
 * permissive reading the installer needs -- so that a caller who has not
 * thought about scope gets the same answer this always gave. `scanReferences`
 * passes the checker's narrower policy explicitly.
 */
export function extractRefs(
  file: string,
  text: string,
  policy: RefPolicy = INSTALL_POLICY,
): Omit<FoundRef, 'fileRelative'>[] {
  const extension = path.extname(file).toLowerCase();
  const found = MARKDOWN.has(extension) ? extractFromMarkdown(text) : extractFromConfig(text);

  return found
    .filter((candidate) => policy.syntaxes.has(candidate.syntax))
    .filter((candidate) => looksLikePath(candidate.ref, candidate.syntax))
    .filter((candidate) => isInScope(candidate.ref, candidate.syntax, policy))
    .map((candidate) => ({
      file,
      ref: candidate.ref,
      syntax: candidate.syntax,
      confidence: confidenceOf(candidate.ref, candidate.syntax),
      line: lineOf(text, candidate.start),
      start: candidate.start,
      end: candidate.end,
    }));
}

/**
 * The rule that keeps prose out of the report.
 *
 * A declared reference is in scope whatever it says -- the syntax has already
 * vouched for it. Anything else has to have been written as a path on purpose,
 * and `./` or `../` is the only mark of that a bundle author can make. A bare
 * `output.txt` in a sentence about creating a file is indistinguishable from a
 * bare `output.txt` meant as a reference, so neither is treated as one.
 */
export function isInScope(ref: string, syntax: RefSyntax, policy: RefPolicy): boolean {
  if (!policy.requireExplicitRelative) return true;
  if (DECLARED_SYNTAXES.has(syntax)) return true;
  return isExplicitlyRelative(ref);
}

/** `./here.md` and `../up/there.md`, and nothing else. */
export function isExplicitlyRelative(ref: string): boolean {
  return /^\.\.?\//.test(ref.trim());
}

interface Candidate {
  ref: string;
  syntax: RefSyntax;
  start: number;
  end: number;
}

/** `[start, end)` of every single-backtick inline code span. */
const INLINE_CODE = /(?<!`)`([^`\n]+)`(?!`)/g;

/**
 * Markdown, minus the parts of it that are not prose.
 *
 * Fenced code blocks are stripped first: they are examples and shell sessions,
 * and the paths in them belong to whatever the example is about, not to the
 * bundle. Inline code is kept, because that is how the skills that ship with
 * hcm point at their own supporting files.
 *
 * What inline code does *not* keep is a declared reference written inside it.
 * Documentation about markdown is full of them --
 *
 *     the syntax says its target is a path: `[text](path)`, `[[wikilink]]`
 *
 * -- and none of those is a link, in the sense that no reader will ever follow
 * one. A backtick span is a display, so its contents are considered only as the
 * one `code` candidate they visibly are.
 */
function extractFromMarkdown(text: string): Candidate[] {
  const masked = maskFences(text);
  const candidates: Candidate[] = [];

  const codeSpans = [...masked.matchAll(INLINE_CODE)].map((match) => ({
    start: match.index as number,
    end: (match.index as number) + match[0].length,
  }));
  const shown = (at: number): boolean =>
    codeSpans.some((span) => at > span.start && at < span.end);

  // ![alt](target) and [text](target), with optional "title" after the target.
  const link = /(!?)\[[^\]\n]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  for (const match of masked.matchAll(link)) {
    const whole = match[0];
    const bang = match[1] === '!';
    const target = match[2] as string;
    const offset = (match.index as number) + whole.indexOf(target, bang ? 2 : 1);
    candidates.push({
      ref: stripAnchor(target),
      syntax: bang ? 'image' : 'link',
      start: offset,
      end: offset + stripAnchor(target).length,
    });
  }

  // [[target]], [[target|alias]], [[target#heading]] -- the wiki convention.
  // The alias and the heading are not part of the path; only the target is
  // offset-recorded, so a fix rewrites the target and leaves the rest alone.
  const wiki = /\[\[([^[\]\n]+)\]\]/g;
  for (const match of masked.matchAll(wiki)) {
    const inner = match[1] as string;
    const target = stripAnchor((inner.split('|')[0] as string)).trim();
    if (!target) continue;
    const offset = (match.index as number) + 2 + inner.indexOf(target);
    candidates.push({ ref: target, syntax: 'wikilink', start: offset, end: offset + target.length });
  }

  // [id]: target -- a link definition, at the start of a line.
  const definition = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]+(\S+)/gm;
  for (const match of masked.matchAll(definition)) {
    const target = match[1] as string;
    const offset = (match.index as number) + match[0].lastIndexOf(target);
    candidates.push({
      ref: stripAnchor(target),
      syntax: 'definition',
      start: offset,
      end: offset + stripAnchor(target).length,
    });
  }

  // `target` -- single-backtick inline code only; a double-backtick span is
  // nearly always code containing a backtick, not a path.
  for (const match of masked.matchAll(INLINE_CODE)) {
    const inner = (match[1] as string).trim();
    const offset = (match.index as number) + 1 + (match[1] as string).indexOf(inner);
    candidates.push({ ref: inner, syntax: 'code', start: offset, end: offset + inner.length });
  }

  // @path/to/file -- the "read this file" convention several harnesses use.
  const mention = /(^|[\s(])@([A-Za-z0-9._\-/]+\.[A-Za-z0-9]{1,8})/g;
  for (const match of masked.matchAll(mention)) {
    const target = match[2] as string;
    const offset = (match.index as number) + (match[1] as string).length + 1;
    candidates.push({ ref: target, syntax: 'mention', start: offset, end: offset + target.length });
  }

  return candidates
    .filter((candidate) => candidate.syntax === 'code' || !shown(candidate.start))
    .sort((a, b) => a.start - b.start);
}

/**
 * Configs, treated as text rather than parsed.
 *
 * Parsing would mean three parsers and a walk per format, and would still have
 * to find the offset of the value to edit it in place. Every one of these
 * formats quotes its strings, so the quoted spans are the values -- and a path
 * that is not quoted is not a path in any of them.
 */
function extractFromConfig(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const string = /"([^"\n\\]*)"|'([^'\n\\]*)'/g;

  for (const match of text.matchAll(string)) {
    const value = (match[1] ?? match[2]) as string;
    if (!value) continue;
    const offset = (match.index as number) + 1;
    candidates.push({ ref: value, syntax: 'config', start: offset, end: offset + value.length });
  }

  return candidates;
}

/** Replace fenced code blocks with spaces, keeping every offset where it was. */
function maskFences(text: string): string {
  return text.replace(/^([ \t]*)(```+|~~~+)[^\n]*\n[\s\S]*?^[ \t]*\2[^\n]*$/gm, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
}

function stripAnchor(target: string): string {
  const hash = target.indexOf('#');
  return hash === -1 ? target : target.slice(0, hash);
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') line += 1;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Is this a path at all?
// ---------------------------------------------------------------------------

/**
 * The filter that keeps the report worth reading.
 *
 * A link's target is a path by construction, so only the obvious non-paths are
 * dropped. Everything else has to look like one: a name with a plausible
 * extension, no spaces, no shell in it, and not one of the filenames prose
 * mentions about projects in general.
 */
export function looksLikePath(ref: string, syntax: RefSyntax): boolean {
  const value = ref.trim();
  if (!value) return false;

  // Not ours to check: URLs, mail links, anchors, absolute and home paths, and
  // anything with a variable in it that only the harness can expand.
  if (URL_SCHEME.test(value) && !value.startsWith('.')) return false;
  if (value.startsWith('#') || value.startsWith('/') || value.startsWith('~')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\')) return false;
  if (/[$%{}*?<>|"'`]/.test(value)) return false;
  if (value.includes('\\')) return false;

  // A path rooted at a hidden directory is describing where something lands
  // *after* installation -- `.claude/agents/x.md`, `.vscode/mcp.json` -- which
  // is what a bundle's own README is full of. Bundles ship no hidden resource
  // directories, so this can never be a reference into one. `.` and `..` are
  // ordinary relative paths and stay.
  const first = value.replace(/^\.\//, '').split('/')[0] as string;
  if (value.includes('/') && first.startsWith('.') && first !== '.' && first !== '..') return false;

  // A wikilink names a file rather than spelling a path to it: spaces are
  // ordinary in one, and the extension is normally left off entirely.
  if (syntax === 'wikilink') return true;

  const linkish = syntax === 'link' || syntax === 'image' || syntax === 'definition';

  // A link may legitimately point at a directory, so it needs no extension.
  if (linkish) return !value.includes(' ');

  // Anything else has to be a single token that ends in a known extension.
  if (/\s/.test(value)) return false;
  const extension = path.posix.extname(value).replace('.', '').toLowerCase();
  if (!REFERENCE_EXTENSIONS.has(extension)) return false;

  // `--json`, `-v`: flags that happen to end in something extension-shaped.
  if (value.startsWith('-')) return false;

  const base = path.posix.basename(value).toLowerCase();
  if (AMBIENT_FILENAMES.has(base) && !value.includes('/')) return false;

  return true;
}

/**
 * Written as a reference, or merely shaped like one.
 *
 * Declared syntax says outright that it is a reference, and so does an explicit
 * `./`. A separator is weaker evidence but still evidence: a bare
 * `checklist.md` in a sentence might be prose, while `skills/audit/checklist.md`
 * is nobody's turn of phrase.
 *
 * Only `--all-paths` can produce anything but `strong`, which is the point --
 * the narrow scope admits nothing it is unsure about.
 */
function confidenceOf(ref: string, syntax: RefSyntax): RefConfidence {
  if (DECLARED_SYNTAXES.has(syntax)) return 'strong';
  if (isExplicitlyRelative(ref)) return 'strong';
  return ref.includes('/') ? 'strong' : 'weak';
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /** Wikilinks resolve by name as well as by path; nothing else does. */
  syntax?: RefSyntax;
  /** Files under the scan root, for the name lookup a wikilink needs. */
  index?: readonly RefIndexEntry[];
}

export interface Resolution {
  target?: string;
  via?: 'file' | 'bundle' | 'name';
}

/**
 * Where a reference points, trying both roots a bundle author might have meant.
 *
 * The bundle root comes first: that is the convention `hcm` installs against
 * (see refmap.ts), so a path that resolves both ways is read as the bundle-
 * relative one. The file-relative fallback is what makes a skill's
 * `./checklist.md` work, and what keeps every bundle written before this
 * existed resolving as it always did.
 *
 * A wikilink is the exception, because it is a name and not a path. `[[release
 * checklist]]` gets its extension guessed, and then, failing both roots, is
 * looked up by name anywhere in the same bundle -- which is how every tool that
 * reads wikilinks resolves them, and the only reading under which the common
 * form of one resolves at all.
 */
export async function resolveRef(
  ref: string,
  file: string,
  bundleRoot?: string,
  options: ResolveOptions = {},
): Promise<Resolution> {
  const cleaned = stripAnchor(ref.trim()).replace(/^\.\//, '');
  if (!cleaned) return {};

  const wiki = options.syntax === 'wikilink';

  for (const candidate of wiki ? wikilinkCandidates(cleaned) : [cleaned]) {
    const segments = candidate.split('/');

    if (bundleRoot && !candidate.startsWith('..')) {
      const fromBundle = path.resolve(bundleRoot, ...segments);
      if (await pathExists(fromBundle)) return { target: fromBundle, via: 'bundle' };
    }

    const fromFile = path.resolve(path.dirname(file), ...segments);
    if (await pathExists(fromFile)) return { target: fromFile, via: 'file' };
  }

  if (wiki && options.index) {
    const named = findByName(cleaned, options.index, bundleRoot);
    if (named) return { target: named, via: 'name' };
  }

  return {};
}

/**
 * The paths one wikilink might mean, likeliest first.
 *
 * `[[notes]]` is a markdown file called notes far more often than it is a
 * directory called notes, so the extensions are tried before the bare name. A
 * wikilink that already carries an extension is taken at its word.
 */
function wikilinkCandidates(value: string): string[] {
  const extension = path.posix.extname(value).replace('.', '').toLowerCase();
  if (extension && REFERENCE_EXTENSIONS.has(extension)) return [value];
  return [`${value}.md`, `${value}.markdown`, `${value}.mdx`, value];
}

/**
 * A wikilink resolved the way wiki tools resolve one: by the name of the file,
 * wherever it happens to sit.
 *
 * Confined to the bundle doing the referring. A wikilink reaching into a
 * sibling bundle would not survive installation -- the two need not be
 * installed together, and refmap.ts cannot rewrite a name into a path without
 * destroying it -- so treating that as resolved would be a lie.
 */
function findByName(
  ref: string,
  index: readonly RefIndexEntry[],
  bundleRoot?: string,
): string | undefined {
  const wanted = stem(path.posix.basename(ref));
  if (!wanted) return undefined;

  const matches = index.filter(
    (entry) => stem(entry.base) === wanted && (bundleRoot === undefined || entry.bundleRoot === bundleRoot),
  );

  return matches[0]?.absolute;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export interface RefIndexEntry {
  absolute: string;
  /** Relative to the scan root, POSIX. */
  relative: string;
  base: string;
  extension: string;
  bundleRoot?: string;
}

/** Every file under the scan root, with the bits the ranking needs precomputed. */
async function buildFileIndex(root: string): Promise<RefIndexEntry[]> {
  const bundles = await findBundleRoots(root);
  const files = (await listFiles(root)).filter(
    (file) => !file.split(path.sep).some((segment) => SKIP_DIRS.has(segment)),
  );

  return files.map((absolute) => {
    const bundleRoot = bundleRootFor(absolute, bundles);
    return {
      absolute,
      relative: toPosix(path.relative(root, absolute)),
      base: path.basename(absolute),
      extension: path.extname(absolute).toLowerCase(),
      ...(bundleRoot ? { bundleRoot } : {}),
    };
  });
}

/**
 * The files this reference most plausibly meant.
 *
 * Ranked on the name first -- a rename is what usually breaks a reference, and
 * a renamed file keeps most of its name -- then nudged by the things that make
 * one candidate likelier than another with the same name: the same extension,
 * a matching parent directory, and being in the bundle doing the referring.
 */
export function suggestFixes(ref: ResolvedRef, index: RefIndexEntry[], limit = 3): RefSuggestion[] {
  const wanted = path.posix.basename(ref.ref.trim());
  if (!wanted) return [];

  const wantedStem = stem(wanted);
  const wantedExtension = path.posix.extname(wanted).toLowerCase();
  const wantedParent = path.posix.basename(path.posix.dirname(ref.ref.trim()));

  const scored: RefSuggestion[] = [];

  for (const entry of index) {
    if (entry.absolute === ref.file) continue;

    let score = similarity(wantedStem, stem(entry.base));
    if (score < 0.3) continue;

    if (wantedExtension && entry.extension === wantedExtension) score += 0.12;
    else if (wantedExtension && entry.extension !== wantedExtension) score -= 0.15;

    if (wantedParent && path.basename(path.dirname(entry.absolute)) === wantedParent) score += 0.1;

    const crossBundle = ref.bundleRoot !== undefined && entry.bundleRoot !== ref.bundleRoot;
    // A file in another bundle can be the answer -- a dependency's asset, say --
    // but only once nothing in this bundle fits, and it cannot be remapped on
    // install, so it never outranks a local candidate.
    if (crossBundle) score -= 0.25;

    scored.push({
      ref: suggestionPath(entry, ref),
      target: entry.absolute,
      score: Math.min(score, 1),
      crossBundle,
    });
  }

  return scored
    .sort(
      (a, b) =>
        // Local before foreign, whatever the scores say: a file in another
        // bundle may not be installed alongside this one, and cannot be
        // remapped if it is. Only then by how well the name matches.
        Number(a.crossBundle) - Number(b.crossBundle) ||
        b.score - a.score ||
        a.ref.localeCompare(b.ref),
    )
    .filter((suggestion) => suggestion.score >= 0.35)
    .slice(0, limit);
}

/**
 * How a suggestion should be written.
 *
 * In the same form it is replacing, or the fix would not be a fix.
 *
 * A wikilink takes the file's name without its extension, which is what a
 * wikilink holds. A reference the author wrote `./like this` keeps its prefix:
 * that prefix is what put it in scope in the first place, and a "fix" that
 * quietly turned it into a bare path would drop it out of every later check.
 * Everything else takes a bundle-relative path, the form `hcm` remaps on
 * install -- or, for a file in another bundle, one relative to the referring
 * file, which is a reference that will not survive installation; the report
 * says so.
 */
function suggestionPath(entry: RefIndexEntry, ref: ResolvedRef): string {
  if (ref.syntax === 'wikilink') return path.basename(entry.absolute, path.extname(entry.absolute));

  const fromFile = toPosix(path.relative(path.dirname(ref.file), entry.absolute));

  if (isExplicitlyRelative(ref.ref)) return fromFile.startsWith('..') ? fromFile : `./${fromFile}`;

  if (ref.bundleRoot && entry.bundleRoot === ref.bundleRoot) {
    return toPosix(path.relative(ref.bundleRoot, entry.absolute));
  }
  return fromFile;
}

/** Filename without its extension, lowercased. */
function stem(name: string): string {
  const extension = path.posix.extname(name);
  return (extension ? name.slice(0, -extension.length) : name).toLowerCase();
}

/**
 * 0..1 over two filename stems.
 *
 * Three views, each of which catches renames the others miss, and the best of
 * them wins. Averaging them instead would be worse than any one alone: a
 * one-character typo scores 0.9 on edit distance and 0 on token overlap --
 * filenames are usually a single token -- and blending those into 0.55 buries
 * the likeliest fix there is.
 *
 *   distance    `conventions` -> `convetions`, a typo
 *   tokens      `pull-requests` -> `requests-pull`, reordered
 *   containment `checklist` -> `audit-checklist`, qualified
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const byDistance = 1 - levenshtein(a, b) / Math.max(a.length, b.length);

  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  const shared = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  const byTokens = union === 0 ? 0 : shared / union;

  // Capped below an outright match, so a name that merely contains the other
  // never beats the file actually called that.
  const byContainment = a.includes(b) || b.includes(a) ? 0.75 : 0;

  return Math.max(byDistance, byTokens, byContainment);
}

function tokens(value: string): string[] {
  return value.split(/[-_.\s/]+/).filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  // One row at a time: these are filenames, but the index can be large.
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    previous = current;
  }

  return previous[b.length] as number;
}

// ---------------------------------------------------------------------------
// Applying fixes
// ---------------------------------------------------------------------------

/** One reference to replace, as read back from the fix file. */
export interface RefEdit {
  file: string;
  /** The reference as it was reported, used to find it again. */
  original: string;
  replacement: string;
  /** Where it was when the file was scanned; re-checked before editing. */
  start?: number;
  end?: number;
}

export interface EditOutcome {
  file: string;
  original: string;
  replacement: string;
  applied: boolean;
  /** Why it was not applied. */
  reason?: string;
}

/**
 * Rewrite references in place.
 *
 * The offsets recorded at scan time are checked against what is on disk before
 * anything is written -- the file may well have been edited while the JSON was
 * open -- and fall back to a unique-occurrence search when they no longer line
 * up. An occurrence that cannot be pinned down exactly is left alone and
 * reported rather than guessed at.
 */
export async function applyRefEdits(
  edits: RefEdit[],
  options: { dryRun?: boolean } = {},
): Promise<EditOutcome[]> {
  const byFile = new Map<string, RefEdit[]>();
  for (const edit of edits) {
    const list = byFile.get(edit.file) ?? [];
    list.push(edit);
    byFile.set(edit.file, list);
  }

  const outcomes: EditOutcome[] = [];

  for (const [file, fileEdits] of byFile) {
    const text = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) {
      for (const edit of fileEdits) {
        outcomes.push({ ...describe(edit), applied: false, reason: 'file could not be read' });
      }
      continue;
    }

    const resolved: { edit: RefEdit; start: number; end: number }[] = [];

    for (const edit of fileEdits) {
      const at = locate(text, edit);
      if (at === undefined) {
        outcomes.push({
          ...describe(edit),
          applied: false,
          reason: `"${edit.original}" no longer appears exactly once at that place`,
        });
        continue;
      }
      resolved.push({ edit, ...at });
    }

    if (resolved.length === 0) continue;

    // Back to front, so an earlier replacement cannot move a later offset.
    let updated = text;
    for (const item of resolved.sort((a, b) => b.start - a.start)) {
      updated = updated.slice(0, item.start) + item.edit.replacement + updated.slice(item.end);
      outcomes.push({ ...describe(item.edit), applied: true });
    }

    if (!options.dryRun && updated !== text) await fs.writeFile(file, updated, 'utf8');
  }

  return outcomes;
}

function describe(edit: RefEdit): Omit<EditOutcome, 'applied'> {
  return { file: edit.file, original: edit.original, replacement: edit.replacement };
}

function locate(text: string, edit: RefEdit): { start: number; end: number } | undefined {
  const { original, start, end } = edit;

  if (start !== undefined && end !== undefined && text.slice(start, end) === original) {
    return { start, end };
  }

  const first = text.indexOf(original);
  if (first === -1) return undefined;
  // Ambiguous without offsets: two identical references in one file, and no way
  // to tell which one the entry meant.
  if (text.indexOf(original, first + 1) !== -1) return undefined;
  return { start: first, end: first + original.length };
}
