// ══════════════════════════════════════════════════════════════
// Hydra Memory — Core Zustand Store with CRUD
// ══════════════════════════════════════════════════════════════

import { create } from 'zustand';
import { persist, StorageValue } from 'zustand/middleware';
import {
  MemoryItem,
  MemoryStore,
  PromotionRecord,
  MemoryLevel,
  MemoryItemType,
} from './memory-types';

// ── Helper: generate ID ────────────────────────────────────

function generateId(): string {
  return `mem·${Date.now().toString(36)}·${Math.random().toString(36).slice(2, 8)}`;
}

// ── Helper: Debounced Storage Adapter ──────────────────────
// FIX H16: Debounced serialization to reduce Zustand persist writes

class DebouncedStorage {
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingState: StorageValue<{
    state: { items: MemoryItem[]; promotions: PromotionRecord[]; lastSyncAt: Date | null };
    version: number;
  }> | null = null;
  private localStorage: typeof globalThis.localStorage;

  constructor(storage: typeof globalThis.localStorage) {
    this.localStorage = storage;
  }

  getItem(name: string): StorageValue<any> | null {
    const item = this.localStorage.getItem(name);
    return item ? JSON.parse(item) : null;
  }

  setItem(name: string, value: StorageValue<any>): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.pendingState = value;
    this.debounceTimer = setTimeout(() => {
      if (this.pendingState) {
        this.localStorage.setItem(name, JSON.stringify(this.pendingState));
        this.pendingState = null;
      }
    }, 1000); // 1 second debounce
  }

  removeItem(name: string): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.localStorage.removeItem(name);
  }
}

// ── Store Implementation ───────────────────────────────────

export const useMemoryStore = create<MemoryStore>()(
  persist(
    (set, get) => ({
      items: [],
      promotions: [],
      isLoading: false,
      lastSyncAt: null,

      // ── CRUD ──────────────────────────────────────────

      addItem: (itemData) => {
        const id = generateId();
        const now = new Date();
        const newItem: MemoryItem = {
          ...itemData,
          id,
          createdAt: now,
          updatedAt: now,
          accessCount: 0,
          relevanceDecay: 1.0,
          approved: false,
          pinned: false,
          archived: false,
          tags: itemData.tags || [],
          feedback: null,
          version: 1, // FIX C3: Initialize version field
        };
        set((s) => ({ items: [...s.items, newItem] }));
        return id;
      },

      // FIX H4: Filter out immutable fields before updating
      updateItem: (id, updates) => {
        set((s) => ({
          items: s.items.map((i) => {
            if (i.id !== id) return i;

            // FIX H4: Remove immutable fields before applying updates
            const { id: _id, createdAt: _createdAt, ...mutableUpdates } = updates;

            return {
              ...i,
              ...mutableUpdates,
              updatedAt: new Date(),
              version: i.version + 1, // FIX C3: Increment version on update
            };
          }),
        }));
      },

      removeItem: (id) => {
        set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
      },

      archiveItem: (id) => {
        set((s) => ({
          items: s.items.map((i) =>
            i.id === id
              ? {
                  ...i,
                  archived: true,
                  updatedAt: new Date(),
                  version: i.version + 1,
                }
              : i
          ),
        }));
      },

      pinItem: (id, pinned) => {
        set((s) => ({
          items: s.items.map((i) =>
            i.id === id
              ? {
                  ...i,
                  pinned,
                  updatedAt: new Date(),
                  version: i.version + 1,
                }
              : i
          ),
        }));
      },

      approveItem: (id) => {
        set((s) => ({
          items: s.items.map((i) =>
            i.id === id
              ? {
                  ...i,
                  approved: true,
                  updatedAt: new Date(),
                  version: i.version + 1,
                }
              : i
          ),
        }));
      },

      // ── Feedback Loop ─────────────────────────────────

      submitFeedback: (id, feedback, note) => {
        const item = get().items.find((i) => i.id === id);
        if (!item) return;

        const updates: Partial<MemoryItem> = {
          feedback,
          feedbackNote: note,
          updatedAt: new Date(),
        };

        // Feedback negativo riduce confidence e usefulness
        if (feedback === 'negative') {
          updates.confidence = Math.max(0, item.confidence - 15);
          updates.usefulness = Math.max(0, item.usefulness - 10);
        }
        // Feedback positivo li aumenta
        if (feedback === 'positive') {
          updates.confidence = Math.min(100, item.confidence + 10);
          updates.usefulness = Math.min(100, item.usefulness + 5);
          updates.accessCount = item.accessCount + 1;
        }

        get().updateItem(id, updates);
      },

      // ── Learning ──────────────────────────────────────

      learnFromRun: (runId, facts) => {
        const ids: string[] = [];
        for (const fact of facts) {
          const id = get().addItem({
            level: 'L1',
            type: fact.type,
            title: fact.title,
            content: fact.content,
            source: `Run ${runId}`,
            runId,
            confidence: fact.confidence,
            usefulness: 30, // default basso
            tags: [],
          });
          ids.push(id);
        }
        return ids;
      },

      learnFromEvent: (event) => {
        return get().addItem({
          level: 'L1',
          type: event.type,
          title: event.title,
          content: event.content,
          source: event.source,
          confidence: 50,
          usefulness: 30,
          tags: event.tags || [],
        });
      },

      // ── Placeholder methods (implemented in other modules) ──

      checkPromotionEligible: () => ({
        eligible: false,
        reason: 'Not implemented in core module',
      }),
      promoteItem: () => false,
      runPromotionScan: () => [],
      applyDecay: () => {
        // Implemented in memory-decay.ts
      },
      retrieve: () => [],
      retrieveForRAG: () => '',
      accessItem: () => {
        // Implemented in memory-retrieval.ts
      },
      getConnections: () => [],
      getStats: () => ({
        total: 0,
        byLevel: { L1: 0, L2: 0, L3: 0 },
        byType: {},
        promotionsToday: 0,
        avgConfidence: 0,
        avgUsefulness: 0,
      }),
      syncToSupabase: async () => {
        // Implemented in memory-sync.ts
      },
      syncFromSupabase: async () => {
        // Implemented in memory-sync.ts
      },
    }),
    {
      name: 'hydra-memory-store',
      partialize: (state) => ({
        items: state.items,
        promotions: state.promotions,
        lastSyncAt: state.lastSyncAt,
      }),
      storage:
        typeof window !== 'undefined' &&
        typeof window.localStorage !== 'undefined'
          ? new DebouncedStorage(window.localStorage) as any
          : undefined,
    }
  )
);

// ── Hook Export ────────────────────────────────────────────
export { useMemoryStore as default };
