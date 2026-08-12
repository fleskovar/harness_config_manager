/**
 * Core domain types.
 *
 * The one genuinely tricky requirement: uninstalling must remove exactly the
 * items a bundle contributed, even when several bundles wrote into the same
 * file (`.mcp.json`, `settings.json`, `reasonix.toml`, `CLAUDE.md`) and the
 * file has been reordered or reformatted since.
 *
 * So we never record line numbers or diffs. Each write leaves a `Receipt`
 * expressed in terms the format itself understands:
 *   JSON     -> structural pointer + hash of the value we wrote
 *   TOML/MD  -> comment-delimited marker block
 *   files    -> path + content hash
 */

export type TargetId = 'claude-code' | 'copilot' | 'reasonix' | 'opencode' | 'pi';

export type Scope = 'project' | 'user';

/** Harness-neutral resource kinds. Each target decides where they land. */
export type ResourceKind =
  | 'subagent' // delegated worker with its own prompt and tool access
  | 'skill' // directory bundling SKILL.md plus supporting files
  | 'command' // slash-command prompt template
  | 'rule' // path-scoped instructions
  | 'context' // always-loaded instructions (CLAUDE.md and friends)
  | 'mcp' // MCP server definition
  | 'settings' // settings fragment merged into harness config
  | 'asset'; // copied verbatim

/** Bundle directory name -> canonical kind. This is the whole bundle schema. */
export const KIND_DIRECTORIES: Record<string, ResourceKind> = {
  subagents: 'subagent',
  skills: 'skill',
  commands: 'command',
  rules: 'rule',
  context: 'context',
  mcp: 'mcp',
  settings: 'settings',
  assets: 'asset',
};

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface BundleManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  tags?: string[];
  /** Targets this bundle supports. Defaults to all. */
  targets?: TargetId[];
}

// ---------------------------------------------------------------------------
// Loaded bundle
// ---------------------------------------------------------------------------

export interface BundleResource {
  kind: ResourceKind;
  /** Logical name, e.g. `code-reviewer`. */
  name: string;
  /** Path relative to the bundle root, POSIX separators. */
  bundlePath: string;
  /** Absolute path to the primary file (the .md, the .json, the SKILL.md). */
  primaryFile: string;
  /** For skills/assets: every file, with paths relative to the resource root. */
  files: { absolutePath: string; relativePath: string }[];
  /** Parsed frontmatter, for markdown resources. */
  frontmatter: Record<string, unknown>;
  /** Markdown body, for markdown resources. */
  body?: string;
  /** Parsed payload, for mcp/settings resources. */
  data?: unknown;
}

export interface LoadedBundle {
  manifest: BundleManifest;
  root: string;
  resources: BundleResource[];
  source: BundleSource;
}

// ---------------------------------------------------------------------------
// Sources & registry
// ---------------------------------------------------------------------------

export type BundleSource =
  | { type: 'local'; path: string }
  | { type: 'github'; owner: string; repo: string; ref: string; subdir?: string };

export interface RegistryEntry {
  /**
   * Short alphanumeric handle -- `1`, `2`, ... `a`, `b` -- usable anywhere a
   * bundle name is. Assigned on registration and stable until the entry goes.
   */
  id: string;
  name: string;
  /** Where the bundle came from, and where `hcm update` re-reads it. */
  source: BundleSource;
  version?: string;
  description?: string;
  tags?: string[];
  /**
   * Directory name inside the store holding this bundle's files. Absent for
   * `--dev` entries, which are read from `source` in place.
   */
  store?: string;
  /** Registered with `--dev`: referenced in place so edits take effect at once. */
  dev?: boolean;
  addedAt?: string;
  updatedAt?: string;
}

export interface RegistryFile {
  version: 1;
  entries: RegistryEntry[];
}

// ---------------------------------------------------------------------------
// Receipts -- the rollback ledger
// ---------------------------------------------------------------------------

/** A whole file we wrote. */
export interface FileReceipt {
  op: 'file';
  /** Scope-root-relative POSIX path. */
  path: string;
  /** sha256 of the bytes we wrote. */
  hash: string;
  /**
   * The item was already there, byte-for-byte what we would have written, and
   * nobody claimed it. We adopt it -- the bundle depends on it, but it is not
   * ours to delete, so uninstall leaves it alone.
   */
  preexisting?: boolean;
}

/** A value merged into a JSON document at `pointer` (a list of object keys). */
export interface JsonValueReceipt {
  op: 'json-value';
  path: string;
  pointer: string[];
  /** sha256 of the canonical JSON of the value we wrote. */
  hash: string;
  /** Restored on uninstall when we overwrote something. */
  previous?: unknown;
  hadPrevious: boolean;
  /** Adopted rather than written -- see `FileReceipt.preexisting`. */
  preexisting?: boolean;
}

