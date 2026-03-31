// ══════════════════════════════════════════════════════════════
// Conflict Resolver
// Gestisce fatti contraddittori nella memoria Hydra
// Rileva, classifica e risolve conflitti tra memory items
// ══════════════════════════════════════════════════════════════

import { useMemoryStore, type MemoryItem, type MemoryLevel } from '@/stores/memory';
import { supabase } from '@/lib/supabase';

// ── Types ───────────────────────────────────────────────────

export interface Conflict {
  id: string;
  itemA: MemoryItem;
  itemB: MemoryItem;
  type: ConflictType;
  similarity: number;       // 0-1 quanto sono simili
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  suggestedResolution: ResolutionStrategy;
  resolvedAt?: Date;
  resolvedBy?: 'auto' | 'user' | 'ai';
  resolution?: string;
}

export type ConflictType =
  | 'contradiction'     // Stesso argomento, contenuto opposto
  | 'duplicate'         // Contenuto quasi identico
  | 'superseded'        // Versione più recente dello stesso fatto
  | 'scope_overlap';    // Regole con ambito sovrapposto

export type ResolutionStrategy =
  | 'keep_higher_level'     // Mantieni L3 > L2 > L1
  | 'keep_higher_confidence' // Mantieni quello con confidence maggiore
  | 'keep_newer'            // Mantieni il più recente
  | 'merge'                 // Combina i due item
  | 'ask_user'              // Richiedi decisione umana
  | 'archive_both';         // Archivia entrambi (conflitto irrisolvibile)

export interface ConflictResolutionLog {
  id: string;
  conflictId: string;
  timestamp: Date;
  strategy: ResolutionStrategy;
  userNote?: string;
  beforeSnapshots: {
    itemA: MemoryItem;
    itemB: MemoryItem;
  };
  afterSnapshots: {
    itemA?: MemoryItem;
    itemB?: MemoryItem;
  };
  resolvedBy: 'auto' | 'user' | 'ai';
}

export interface ConflictResolverOptions {
  duplicateThreshold?: number;           // Default: 0.95
  contradictionThresholdMin?: number;    // Default: 0.7
  contradictionThresholdMax?: number;    // Default: 0.85
  initialSimilarityThreshold?: number;   // Default: 0.5
  archiveUndoWindowHours?: number;       // Default: 24
}

// ── State Management ───────────────────────────────────────

// Global resolution history and pending archives
let resolutionLogs: ConflictResolutionLog[] = [];
let pendingArchives: Map<string, { itemId: string; archiveAt: Date }> = new Map();

export function initializeConflictResolver(options?: ConflictResolverOptions): void {
  // Initialize any resolver state
  resolutionLogs = [];
  pendingArchives = new Map();
}

export function getResolutionLogs(): ConflictResolutionLog[] {
  return [...resolutionLogs];
}

// ── Conflict Detection ──────────────────────────────────────

/**
 * Scansiona la memoria per conflitti potenziali
 * Usa inverted index per tag overlap per ridurre da O(n²) a O(n * avg_tags * avg_items_per_tag)
 */
export function detectConflicts(options?: ConflictResolverOptions): Conflict[] {
  const store = useMemoryStore.getState();
  const items = store.items.filter((i) => !i.archived && !(i as any)._pendingArchive);
  const conflicts: Conflict[] = [];
  const opts = {
    initialSimilarityThreshold: options?.initialSimilarityThreshold ?? 0.5,
  };

  // Build inverted index: Map<tag, Set<itemId>>
  const tagIndex = new Map<string, Set<string>>();
  for (const item of items) {
    for (const tag of item.tags) {
      if (!tagIndex.has(tag)) {
        tagIndex.set(tag, new Set());
      }
      tagIndex.get(tag)!.add(item.id);
    }
  }

  // Only compare items that share at least one tag
  const comparedPairs = new Set<string>();
  for (const itemsWithTag of tagIndex.values()) {
    const itemArray = Array.from(itemsWithTag);
    for (let a = 0; a < itemArray.length; a++) {
      for (let b = a + 1; b < itemArray.length; b++) {
        const itemA = items.find(i => i.id === itemArray[a]);
        const itemB = items.find(i => i.id === itemArray[b]);
        if (!itemA || !itemB) continue;

        // Skip if already compared or types differ
        const pairKey = `${itemA.id}|${itemB.id}`;
        if (comparedPairs.has(pairKey) || itemA.type !== itemB.type) continue;
        comparedPairs.add(pairKey);

        // Calcola similarità
        const similarity = computeSimilarity(itemA, itemB);
        if (similarity < opts.initialSimilarityThreshold) continue;

        // Classifica il conflitto
        const conflict = classifyConflict(itemA, itemB, similarity, options);
        if (conflict) {
          conflicts.push(conflict);
        }
      }
    }
  }

  return conflicts.sort((a, b) => {
    const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
    return severityOrder[b.severity] - severityOrder[a.severity];
  });
}

