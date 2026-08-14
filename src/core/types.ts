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

/**
 * Facts about the machine being installed into that change how a target maps
 * resources -- not preferences, but what is actually there to install onto.
 *
 * These are recorded with the installation, so `hcm update` reinstalls into the
 * same places without being told again.
 */
export interface TargetOptions {
  /**
   * The `pi-subagents` extension is installed, so Pi has real sub-agents and a
   * directory to file them in (`.pi/agents/`) instead of only skills.
   * https://github.com/nicobailon/pi-subagents
   */
  piSubagents?: boolean;
}

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

/**
 * One entry of a manifest's `dependencies`.
 *
 * A bundle that describes how to work with the team's JIRA board is worth
 * writing once and requiring from the half-dozen bundles that assume it. The
 * dependency names the bundle; `version` says which releases will do; `source`
 * says where to get it when the machine has never heard of it.
 *
 * Authored either as a string (`jira-board`, `jira-board@^1.2.0`) or as a
 * mapping; `normalizeDependencies` turns both into this shape.
 */
export interface BundleDependency {
  name: string;
  /** Semver range; absent means any version will do. See `core/semver.ts`. */
  version?: string;
  /**
   * Where to fetch it from when it is not registered and not a sibling in the
   * same collection -- any reference `hcm install` accepts.
   */
  source?: string;
}

/**
 * A flavor as it is written down for people: a name, and what it is for.
 *
 * This much is stored in the registry, so `hcm registry list` can say what a
 * bundle can be narrowed to without reading the bundle's files.
 */
export interface FlavorSummary {
  name: string;
  description?: string;
}

/**
 * A flavor as the installer uses it: the summary, plus the bundle-relative path
 * patterns whose resources belong to it.
 *
 * `includes` is how `mcp/`, `settings/` and `assets/` join a flavor -- they have
 * no frontmatter to write `flavors:` in. Empty when every member declares
 * itself.
 */
export interface FlavorDefinition extends FlavorSummary {
  includes: string[];
}

/**
 * How `flavors:` may be written in a manifest -- names alone, names with a
 * description, or names with patterns. `normalizeFlavors` turns all three into
 * `FlavorDefinition[]`.
 */
export type FlavorDeclaration =
  | string[]
  | Record<string, string | null | { description?: string; includes?: string | string[] }>;

export interface BundleManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  tags?: string[];
  /** Targets this bundle supports. Defaults to all. */
  targets?: TargetId[];
  /** Bundles that have to be installed for this one to work. */
  dependencies?: (string | BundleDependency)[];
  /** Subsets this bundle can be installed as. See `core/flavors.ts`. */
  flavors?: FlavorDeclaration;
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
  /** Parsed frontmatter, for markdown resources. Any `flavors:` is taken out. */
  frontmatter: Record<string, unknown>;
  /** Markdown body, for markdown resources. */
  body?: string;
  /** Parsed payload, for mcp/settings resources. */
  data?: unknown;
  /**
   * The flavors this resource belongs to, from its own frontmatter and from the
   * manifest's patterns. Empty means *common*: it installs whatever was asked
   * for. See `core/flavors.ts`.
   */
  flavors: string[];
}

export interface LoadedBundle {
  manifest: BundleManifest;
  root: string;
  resources: BundleResource[];
  source: BundleSource;
  /** `manifest.dependencies`, in one shape, validated at load time. */
  dependencies: BundleDependency[];
  /**
   * Every flavor this bundle has: what the manifest declares, or -- when it
   * declares none -- whatever its resources named for themselves.
   */
  flavors: FlavorDefinition[];
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
   * What the bundle's manifest required when it was registered, so the tree can
   * be shown without reading every stored bundle from disk.
   */
  dependencies?: BundleDependency[];
  /**
   * The subsets it can be installed as, as its manifest had them when it was
   * registered -- so `hcm registry list` and `hcm list` can offer them without
   * reading every stored bundle from disk.
   */
  flavors?: FlavorSummary[];
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

/** A dependency as it stood when the dependent was installed. */
export interface InstalledDependency {
  name: string;
  /** The version actually installed, not the range that was asked for. */
  version: string;
  /** The range the manifest asked for, when it asked for one. */
  range?: string;
}

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
  /**
   * What the target was told about this machine. Absent means the defaults --
   * which is what every record written before these existed meant too.
   */
  targetOptions?: TargetOptions;
  /**
   * The flavors this installation was narrowed to. Absent means the whole
   * bundle -- which is what every record written before flavors existed meant.
   * `hcm update` reinstalls the same subset without being told again.
   */
  flavors?: string[];
  /**
   * The bundles this one required, resolved at install time. `hcm uninstall`
   * reads these to know what is still needed, and what has been orphaned.
   */
  dependencies?: InstalledDependency[];
  /**
   * Pulled in to satisfy somebody else's dependency rather than asked for.
   * Uninstalling the last bundle that needed it takes it away again.
   */
  auto?: boolean;
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
  /**
   * Another installation already wrote exactly this item. Nothing needs
   * writing, but we do claim it: the item stays until the last claimant goes.
   * This is how two bundles ship the same shared asset without a second copy
   * and without one uninstall breaking the other.
   */
  share?: boolean;
  /**
   * For appends to a JSON array: hashes of items another installation already
   * contributed. They are recorded as ours too, so the item survives until
   * every bundle that wanted it has gone.
   */
  shareItems?: string[];
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

/**
 * What became of the bundle's internal file references on the way into this
 * target -- see `core/refmap.ts`. Reported rather than silently applied: a
 * reference that could not be remapped is one the agent will follow anyway.
 */
export interface PlanReferences {
  /** Rewritten to match where the file landed. */
  rewrites: { path: string; from: string; to: string }[];
  /** Pointed at a bundle file this target does not install. */
  dropped: { path: string; ref: string; reason: string }[];
}

export interface InstallPlan {
  bundle: LoadedBundle;
  target: TargetId;
  scope: Scope;
  /** Carried on the plan so a resolved conflict can regenerate actions the same way. */
  targetOptions: TargetOptions;
  /** The flavors asked for. Empty is the whole bundle. */
  flavors: string[];
  /** Absolute root the action paths are relative to. */
  scopeRoot: string;
  actions: PlanAction[];
  conflicts: PlanConflict[];
  skipped: { resource: BundleResource; reason: string }[];
  /** Absent on plans built before references were remapped. */
  references?: PlanReferences;
}
