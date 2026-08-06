/** Programmatic entry point, for using hcm as a library. */
export { loadBundle, loadManifest, validateBundle } from './core/bundle.js';
export { applyPlan } from './core/executor.js';
export { buildPlan } from './core/planner.js';
export { auditInstallation, rollback } from './core/rollback.js';
export { addToRegistry, readRegistry, resolveBundle } from './core/registry.js';
export { findInstallations, readState, upsertInstallation } from './core/state.js';
export { getTarget, TARGETS, TARGET_IDS } from './targets/index.js';
export * from './core/types.js';
