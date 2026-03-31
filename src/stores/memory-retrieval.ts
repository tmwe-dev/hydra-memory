// ══════════════════════════════════════════════════════════════
// Hydra Memory — Retrieval System & RAG
// ══════════════════════════════════════════════════════════════

import { useMemoryStore } from './memory-core';
import {
  MemoryLevel,
  MemoryItemType,
  RetrievalResult,
  SCORE_WEIGHTS,
} from './memory-types';

// ── Retrieval System ──────────────────────────────────────

/**
 * Retrieve items matching a query with optional filtering
 * Multi-factor scoring with configurable weights
 */
export function retrieve(
  query: string,
  options: { level?: MemoryLevel; limit?: number; type?: MemoryItemType } = {}
): RetrievalResult[] {
  const store = useMemoryStore.getState();
  const q = query.toLowerCase();
  let items = store.items.filter((i) => !i.archived);

  if (options.level) {
    items = items.filter((i) => i.level === options.level);
  }
  if (options.type) {
    items = items.filter((i) => i.type === options.type);
  }

  const scored = items.map((i) => {
    let score = 0;

    // Match titolo
    if (i.title.toLowerCase().includes(q)) score += SCORE_WEIGHTS.titleMatch;

    // Match contenuto
    if (i.content.toLowerCase().includes(q))
      score += SCORE_WEIGHTS.contentMatch;

    // Match tag
    i.tags.forEach((t) => {
      if (t.toLowerCase().includes(q)) score += SCORE_WEIGHTS.tagMatch;
    });

    // Bonus utilità
    score += (i.usefulness / 100) * SCORE_WEIGHTS.usefulnessMax;

    // Bonus confidenza
    score += (i.confidence / 100) * SCORE_WEIGHTS.confidenceMax;

    // Penalità decadimento
    score *= i.relevanceDecay;

    // Boost pinnati
    if (i.pinned) score *= SCORE_WEIGHTS.pinnedMultiplier;

    return { item: i, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit || 10);
}

/**
 * Retrieve items for RAG context injection
 * Formats results as markdown for AI prompts
 */
export function retrieveForRAG(query: string, limit: number = 5): string {
  const results = retrieve(query, { limit });
  if (results.length === 0) return '';

  const context = results.map((r, idx) => {
    const lvl = r.item.level;
    const conf = r.item.confidence;
    return `[${idx + 1}] [${lvl}|conf:${conf}] ${r.item.title}\n${r.item.content.slice(0, 300)}`;
  });

  return `--- Memoria Hydra (${results.length} risultati) ---\n${context.join('\n\n')}`;
}

/**
 * Record item access and boost its relevance
 * FIX H5: Clamp relevance to max 1.0 after boost
 */
export function accessItem(id: string): void {
  const store = useMemoryStore.getState();
  const updatedItems = store.items.map((i) => {
    if (i.id !== id) return i;

    // FIX H5: Clamp relevance to [0.0, 1.0] after boost
    const boostedRelevance = i.relevanceDecay + 0.05;
    const clampedRelevance = Math.min(1.0, boostedRelevance);

    return {
      ...i,
      accessCount: i.accessCount + 1,
      updatedAt: new Date(),
      relevanceDecay: clampedRelevance,
      version: i.version + 1,
    };
  });

  if (updatedItems.some((item, idx) => item !== store.items[idx])) {
    store.items = updatedItems;
  }
}

/**
 * Get top results for a query, useful for display/debugging
 */
export function getTopResults(
  query: string,
  limit: number = 5
): Array<{ id: string; title: string; score: number; level: MemoryLevel }> {
  const results = retrieve(query, { limit });
  return results.map((r) => ({
    id: r.item.id,
    title: r.item.title,
    score: Math.round(r.score * 100) / 100,
    level: r.item.level,
  }));
}

/**
 * Search with full text across multiple fields
 * Returns items matching multiple query terms
 */
export function fullTextSearch(query: string): RetrievalResult[] {
  const store = useMemoryStore.getState();
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);

  if (terms.length === 0) return [];

  let items = store.items.filter((i) => !i.archived);

  // Filter to items matching ANY term
  items = items.filter((i) => {
    const text = `${i.title} ${i.content} ${i.tags.join(' ')}`.toLowerCase();
    return terms.some((term) => text.includes(term));
  });

  // Score by term frequency
  const scored = items.map((i) => {
    const text = `${i.title} ${i.content} ${i.tags.join(' ')}`.toLowerCase();
    let score = 0;

    // Count term matches
    for (const term of terms) {
      const matches = (text.match(new RegExp(term, 'g')) || []).length;
      score += matches;
    }

    // Apply decay multiplier
    score *= i.relevanceDecay;

    // Apply pinned boost
    if (i.pinned) score *= SCORE_WEIGHTS.pinnedMultiplier;

    return { item: i, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * Get items similar to a given item by tags and type
 */
export function getSimilarItems(
  itemId: string,
  limit: number = 5
): RetrievalResult[] {
  const store = useMemoryStore.getState();
  const item = store.items.find((i) => i.id === itemId);

  if (!item) return [];

  let items = store.items.filter(
    (i) => i.id !== itemId && !i.archived
  );

  // Score by shared tags and same type
  const scored = items.map((i) => {
    let score = 0;

    // Bonus for same type
    if (i.type === item.type) score += 5;

    // Bonus for shared tags
    const sharedTags = item.tags.filter((t) => i.tags.includes(t));
    score += sharedTags.length * 3;

    // Apply decay multiplier
    score *= i.relevanceDecay;

    return { item: i, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Register retrieval engine with store
 */
export function registerRetrievalEngine() {
  const store = useMemoryStore.getState();
  store.retrieve = retrieve;
  store.retrieveForRAG = retrieveForRAG;
  store.accessItem = accessItem;
}
