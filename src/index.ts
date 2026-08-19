/** Programmatic entry point, for using hcm as a library. */
export { discoverBundleDirs, loadBundle, loadManifest, validateBundle } from './core/bundle.js';
export { readConfig, resolveCacheDir, writeConfig } from './core/config.js';
export {
  appendContext,
  captureContext,
  contextFiles,
  forgetContext,
  inspectContext,
  overrideContext,
  readContextLedger,
  removeContext,
  trackedBundles,
} from './core/context.js';
export { applyPlan } from './core/executor.js';
export {
  ALL_FLAVORS,
  assertFlavorsAvailable,
  expandFlavors,
  hasFlavor,
  inFlavors,
  matchesPattern,
  normalizeFlavors,
} from './core/flavors.js';
export {
  applicableParameters,
  appliesTo,
  applyParameters,
  emptyOverrides,
  mergeOverrides,
  normalizeParameters,
  overridesFor,
  parameterEnvName,
  parameterProblems,
  parseAssignments,
  placeholderNames,
  readParametersFile,
  renderTemplate,
  resolveParameters,
  storableValues,
  summarizeParameters,
  withDefaults,
} from './core/parameters.js';
export { buildPlan } from './core/planner.js';
export { buildRefMap, remapReferences } from './core/refmap.js';
export type {
  BrokenRef,
  FoundRef,
  RefConfidence,
  RefEdit,
  RefPolicy,
  RefScope,
  RefSuggestion,
  RefSyntax,
  ResolvedRef,
  ResolveOptions,
  ScanOptions,
  ScanResult,
} from './core/refs.js';
export {
  applyRefEdits,
  DECLARED_SYNTAXES,
  extractRefs,
  INSTALL_POLICY,
  isExplicitlyRelative,
  isInScope,
  LINK_SYNTAXES,
  REF_SYNTAXES,
  refPolicy,
  resolveRef,
  scanReferences,
  suggestFixes,
} from './core/refs.js';
export { auditInstallation, rollback } from './core/rollback.js';
export { addToRegistry, readRegistry, resolveBundle, resolveBundles } from './core/registry.js';
export { findInstallations, readState, upsertInstallation } from './core/state.js';
export { getTarget, TARGETS, TARGET_IDS } from './targets/index.js';
export * from './core/types.js';
