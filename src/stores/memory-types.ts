// ══════════════════════════════════════════════════════════════
// Hydra Memory — Types & Constants
// ══════════════════════════════════════════════════════════════

export type MemoryLevel = 'L1' | 'L2' | 'L3';

export type MemoryItemType =
  | 'fact'
  | 'workflow'
  | 'prompt'
  | 'strategy'
  | 'preference'
  | 'rule'
  | 'schema'
  | 'insight'
  | 'pattern';

export interface MemoryItem {
  id: string;
  level: MemoryLevel;
  type: MemoryItemType;
  title: string;
  content: string;
  source: string;
  runId?: string;
  agentId?: string;
  userId?: string;
  workspace_id?: string; // FIX M1: Add workspace_id
  createdAt: Date;
  updatedAt: Date;
  promotedAt?: Date;
  promotedFrom?: MemoryLevel;
  accessCount: number;
  usefulness: number; // 0-100
  confidence: number; // 0-100
  relevanceDecay: number; // 0.0-1.0
  approved: boolean;
  pinned: boolean;
  archived: boolean;
  tags: string[];
  feedback?: 'positive' | 'negative' | null; // feedback loop esplicito
  feedbackNote?: string;
  version: number; // FIX C3: Optimistic locking via version field
}

export interface PromotionRecord {
  id: string;
  memoryItemId: string;
  fromLevel: MemoryLevel;
  toLevel: MemoryLevel;
  confidence: number;
  promotedByRule: string;
  sourceRunId?: string;
  sourceEventId?: string;
  createdAt: Date;
}

export interface RetrievalResult {
  item: MemoryItem;
  score: number;
}

export interface PromotionThresholds {
  minAccess: number;
  minUsefulness: number;
  minConfidence: number;
  requireApproval: boolean;
}

// ── Constants ──────────────────────────────────────────────

// FIX: Properly typed PROMOTION_THRESHOLDS with Record<MemoryLevel, ...>
export const PROMOTION_THRESHOLDS: Record<
  string,
  PromotionThresholds
> = {
  'L1->L2': {
    minAccess: 3,
    minUsefulness: 40,
    minConfidence: 50,
    requireApproval: false,
  },
  'L2->L3': {
    minAccess: 8,
    minUsefulness: 70,
    minConfidence: 75,
    requireApproval: true,
  },
};

export const DECAY_RATES: Record<MemoryLevel, number> = {
  L1: 0.02, // 2% al giorno
  L2: 0.005, // 0.5% al giorno
  L3: 0, // nessun decay
};

export const DECAY_MINIMUMS: Record<MemoryLevel, number> = {
  L1: 0.1,
  L2: 0.1,
  L3: 1.0,
};

// ── Retrieval Scoring Weights ──────────────────────────────

export const SCORE_WEIGHTS = {
  titleMatch: 10,
  contentMatch: 5,
  tagMatch: 8,
  usefulnessMax: 3, // (usefulness/100) * 3
  confidenceMax: 2, // (confidence/100) * 2
  pinnedMultiplier: 1.5,
};

// ── Store Interface ────────────────────────────────────────

export interface MemoryStore {
  items: MemoryItem[];
  promotions: PromotionRecord[];
  isLoading: boolean;
  lastSyncAt: Date | null;

  // CRUD
  addItem: (
    item: Omit<
      MemoryItem,
      | 'id'
      | 'createdAt'
      | 'updatedAt'
      | 'accessCount'
      | 'relevanceDecay'
      | 'approved'
      | 'pinned'
      | 'archived'
      | 'version'
    >
  ) => string;
  updateItem: (id: string, updates: Partial<MemoryItem>) => void;
  removeItem: (id: string) => void;
  archiveItem: (id: string) => void;
  pinItem: (id: string, pinned: boolean) => void;
  approveItem: (id: string) => void;

  // Feedback Loop
  submitFeedback: (
    id: string,
    feedback: 'positive' | 'negative',
    note?: string
  ) => void;

  // Learning — produce L1 events from run activity
  learnFromRun: (
    runId: string,
    facts: Array<{
      type: MemoryItemType;
      title: string;
      content: string;
      confidence: number;
    }>
  ) => string[];
  learnFromEvent: (event: {
    type: MemoryItemType;
    title: string;
    content: string;
    source: string;
    tags?: string[];
  }) => string;

  // Promotion Engine
  checkPromotionEligible: (
    id: string
  ) => { eligible: boolean; reason: string; nextLevel?: MemoryLevel };
  promoteItem: (id: string) => boolean;
  runPromotionScan: () => string[];

  // Decay Engine
  applyDecay: () => void;

  // Retrieval System
  retrieve: (
    query: string,
    options?: { level?: MemoryLevel; limit?: number; type?: MemoryItemType }
  ) => RetrievalResult[];
  retrieveForRAG: (query: string, limit?: number) => string;
  accessItem: (id: string) => void;

  // Knowledge Graph helpers
  getConnections: () => Array<{
    from: string;
    to: string;
    type: 'tag' | 'run' | 'promotion';
  }>;

  // Stats
  getStats: () => {
    total: number;
    byLevel: Record<MemoryLevel, number>;
    byType: Record<string, number>;
    promotionsToday: number;
    avgConfidence: number;
    avgUsefulness: number;
  };

  // Sync con Supabase
  syncToSupabase: () => Promise<void>;
  syncFromSupabase: () => Promise<void>;
}
