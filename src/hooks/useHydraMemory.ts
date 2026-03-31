// ══════════════════════════════════════════════════════════════
// Hook: useHydraMemory
// Interfaccia React per il sistema di apprendimento Hydra
// Integra memory store + Edge Functions + auto-decay/promotion
// ══════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useMemo } from 'react';
import { useMemoryStore, type MemoryLevel, type MemoryItemType, type RetrievalResult } from '@/stores/memory';
import { supabase } from '@/lib/supabase';

// ── Config ──────────────────────────────────────────────────

const DECAY_INTERVAL_MS = 30 * 60 * 1000;      // 30 minuti
const PROMOTION_INTERVAL_MS = 30 * 60 * 1000;   // 30 minuti
const SYNC_INTERVAL_MS = 5 * 60 * 1000;         // 5 minuti

// ── Types ──────────────────────────────────────────────────

interface SemanticSearchResult {
  id: string;
  title: string;
  content: string;
  confidence: number;
  level: MemoryLevel;
}

interface Insight {
  id: string;
  title: string;
  description: string;
  category: string;
  priority: 'high' | 'medium' | 'low';
  suggested_action?: string;
  steps?: string[];
  estimated_savings?: string;
}

interface Workflow {
  id: string;
  name: string;
  description: string;
  confidence: number;
  steps: string[];
}

// ── Hook Interface ──────────────────────────────────────────

interface UseHydraMemoryReturn {
  // State
  items: ReturnType<typeof useMemoryStore>['items'];
  isLoading: boolean;
  stats: ReturnType<ReturnType<typeof useMemoryStore>['getStats']>;
  syncError: Error | null;
  syncStatus: 'idle' | 'syncing' | 'error';

  // Learning
  learn: (event: {
    type: MemoryItemType;
    title: string;
    content: string;
    source: string;
    tags?: string[];
  }) => string;
  learnFromRun: (
    runId: string,
    facts: Array<{ type: MemoryItemType; title: string; content: string; confidence: number }>
  ) => string[];

  // Retrieval
  search: (query: string, options?: { level?: MemoryLevel; limit?: number; type?: MemoryItemType }) => RetrievalResult[];
  searchSemantic: (query: string, options?: { level?: MemoryLevel; limit?: number }) => Promise<SemanticSearchResult[]>;
  getRAGContext: (query: string, limit?: number) => string;

  // Actions
  approve: (id: string) => void;
  pin: (id: string, pinned: boolean) => void;
  archive: (id: string) => void;
  feedback: (id: string, type: 'positive' | 'negative', note?: string) => void;

  // AI-powered
  generateInsights: (type?: string) => Promise<Insight[]>;
  suggestWorkflows: () => Promise<Workflow[]>;

  // Knowledge Graph
  connections: ReturnType<ReturnType<typeof useMemoryStore>['getConnections']>;

  // Sync
  sync: () => Promise<void>;
}

// ── Hook Implementation ─────────────────────────────────────

