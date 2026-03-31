// ══════════════════════════════════════════════════════════════
// Hydra Memory — Decay Engine
// ══════════════════════════════════════════════════════════════

import { useMemoryStore } from './memory-core';
import { DECAY_RATES, DECAY_MINIMUMS } from './memory-types';

// ── Decay Engine ──────────────────────────────────────────

/**
 * Apply decay to all items based on their level and last update time
 * FIX H5: Ensure relevance stays clamped to [0, 1]
 * FIX: Validate date fields before computing decay
 */
export function applyDecay(): void {
  const store = useMemoryStore.getState();

  const updatedItems = store.items.map((i) => {
    // Pinned, archived, L3 non decadono
    if (i.archived || i.pinned) return i;
    if (i.level === 'L3') return i;

    // FIX: Validate date fields before computing decay
    let updatedAtDate: Date;
    try {
      updatedAtDate = i.updatedAt instanceof Date ? i.updatedAt : new Date(i.updatedAt);
      if (isNaN(updatedAtDate.getTime())) {
        console.warn(`[Hydra Memory] Invalid updatedAt date for item ${i.id}, using current date`);
        return i;
      }
    } catch (err) {
      console.warn(`[Hydra Memory] Error parsing updatedAt for item ${i.id}:`, err);
      return i;
    }

    const daysSinceUpdate = (Date.now() - updatedAtDate.getTime()) / 86400000;
    const decayRate = DECAY_RATES[i.level];
    const minimum = DECAY_MINIMUMS[i.level];
    const newDecay = Math.max(minimum, i.relevanceDecay - daysSinceUpdate * decayRate);

    // FIX H5: Clamp relevance to [0, 1]
    const clampedDecay = Math.max(0, Math.min(1, newDecay));

    return clampedDecay !== i.relevanceDecay
      ? {
          ...i,
          relevanceDecay: clampedDecay,
          updatedAt: i.updatedAt, // Don't change updatedAt on decay
          version: i.version, // Don't increment version on automatic decay
        }
      : i;
  });

  // Only update if there were changes
  if (updatedItems.some((item, idx) => item !== store.items[idx])) {
    store.items = updatedItems;
  }
}

/**
 * Register decay engine with store
 */
export function registerDecayEngine() {
  const store = useMemoryStore.getState();
  store.applyDecay = applyDecay;
}

/**
 * Get decay schedule recommendation for an item
 * Returns estimated days until item reaches minimum decay
 */
export function getDecaySchedule(itemId: string): {
  itemId: string;
  currentRelevance: number;
  daysUntilMinimum: number;
  minimumRelevance: number;
} | null {
  const store = useMemoryStore.getState();
  const item = store.items.find((i) => i.id === itemId);

  if (!item) return null;

  const decayRate = DECAY_RATES[item.level];
  const minimum = DECAY_MINIMUMS[item.level];

  if (decayRate === 0 || item.relevanceDecay <= minimum) {
    return {
      itemId,
      currentRelevance: item.relevanceDecay,
      daysUntilMinimum: Infinity,
      minimumRelevance: minimum,
    };
  }

  const daysUntilMinimum = (item.relevanceDecay - minimum) / decayRate;

  return {
    itemId,
    currentRelevance: item.relevanceDecay,
    daysUntilMinimum: Math.ceil(daysUntilMinimum),
    minimumRelevance: minimum,
  };
}
