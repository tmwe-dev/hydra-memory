// ══════════════════════════════════════════════════════════════
// Hydra Memory — Knowledge Graph & Stats Helpers
// ══════════════════════════════════════════════════════════════

import { useMemoryStore } from './memory-core';
import { MemoryLevel } from './memory-types';

// ── Knowledge Graph ───────────────────────────────────────

/**
 * Get connections between memory items via tags, runs, and promotions
 */
export function getConnections(): Array<{
  from: string;
  to: string;
  type: 'tag' | 'run' | 'promotion';
}> {
  const store = useMemoryStore.getState();
  const items = store.items.filter((i) => !i.archived);
  const connections: Array<{ from: string; to: string; type: 'tag' | 'run' | 'promotion' }> = [];

  // Connessioni per tag condivisi
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const sharedTags = items[a].tags.filter((t) =>
        items[b].tags.includes(t)
      );
      if (sharedTags.length > 0) {
        connections.push({
          from: items[a].id,
          to: items[b].id,
          type: 'tag',
        });
      }
    }
  }

  // Connessioni per run condivise
  const byRun: Record<string, string[]> = {};
  for (const item of items) {
    if (item.runId) {
      if (!byRun[item.runId]) byRun[item.runId] = [];
      byRun[item.runId].push(item.id);
    }
  }
  for (const ids of Object.values(byRun)) {
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        connections.push({ from: ids[a], to: ids[b], type: 'run' });
      }
    }
  }

  // Connessioni di promozione
  for (const item of items) {
    if (item.promotedFrom) {
      const parent = items.find(
        (i) =>
          i.level === item.promotedFrom &&
          i.tags.some((t) => item.tags.includes(t))
      );
      if (parent) {
        connections.push({
          from: parent.id,
          to: item.id,
          type: 'promotion',
        });
      }
    }
  }

  return connections;
}

// ── Stats ──────────────────────────────────────────────

/**
 * Get comprehensive statistics about the memory store
 */
export function getStats(): {
  total: number;
  byLevel: Record<MemoryLevel, number>;
  byType: Record<string, number>;
  promotionsToday: number;
  avgConfidence: number;
  avgUsefulness: number;
} {
  const store = useMemoryStore.getState();
  const items = store.items.filter((i) => !i.archived);
  const promotions = store.promotions;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const byLevel: Record<MemoryLevel, number> = { L1: 0, L2: 0, L3: 0 };
  const byType: Record<string, number> = {};
  let totalConf = 0;
  let totalUse = 0;

  for (const item of items) {
    byLevel[item.level]++;
    byType[item.type] = (byType[item.type] || 0) + 1;
    totalConf += item.confidence;
    totalUse += item.usefulness;
  }

  const promotionsToday = promotions.filter((p) => new Date(p.createdAt) >= today).length;

  return {
    total: items.length,
    byLevel,
    byType,
    promotionsToday,
    avgConfidence: items.length > 0 ? Math.round(totalConf / items.length) : 0,
    avgUsefulness: items.length > 0 ? Math.round(totalUse / items.length) : 0,
  };
}

/**
 * Get detailed statistics including level-by-type breakdown
 */
export function getDetailedStats(): {
  total: number;
  byLevel: Record<MemoryLevel, number>;
  byType: Record<string, number>;
  byLevelAndType: Record<
    MemoryLevel,
    Record<string, number>
  >;
  promotionsToday: number;
  avgConfidence: number;
  avgUsefulness: number;
  avgAccessCount: number;
  avgRelevanceDecay: number;
  pinnedCount: number;
  approvedCount: number;
  archivedCount: number;
} {
  const store = useMemoryStore.getState();
  const items = store.items;
  const activeItems = items.filter((i) => !i.archived);
  const promotions = store.promotions;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const byLevel: Record<MemoryLevel, number> = { L1: 0, L2: 0, L3: 0 };
  const byType: Record<string, number> = {};
  const byLevelAndType: Record<MemoryLevel, Record<string, number>> = {
    L1: {},
    L2: {},
    L3: {},
  };

  let totalConf = 0;
  let totalUse = 0;
  let totalAccess = 0;
  let totalDecay = 0;
  let pinnedCount = 0;
  let approvedCount = 0;
  let archivedCount = 0;

  for (const item of items) {
    if (item.archived) {
      archivedCount++;
    } else {
      byLevel[item.level]++;
      byType[item.type] = (byType[item.type] || 0) + 1;
      byLevelAndType[item.level][item.type] =
        (byLevelAndType[item.level][item.type] || 0) + 1;
      totalConf += item.confidence;
      totalUse += item.usefulness;
      totalAccess += item.accessCount;
      totalDecay += item.relevanceDecay;

      if (item.pinned) pinnedCount++;
      if (item.approved) approvedCount++;
    }
  }

  const promotionsToday = promotions.filter((p) => new Date(p.createdAt) >= today).length;

  return {
    total: items.length,
    byLevel,
    byType,
    byLevelAndType,
    promotionsToday,
    avgConfidence:
      activeItems.length > 0 ? Math.round(totalConf / activeItems.length) : 0,
    avgUsefulness:
      activeItems.length > 0 ? Math.round(totalUse / activeItems.length) : 0,
    avgAccessCount:
      activeItems.length > 0 ? Math.round(totalAccess / activeItems.length) : 0,
    avgRelevanceDecay:
      activeItems.length > 0 ? Math.round((totalDecay / activeItems.length) * 100) / 100 : 0,
    pinnedCount,
    approvedCount,
    archivedCount,
  };
}

/**
 * Register helper functions with store
 */
export function registerHelperFunctions() {
  const store = useMemoryStore.getState();
  store.getConnections = getConnections;
  store.getStats = getStats;
}
