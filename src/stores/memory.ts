// ══════════════════════════════════════════════════════════════
// Hydra Workbench — Memory Store (Zustand) — Barrel Re-export
// Sistema di Apprendimento AI Multi-Livello L1/L2/L3
// Con Promotion Engine, Decay Engine, Retrieval System
// ══════════════════════════════════════════════════════════════

// Re-export all types and constants
export type {
  MemoryLevel,
  MemoryItemType,
  MemoryItem,
  PromotionRecord,
  RetrievalResult,
  PromotionThresholds,
  MemoryStore,
} from './memory-types';

export {
  PROMOTION_THRESHOLDS,
  DECAY_RATES,
  DECAY_MINIMUMS,
  SCORE_WEIGHTS,
} from './memory-types';

// Re-export core store and hook
export { useMemoryStore } from './memory-core';

// Re-export promotion engine
export {
  checkPromotionEligible,
  promoteItem,
  runPromotionScan,
  registerPromotionEngine,
} from './memory-promotion';

// Re-export decay engine
export {
  applyDecay,
  registerDecayEngine,
  getDecaySchedule,
} from './memory-decay';

// Re-export retrieval system
export {
  retrieve,
  retrieveForRAG,
  accessItem,
  getTopResults,
  fullTextSearch,
  getSimilarItems,
  registerRetrievalEngine,
} from './memory-retrieval';

// Re-export sync engine
export {
  syncToSupabase,
  syncFromSupabase,
  syncItemToSupabase,
  registerSyncEngine,
} from './memory-sync';

// Re-export helpers
export {
  getConnections,
  getStats,
  getDetailedStats,
  registerHelperFunctions,
} from './memory-helpers';

// ── Initialize all engines (call this once at app startup) ──

/**
 * Initialize all Hydra Memory engines
 * Call this once during app initialization to register all engine functions
 */
export function initializeMemoryEngines() {
  const { registerPromotionEngine } = require('./memory-promotion');
  const { registerDecayEngine } = require('./memory-decay');
  const { registerRetrievalEngine } = require('./memory-retrieval');
  const { registerSyncEngine } = require('./memory-sync');
  const { registerHelperFunctions } = require('./memory-helpers');

  registerPromotionEngine();
  registerDecayEngine();
  registerRetrievalEngine();
  registerSyncEngine();
  registerHelperFunctions();
}

// Backward compatibility: default export is useMemoryStore
export { useMemoryStore as default };