/** Items appended to a JSON array; removed by value hash, so order is irrelevant. */
export interface JsonArrayItemReceipt {
  op: 'json-array-item';
  path: string;
  pointer: string[];
  /** sha256 of each appended item. */
  hashes: string[];
}

/** A marker-delimited block in a comment-supporting text format. */
export interface BlockReceipt {
  op: 'block';
  path: string;
  blockId: string;
  syntax: 'markdown' | 'toml';
}

export type Receipt = FileReceipt | JsonValueReceipt | JsonArrayItemReceipt | BlockReceipt;

/** True for receipts recording an item we adopted rather than wrote. */
export function isPreexisting(receipt: Receipt): boolean {
  return (receipt.op === 'file' || receipt.op === 'json-value') && receipt.preexisting === true;
}

export function describeReceipt(receipt: Receipt): string {
  switch (receipt.op) {
    case 'file':
      return receipt.path;
    case 'json-value':
      return `${receipt.path} → ${receipt.pointer.join('.')}`;
    case 'json-array-item':
      return `${receipt.path} → ${receipt.pointer.join('.')}[] (${receipt.hashes.length})`;
    case 'block':
      return `${receipt.path} → block ${receipt.blockId}`;
  }
}

// ---------------------------------------------------------------------------
// Installation state
// ---------------------------------------------------------------------------

export interface InstallationRecord {
  /** `${bundle}@${target}@${scope}` */
  id: string;
  bundle: string;
  version: string;
  target: TargetId;
  scope: Scope;
  source: BundleSource;
  installedAt: string;
  receipts: Receipt[];
}

export interface StateFile {
  version: 1;
  installations: InstallationRecord[];
}

export function installationId(bundle: string, target: TargetId, scope: Scope): string {
  return `${bundle}@${target}@${scope}`;
}

// ---------------------------------------------------------------------------
// The context cache
// ---------------------------------------------------------------------------

/**
 * Where one context section has been written. A section installed into two
 * harnesses has two placements; OpenCode and Pi both write `AGENTS.md`, so two
 * placements can name the same file.
 */
export interface ContextPlacement {
  target: TargetId;
  /** Scope-root-relative POSIX path of the instruction file. */
  path: string;
  /** The marker block id, the same one the install receipt records. */
  blockId: string;
  /** When hcm last wrote this section into that file. */
  updatedAt: string;
}

/**
 * One `context/<name>.md` from a bundle, cached under `.hcm` so it can be put
 * back after something rewrote the harness's instruction file.
 */
export interface ContextSection {
  bundle: string;
  name: string;
  /** Position within its bundle, taken from the order of the bundle's files. */
  order: number;
  /** Path of the cached copy, relative to the context cache directory. */
  file: string;
  /** sha256 of the cached body. */
  hash: string;
  capturedAt: string;
  placements: ContextPlacement[];
}

export interface ContextLedger {
  version: 1;
  sections: ContextSection[];
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type PlanPayload =
  | { kind: 'file'; contents: string | Buffer }
  | { kind: 'json-value'; pointer: string[]; value: unknown }
  | { kind: 'json-array-item'; pointer: string[]; items: unknown[] }
  | { kind: 'block'; blockId: string; syntax: 'markdown' | 'toml'; body: string };

export interface PlanAction {
  /** Scope-root-relative POSIX path of the file being touched. */
  path: string;
  /** Shown by --dry-run. */
  describe: string;
  payload: PlanPayload;
  /**
   * The bundle resource this write came from. Targets do not set it -- the
   * planner attaches it, so conflicts can be resolved a resource at a time
   * rather than a file at a time (one skill is many files, one decision).
   */
  resource?: BundleResource;
  /** Already present and identical: record it, but do not write or own it. */
  adopt?: boolean;
}

/** Stable key for "the same resource", used to group and remember decisions. */
export function resourceKey(resource: BundleResource): string {
  return `${resource.kind}:${resource.name}`;
}

export interface PlanConflict {
  path: string;
  detail: string;
  /** The bundle that already owns the item, when known. */
  owner?: string;
  /** The resource whose write collided, when known. */
  resource?: BundleResource;
  /** Set for JSON conflicts, so a resolution can name the colliding key. */
  pointer?: string[];
}

export interface InstallPlan {
  bundle: LoadedBundle;
  target: TargetId;
  scope: Scope;
  /** Absolute root the action paths are relative to. */
  scopeRoot: string;
  actions: PlanAction[];
  conflicts: PlanConflict[];
  skipped: { resource: BundleResource; reason: string }[];
}
