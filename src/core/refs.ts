/**
 * Finding the file references a bundle's own text makes, and deciding which of
 * them point at nothing.
 *
 * A bundle is prose plus config, and both are full of paths: a SKILL.md that
 * says to work through `checklist.md`, a command that links to
 * [the conventions](context/10-conventions.md), an MCP server whose args name a
 * script under `assets/`. Rename the file and every one of those becomes a lie
 * the agent will follow.
 *
 * Two problems make this harder than grepping for slashes:
 *
 *   1. Prose mentions filenames it is not referring to. "Run `npm audit`, then
 *      check `package.json`" names a file that is not in the bundle and never
 *      will be. Reporting it as broken trains people to ignore the report.
 *   2. What a reference is relative to is not stated anywhere. `checklist.md`
 *      next to a SKILL.md means the sibling; `skills/audit/checklist.md` in a
 *      command means the same file, from the bundle root.
 *
 * So references carry a confidence, and resolution tries both roots:
 *
 *   strong  written as a reference -- [text](path), ![img](path), a link
 *           definition, or a path with a separator in it. Always reported.
 *   weak    a bare filename in inline code or frontmatter. Reported only when
 *           something similar exists in the tree, which is also exactly when we
 *           have a fix to offer. `--strict` reports these regardless.
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
  | 'code' // `target`
  | 'mention' // @target
  | 'config'; // a string value in JSON/YAML/TOML

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
  /** How it resolved -- against the containing file, or against the bundle root. */
  via?: 'file' | 'bundle';
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
  /** Every file that was read. */
  scanned: string[];
  /** Bundle roots found under the scan root. */
  bundles: string[];
  /** Every reference found, resolved or not. */
  refs: ResolvedRef[];
  broken: BrokenRef[];
}

export interface ScanOptions {
  /** Report weak references even when nothing similar exists to suggest. */
  strict?: boolean;
  /** How many replacements to offer per broken reference. */
  suggestions?: number;
}

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

  const refs: ResolvedRef[] = [];

  for (const file of files) {
    const text = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) continue;

    const bundleRoot = bundleRootFor(file, bundles);
    const found = extractRefs(file, text);

    for (const ref of found) {
      refs.push({
        ...ref,
        fileRelative: toPosix(path.relative(root, file)),
        ...(bundleRoot ? { bundleRoot } : {}),
        ...(await resolveRef(ref.ref, file, bundleRoot)),
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

  return { root, scanned: files, bundles, refs, broken };
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

/** Every reference candidate in one file, with its offsets. */
export function extractRefs(file: string, text: string): Omit<FoundRef, 'fileRelative'>[] {
  const extension = path.extname(file).toLowerCase();
  const found = MARKDOWN.has(extension) ? extractFromMarkdown(text) : extractFromConfig(text);

  return found
    .filter((candidate) => looksLikePath(candidate.ref, candidate.syntax))
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

interface Candidate {
  ref: string;
  syntax: RefSyntax;
  start: number;
  end: number;
}

/**
 * Markdown, minus the parts of it that are not prose.
 *
 * Fenced code blocks are stripped first: they are examples and shell sessions,
 * and the paths in them belong to whatever the example is about, not to the
 * bundle. Inline code is kept, because that is how the skills that ship with
 * hcm point at their own supporting files.
 */
function extractFromMarkdown(text: string): Candidate[] {
  const masked = maskFences(text);
  const candidates: Candidate[] = [];

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
  const code = /(?<!`)`([^`\n]+)`(?!`)/g;
  for (const match of masked.matchAll(code)) {
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

  return candidates.sort((a, b) => a.start - b.start);
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
 * Link syntax says outright that it is a reference. So does a separator: a bare
 * `checklist.md` in a sentence might be prose, but `skills/audit/checklist.md`
 * is nobody's turn of phrase.
 */
function confidenceOf(ref: string, syntax: RefSyntax): RefConfidence {
  if (syntax === 'link' || syntax === 'image' || syntax === 'definition' || syntax === 'mention') {
    return 'strong';
  }
  return ref.includes('/') ? 'strong' : 'weak';
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Where a reference points, trying both roots a bundle author might have meant.
 *
 * The bundle root comes first: that is the convention `hcm` installs against
 * (see refmap.ts), so a path that resolves both ways is read as the bundle-
 * relative one. The file-relative fallback is what makes a skill's
 * `checklist.md` work, and what keeps every bundle written before this existed
 * resolving as it always did.
 */
export async function resolveRef(
  ref: string,
  file: string,
  bundleRoot?: string,
): Promise<{ target?: string; via?: 'file' | 'bundle' }> {
  const cleaned = stripAnchor(ref.trim()).replace(/^\.\//, '');
  if (!cleaned) return {};

  const segments = cleaned.split('/');

  if (bundleRoot && !cleaned.startsWith('..')) {
    const fromBundle = path.resolve(bundleRoot, ...segments);
    if (await pathExists(fromBundle)) return { target: fromBundle, via: 'bundle' };
  }

  const fromFile = path.resolve(path.dirname(file), ...segments);
  if (await pathExists(fromFile)) return { target: fromFile, via: 'file' };

  return {};
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
 * Bundle-relative for anything in the same bundle -- the form `hcm` remaps on
 * install. Anything else can only be said relative to the file itself, which is
 * a reference that will not survive installation; the report says so.
 */
function suggestionPath(entry: RefIndexEntry, ref: ResolvedRef): string {
  if (ref.bundleRoot && entry.bundleRoot === ref.bundleRoot) {
    return toPosix(path.relative(ref.bundleRoot, entry.absolute));
  }
  return toPosix(path.relative(path.dirname(ref.file), entry.absolute));
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