/**
 * Rileva conflitti usando embeddings vettoriali (server-side)
 * Molto più accurato del metodo locale
 */
export async function detectConflictsWithEmbeddings(
  userId: string,
  options?: ConflictResolverOptions
): Promise<Conflict[]> {
  const store = useMemoryStore.getState();
  const items = store.items.filter((i) => !i.archived && !(i as any)._pendingArchive);
  const conflicts: Conflict[] = [];

  // Per ogni item, cerca simili via pgvector
  for (const item of items) {
    try {
      const { data } = await supabase.rpc('find_similar_items', {
        p_item_id: item.id,
        p_threshold: 0.85,
        p_limit: 3,
      });

      if (data && data.length > 0) {
        for (const similar of data) {
          const otherItem = items.find((i) => i.id === similar.id);
          if (!otherItem) continue;

          // Evita duplicati (A-B e B-A)
          const existingConflict = conflicts.find(
            (c) =>
              (c.itemA.id === item.id && c.itemB.id === otherItem.id) ||
              (c.itemA.id === otherItem.id && c.itemB.id === item.id)
          );
          if (existingConflict) continue;

          const conflict = classifyConflict(item, otherItem, similar.similarity, options);
          if (conflict) conflicts.push(conflict);
        }
      }
    } catch {
      // Fallback silenzioso se pgvector non disponibile
    }
  }

  return conflicts.sort((a, b) => {
    const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
    return severityOrder[b.severity] - severityOrder[a.severity];
  });
}

// ── Similarity Computation (locale) ─────────────────────────

function computeSimilarity(a: MemoryItem, b: MemoryItem): number {
  let score = 0;
  let weights = 0;

  // Title similarity (Jaccard su parole)
  const titleSimA = new Set(a.title.toLowerCase().split(/\s+/));
  const titleSimB = new Set(b.title.toLowerCase().split(/\s+/));
  const titleIntersection = [...titleSimA].filter((w) => titleSimB.has(w)).length;
  const titleUnion = new Set([...titleSimA, ...titleSimB]).size;
  if (titleUnion > 0) {
    score += (titleIntersection / titleUnion) * 4;
    weights += 4;
  }

  // Content similarity (Jaccard su parole significative, >3 chars)
  const contentWordsA = new Set(
    a.content.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
  );
  const contentWordsB = new Set(
    b.content.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
  );
  const contentIntersection = [...contentWordsA].filter((w) => contentWordsB.has(w)).length;
  const contentUnion = new Set([...contentWordsA, ...contentWordsB]).size;
  if (contentUnion > 0) {
    score += (contentIntersection / contentUnion) * 3;
    weights += 3;
  }

  // Tag overlap
  const sharedTags = a.tags.filter((t) => b.tags.includes(t)).length;
  const totalTags = new Set([...a.tags, ...b.tags]).size;
  if (totalTags > 0) {
    score += (sharedTags / totalTags) * 2;
    weights += 2;
  }

  // Same source bonus
  if (a.source === b.source) {
    score += 1;
    weights += 1;
  }

  return weights > 0 ? score / weights : 0;
}

// ── Conflict Classification ─────────────────────────────────

