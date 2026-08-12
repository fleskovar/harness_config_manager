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
export { buildPlan } from './core/planner.js';
export { auditInstallation, rollback } from './core/rollback.js';
export { addToRegistry, readRegistry, resolveBundle, resolveBundles } from './core/registry.js';
export { findInstallations, readState, upsertInstallation } from './core/state.js';
export { getTarget, TARGETS, TARGET_IDS } from './targets/index.js';
export * from './core/types.js';