export function useHydraMemory(): UseHydraMemoryReturn {
  const store = useMemoryStore();
  const decayTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const promotionTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const syncTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const storeRef = useRef(store);
  const syncErrorRef = useRef<Error | null>(null);
  const syncStatusRef = useRef<'idle' | 'syncing' | 'error'>('idle');

  // H6 - Keep store reference current to avoid stale closures
  useEffect(() => {
    storeRef.current = store;
  }, [store]);

  // ── Auto-decay e auto-promotion ───────────────────────

  useEffect(() => {
    // Applica decay al mount
    storeRef.current.applyDecay();

    // Scheduling periodico con ref to avoid stale closures
    decayTimer.current = setInterval(() => {
      storeRef.current.applyDecay();
    }, DECAY_INTERVAL_MS);

    promotionTimer.current = setInterval(() => {
      const promoted = storeRef.current.runPromotionScan();
      if (promoted.length > 0) {
        console.log(`[Hydra] Auto-promoted ${promoted.length} items`);
      }
    }, PROMOTION_INTERVAL_MS);

    syncTimer.current = setInterval(() => {
      storeRef.current.syncToSupabase().catch((err) => {
        console.warn('[Hydra] Auto-sync failed:', err.message);
        syncErrorRef.current = err;
        syncStatusRef.current = 'error';
      });
    }, SYNC_INTERVAL_MS);

    // H7 - Sync iniziale con proper error handling
    syncStatusRef.current = 'syncing';
    storeRef.current.syncFromSupabase()
      .then(() => {
        syncStatusRef.current = 'idle';
        syncErrorRef.current = null;
      })
      .catch((err) => {
        console.error('[Hydra] Initial sync failed:', err);
        syncErrorRef.current = err;
        syncStatusRef.current = 'error';
      });

    return () => {
      if (decayTimer.current) clearInterval(decayTimer.current);
      if (promotionTimer.current) clearInterval(promotionTimer.current);
      if (syncTimer.current) clearInterval(syncTimer.current);
    };
  }, []);

  // ── Learning ──────────────────────────────────────────

  const learn = useCallback(
    (event: { type: MemoryItemType; title: string; content: string; source: string; tags?: string[] }) => {
      return storeRef.current.learnFromEvent(event);
    },
    []
  );

  const learnFromRun = useCallback(
    (runId: string, facts: Array<{ type: MemoryItemType; title: string; content: string; confidence: number }>) => {
      return storeRef.current.learnFromRun(runId, facts);
    },
    []
  );

  // ── Retrieval ─────────────────────────────────────────

  const search = useCallback(
    (query: string, options?: { level?: MemoryLevel; limit?: number; type?: MemoryItemType }) => {
      const results = storeRef.current.retrieve(query, options);
      // Incrementa accessCount per i top risultati
      results.slice(0, 3).forEach((r) => storeRef.current.accessItem(r.item.id));
      return results;
    },
    []
  );

  const searchSemantic = useCallback(
    async (query: string, options?: { level?: MemoryLevel; limit?: number }): Promise<SemanticSearchResult[]> => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Not authenticated');

        const response = await supabase.functions.invoke('semantic-search', {
          body: { query, level: options?.level, limit: options?.limit || 10 },
        });

        if (response.error) throw response.error;
        return (response.data?.results || []) as SemanticSearchResult[];
      } catch (err) {
        console.warn('[Hydra] Semantic search failed, falling back to local:', err);
        return storeRef.current.retrieve(query, options).map((r) => ({
          id: r.item.id,
          title: r.item.title,
          content: r.item.content,
          confidence: r.item.confidence,
          level: r.item.level,
        }));
      }
    },
    []
  );

  const getRAGContext = useCallback(
    (query: string, limit?: number) => {
      return storeRef.current.retrieveForRAG(query, limit);
    },
    []
  );

  // ── Actions ───────────────────────────────────────────

  const approve = useCallback((id: string) => storeRef.current.approveItem(id), []);
  const pin = useCallback((id: string, pinned: boolean) => storeRef.current.pinItem(id, pinned), []);
  const archive = useCallback((id: string) => storeRef.current.archiveItem(id), []);
  const feedback = useCallback(
    (id: string, type: 'positive' | 'negative', note?: string) => {
      storeRef.current.submitFeedback(id, type, note);
    },
    []
  );

  // ── AI-powered ────────────────────────────────────────

  const generateInsights = useCallback(async (type = 'general'): Promise<Insight[]> => {
    try {
      const response = await supabase.functions.invoke('insight-engine', {
        body: { type },
      });
      if (response.error) throw response.error;
      // Sync per ottenere gli insight appena creati
      await storeRef.current.syncFromSupabase();
      return (response.data?.insights || []) as Insight[];
    } catch (err) {
      console.error('[Hydra] Insight generation failed:', err);
      return [];
    }
  }, []);

  const suggestWorkflows = useCallback(async (): Promise<Workflow[]> => {
    try {
      const response = await supabase.functions.invoke('workflow-generator', {
        body: {},
      });
      if (response.error) throw response.error;
      await storeRef.current.syncFromSupabase();
      return (response.data?.suggestions || []) as Workflow[];
    } catch (err) {
      console.error('[Hydra] Workflow generation failed:', err);
      return [];
    }
  }, []);

  // ── Sync ──────────────────────────────────────────────

  const sync = useCallback(async () => {
    syncStatusRef.current = 'syncing';
    try {
      await storeRef.current.syncToSupabase();
      await storeRef.current.syncFromSupabase();
      syncStatusRef.current = 'idle';
      syncErrorRef.current = null;
    } catch (err) {
      syncStatusRef.current = 'error';
      syncErrorRef.current = err instanceof Error ? err : new Error(String(err));
      throw err;
    }
  }, []);

  // ── Memoize return object to prevent unnecessary re-renders ──────

  const returnValue = useMemo<UseHydraMemoryReturn>(
    () => ({
      items: store.items,
      isLoading: store.isLoading,
      stats: store.getStats(),
      syncError: syncErrorRef.current,
      syncStatus: syncStatusRef.current,
      learn,
      learnFromRun,
      search,
      searchSemantic,
      getRAGContext,
      approve,
      pin,
      archive,
      feedback,
      generateInsights,
      suggestWorkflows,
      connections: store.getConnections(),
      sync,
    }),
    [store.items, store.isLoading, store.getStats(), store.getConnections(),
     learn, learnFromRun, search, searchSemantic, getRAGContext,
     approve, pin, archive, feedback, generateInsights, suggestWorkflows, sync]
  );

  return returnValue;
}