function classifyConflict(
  a: MemoryItem,
  b: MemoryItem,
  similarity: number,
  options?: ConflictResolverOptions
): Conflict | null {
  const id = `conflict·${Date.now().toString(36)}·${Math.random().toString(36).slice(2, 6)}`;

  const opts = {
    duplicateThreshold: options?.duplicateThreshold ?? 0.95,
    contradictionThresholdMin: options?.contradictionThresholdMin ?? 0.7,
    contradictionThresholdMax: options?.contradictionThresholdMax ?? 0.85,
  };

  // Duplicato: similarità molto alta (0.95 threshold for higher bar)
  if (similarity >= opts.duplicateThreshold) {
    return {
      id,
      itemA: a,
      itemB: b,
      type: 'duplicate',
      similarity,
      severity: a.level === 'L3' || b.level === 'L3' ? 'high' : 'medium',
      description: `"${a.title}" e "${b.title}" sembrano duplicati (${(similarity * 100).toFixed(0)}% simili)`,
      suggestedResolution: suggestResolution(a, b, 'duplicate'),
    };
  }

  // Superseded: stesso tipo, uno più recente
  if (similarity >= 0.7 && a.type === b.type) {
    const newer = new Date(a.updatedAt) > new Date(b.updatedAt) ? a : b;
    const older = newer === a ? b : a;

    if (newer.confidence > older.confidence + 10) {
      return {
        id,
        itemA: older,
        itemB: newer,
        type: 'superseded',
        similarity,
        severity: 'medium',
        description: `"${older.title}" potrebbe essere stato superato da "${newer.title}"`,
        suggestedResolution: 'keep_newer',
      };
    }
  }

  // Contradiction: tighter range (0.7-0.85) with less false positives
  if (similarity >= opts.contradictionThresholdMin && similarity < opts.contradictionThresholdMax) {
    const titleSim = jaccardSimilarity(
      a.title.toLowerCase().split(/\s+/),
      b.title.toLowerCase().split(/\s+/)
    );
    const contentSim = jaccardSimilarity(
      a.content.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
      b.content.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
    );

    // Titoli simili ma contenuto divergente = potenziale contraddizione
    if (titleSim > 0.6 && contentSim < 0.4) {
      return {
        id,
        itemA: a,
        itemB: b,
        type: 'contradiction',
        similarity,
        severity: (a.level === 'L3' || b.level === 'L3') ? 'critical' : 'high',
        description: `"${a.title}" e "${b.title}" hanno argomento simile ma contenuto divergente`,
        suggestedResolution: suggestResolution(a, b, 'contradiction'),
      };
    }
  }

  // Scope overlap: regole con ambito sovrapposto
  if (a.type === 'rule' && b.type === 'rule' && similarity >= 0.5) {
    return {
      id,
      itemA: a,
      itemB: b,
      type: 'scope_overlap',
      similarity,
      severity: 'medium',
      description: `Le regole "${a.title}" e "${b.title}" hanno ambito sovrapposto`,
      suggestedResolution: 'merge',
    };
  }

  return null;
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

function suggestResolution(a: MemoryItem, b: MemoryItem, type: ConflictType): ResolutionStrategy {
  // Se livelli diversi, mantieni il più alto
  if (a.level !== b.level) return 'keep_higher_level';

  // Se L3, chiedi sempre all'utente
  if (a.level === 'L3') return 'ask_user';

  // Per contraddizioni, usa confidence
  if (type === 'contradiction') {
    const diff = Math.abs(a.confidence - b.confidence);
    return diff > 20 ? 'keep_higher_confidence' : 'ask_user';
  }

  // Per duplicati, mantieni il più recente e con più accessi
  if (type === 'duplicate') {
    return 'keep_newer';
  }

  return 'merge';
}

// ── Resolution Execution ────────────────────────────────────

/**
 * Applica una risoluzione a un conflitto con logging completo
 * Never auto-resolve if either item is L3 or pinned
 * High-severity conflicts require explicit user confirmation
 */
export function resolveConflict(
  conflict: Conflict,
  strategy: ResolutionStrategy,
  userNote?: string,
  resolvedBy: 'auto' | 'user' | 'ai' = 'user',
  options?: ConflictResolverOptions
): void {
  const store = useMemoryStore.getState();
  const logId = `log·${Date.now().toString(36)}·${Math.random().toString(36).slice(2, 6)}`;
  const opts = {
    archiveUndoWindowHours: options?.archiveUndoWindowHours ?? 24,
  };

  // Create before snapshots
  const beforeSnapshots = {
    itemA: JSON.parse(JSON.stringify(conflict.itemA)),
    itemB: JSON.parse(JSON.stringify(conflict.itemB)),
  };

  const afterSnapshots: { itemA?: MemoryItem; itemB?: MemoryItem } = {};

  switch (strategy) {
    case 'keep_higher_level': {
      const levelOrder: Record<MemoryLevel, number> = { L1: 1, L2: 2, L3: 3 };
      const keep = levelOrder[conflict.itemA.level] >= levelOrder[conflict.itemB.level]
        ? conflict.itemA : conflict.itemB;
      const discard = keep === conflict.itemA ? conflict.itemB : conflict.itemA;

      // Mark for soft-delete instead of immediate archiving
      markForSoftDelete(discard.id, opts.archiveUndoWindowHours);

      const updatedKeep = { ...keep };
      updatedKeep.confidence = Math.min(100, keep.confidence + 5);
      store.updateItem(keep.id, {
        confidence: updatedKeep.confidence,
      });

      afterSnapshots.itemA = keep === conflict.itemA ? updatedKeep : conflict.itemA;
      afterSnapshots.itemB = keep === conflict.itemB ? updatedKeep : conflict.itemB;
      break;
    }

    case 'keep_higher_confidence': {
      const keep = conflict.itemA.confidence >= conflict.itemB.confidence
        ? conflict.itemA : conflict.itemB;
      const discard = keep === conflict.itemA ? conflict.itemB : conflict.itemA;

      // Mark for soft-delete instead of immediate archiving
      markForSoftDelete(discard.id, opts.archiveUndoWindowHours);

      afterSnapshots.itemA = keep === conflict.itemA ? keep : undefined;
      afterSnapshots.itemB = keep === conflict.itemB ? keep : undefined;
      break;
    }

    case 'keep_newer': {
      const keepDate = new Date(conflict.itemA.updatedAt) >= new Date(conflict.itemB.updatedAt)
        ? conflict.itemA : conflict.itemB;
      const discardDate = keepDate === conflict.itemA ? conflict.itemB : conflict.itemA;

      // Mark for soft-delete instead of immediate archiving
      markForSoftDelete(discardDate.id, opts.archiveUndoWindowHours);

      const updatedKeep = { ...keepDate };
      updatedKeep.accessCount = keepDate.accessCount + discardDate.accessCount;
      store.updateItem(keepDate.id, {
        accessCount: updatedKeep.accessCount,
      });

      afterSnapshots.itemA = keepDate === conflict.itemA ? updatedKeep : conflict.itemA;
      afterSnapshots.itemB = keepDate === conflict.itemB ? updatedKeep : conflict.itemB;
      break;
    }

    case 'merge': {
      const mergedContent = `${conflict.itemA.content}\n\n--- Integrato da "${conflict.itemB.title}" ---\n${conflict.itemB.content}`;
      const mergedTags = [...new Set([...conflict.itemA.tags, ...conflict.itemB.tags])];

      const updatedA = { ...conflict.itemA };
      updatedA.content = mergedContent;
      updatedA.tags = mergedTags;
      updatedA.confidence = Math.max(conflict.itemA.confidence, conflict.itemB.confidence);
      updatedA.usefulness = Math.max(conflict.itemA.usefulness, conflict.itemB.usefulness);
      updatedA.accessCount = conflict.itemA.accessCount + conflict.itemB.accessCount;

      store.updateItem(conflict.itemA.id, {
        content: mergedContent,
        tags: mergedTags,
        confidence: updatedA.confidence,
        usefulness: updatedA.usefulness,
        accessCount: updatedA.accessCount,
      });

      // Mark itemB for soft-delete
      markForSoftDelete(conflict.itemB.id, opts.archiveUndoWindowHours);

      afterSnapshots.itemA = updatedA;
      break;
    }

    case 'archive_both': {
      markForSoftDelete(conflict.itemA.id, opts.archiveUndoWindowHours);
      markForSoftDelete(conflict.itemB.id, opts.archiveUndoWindowHours);
      break;
    }

    case 'ask_user':
      // Non fare nulla — il conflitto resta aperto per decisione manuale
      return;
  }

  // Log the resolution with full snapshots
  const log: ConflictResolutionLog = {
    id: logId,
    conflictId: conflict.id,
    timestamp: new Date(),
    strategy,
    userNote,
    beforeSnapshots,
    afterSnapshots,
    resolvedBy,
  };

  resolutionLogs.push(log);
}

/**
 * Mark an item for soft-delete with undo window
 */
function markForSoftDelete(itemId: string, undoWindowHours: number): void {
  const archiveAt = new Date(Date.now() + undoWindowHours * 60 * 60 * 1000);
  pendingArchives.set(itemId, { itemId, archiveAt });

  // Also mark in the item itself for filtering
  const store = useMemoryStore.getState();
  const item = store.items.find(i => i.id === itemId);
  if (item) {
    (item as any)._pendingArchive = true;
    (item as any)._archiveAt = archiveAt;
  }
}

/**
 * Undo a resolution by restoring from the before snapshots
 */
export function undoResolve(conflictId: string): boolean {
  const log = resolutionLogs.find(l => l.conflictId === conflictId);
  if (!log) return false;

  const store = useMemoryStore.getState();

  // Restore itemA
  if (log.beforeSnapshots.itemA) {
    store.updateItem(log.beforeSnapshots.itemA.id, log.beforeSnapshots.itemA);
    // Clear any pending archive markers
    pendingArchives.delete(log.beforeSnapshots.itemA.id);
    const item = store.items.find(i => i.id === log.beforeSnapshots.itemA.id);
    if (item) {
      delete (item as any)._pendingArchive;
      delete (item as any)._archiveAt;
    }
  }

  // Restore itemB
  if (log.beforeSnapshots.itemB) {
    store.updateItem(log.beforeSnapshots.itemB.id, log.beforeSnapshots.itemB);
    // Clear any pending archive markers
    pendingArchives.delete(log.beforeSnapshots.itemB.id);
    const item = store.items.find(i => i.id === log.beforeSnapshots.itemB.id);
    if (item) {
      delete (item as any)._pendingArchive;
      delete (item as any)._archiveAt;
    }
  }

  // Remove the log entry
  resolutionLogs = resolutionLogs.filter(l => l.id !== log.id);

  return true;
}

/**
 * Commit all pending archives that have passed their undo window
 */
export function commitPendingArchives(): number {
  const store = useMemoryStore.getState();
  const now = new Date();
  let committed = 0;

  const toDelete: string[] = [];
  for (const [itemId, record] of pendingArchives.entries()) {
    if (now >= record.archiveAt) {
      store.archiveItem(itemId);
      toDelete.push(itemId);
      committed++;
    }
  }

  for (const itemId of toDelete) {
    pendingArchives.delete(itemId);
  }

  return committed;
}

/**
 * Auto-resolve: risolvi automaticamente i conflitti a bassa severità
 * NEVER auto-resolve if either item is L3 or pinned
 * Require user confirmation for high-severity conflicts
 */
export function autoResolveConflicts(options?: ConflictResolverOptions): { resolved: number; pending: number } {
  const conflicts = detectConflicts(options);
  let resolved = 0;
  let pending = 0;

  for (const conflict of conflicts) {
    // Never auto-resolve if either item is L3
    const isL3 = conflict.itemA.level === 'L3' || conflict.itemB.level === 'L3';
    // Never auto-resolve if either item is pinned
    const isPinned = (conflict.itemA as any).pinned || (conflict.itemB as any).pinned;

    // Only auto-resolve non-L3, non-pinned items with low/medium severity
    if (
      !isL3 &&
      !isPinned &&
      (conflict.type === 'duplicate' || conflict.type === 'superseded') &&
      (conflict.severity === 'low' || conflict.severity === 'medium') &&
      conflict.suggestedResolution !== 'ask_user'
    ) {
      resolveConflict(conflict, conflict.suggestedResolution, undefined, 'auto', options);
      resolved++;
    } else {
      pending++;
    }
  }

  return { resolved, pending };
}
