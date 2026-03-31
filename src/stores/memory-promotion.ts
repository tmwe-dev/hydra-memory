// ══════════════════════════════════════════════════════════════
// Hydra Memory — Promotion Engine
// ══════════════════════════════════════════════════════════════

import { useMemoryStore } from './memory-core';
import {
  MemoryLevel,
  PROMOTION_THRESHOLDS,
  PromotionRecord,
} from './memory-types';

// ── Promotion Engine ──────────────────────────────────────

/**
 * Check if an item is eligible for promotion
 * Returns eligibility status, reason, and next level if eligible
 */
export function checkPromotionEligible(id: string): {
  eligible: boolean;
  reason: string;
  nextLevel?: MemoryLevel;
} {
  const store = useMemoryStore.getState();
  const item = store.items.find((i) => i.id === id);

  if (!item || item.archived) {
    return { eligible: false, reason: 'Non trovato o archiviato' };
  }
  if (item.level === 'L3') {
    return { eligible: false, reason: 'Già al massimo livello' };
  }

  const nextLevel: MemoryLevel = item.level === 'L1' ? 'L2' : 'L3';
  const key = `${item.level}->${nextLevel}`;
  const thresholds = PROMOTION_THRESHOLDS[key];

  if (!thresholds) {
    return { eligible: false, reason: 'Configurazione promozione non trovata' };
  }

  const reasons: string[] = [];

  if (item.accessCount < thresholds.minAccess) {
    reasons.push(`Accessi: ${item.accessCount}/${thresholds.minAccess}`);
  }
  if (item.usefulness < thresholds.minUsefulness) {
    reasons.push(`Utilità: ${item.usefulness}/${thresholds.minUsefulness}`);
  }
  if (item.confidence < thresholds.minConfidence) {
    reasons.push(`Confidenza: ${item.confidence}/${thresholds.minConfidence}`);
  }
  if (thresholds.requireApproval && !item.approved) {
    reasons.push('Richiede approvazione utente');
  }

  return reasons.length === 0
    ? { eligible: true, reason: 'Pronto per promozione', nextLevel }
    : { eligible: false, reason: reasons.join('; ') };
}

/**
 * Promote a single item to the next level
 * FIX: Use snapshot of items at scan start to avoid TOCTOU issues
 */
export function promoteItem(id: string): boolean {
  const store = useMemoryStore.getState();
  const check = checkPromotionEligible(id);

  if (!check.eligible || !check.nextLevel) return false;

  const item = store.items.find((i) => i.id === id);
  if (!item) return false;

  const now = new Date();
  const promotion: PromotionRecord = {
    id: `promo·${Date.now().toString(36)}`,
    memoryItemId: id,
    fromLevel: item.level,
    toLevel: check.nextLevel,
    confidence: item.confidence,
    promotedByRule: `auto:${item.level}->${check.nextLevel}`,
    sourceRunId: item.runId,
    createdAt: now,
  };

  // Update store with promotion
  store.items = store.items.map((i) =>
    i.id === id
      ? {
          ...i,
          level: check.nextLevel!,
          promotedAt: now,
          promotedFrom: item.level,
          updatedAt: now,
          relevanceDecay: check.nextLevel === 'L3' ? 1.0 : i.relevanceDecay,
          version: i.version + 1,
        }
      : i
  );

  store.promotions = [...store.promotions, promotion];

  return true;
}

/**
 * Run promotion scan on all eligible items
 * FIX: Take snapshot of items at scan start to avoid TOCTOU race conditions
 * This prevents issues where items change state during iteration
 */
export function runPromotionScan(): string[] {
  const store = useMemoryStore.getState();

  // TOCTOU FIX: Snapshot items at scan start
  const itemsSnapshot = [...store.items];
  const promoted: string[] = [];

  for (const item of itemsSnapshot) {
    if (item.archived || item.level === 'L3') continue;

    const check = checkPromotionEligible(item.id);
    if (check.eligible) {
      const success = promoteItem(item.id);
      if (success) promoted.push(item.id);
    }
  }

  return promoted;
}

/**
 * Register promotion engine with store
 * This function patches the store methods to use the promotion engine
 */
export function registerPromotionEngine() {
  const store = useMemoryStore.getState();
  store.checkPromotionEligible = checkPromotionEligible;
  store.promoteItem = promoteItem;
  store.runPromotionScan = runPromotionScan;
}
