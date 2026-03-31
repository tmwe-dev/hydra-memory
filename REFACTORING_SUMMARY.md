# Hydra Memory Store Refactoring Summary

## Overview
The monolithic `memory.ts` file has been refactored into 6 focused modules plus a barrel re-export, improving maintainability, testability, and bug fixes.

## Files Created

### 1. `memory-types.ts` — All Types & Constants
**Purpose**: Single source of truth for types, interfaces, and constants

**Contents**:
- `MemoryLevel`, `MemoryItemType` types
- `MemoryItem` interface
- `PromotionRecord`, `RetrievalResult` interfaces
- `PromotionThresholds` interface
- `MemoryStore` interface
- Constants: `PROMOTION_THRESHOLDS`, `DECAY_RATES`, `DECAY_MINIMUMS`, `SCORE_WEIGHTS`

**Bugs Fixed**:
- ✅ **M1**: Added `workspace_id?: string` to `MemoryItem`
- ✅ **C3 (partial)**: Added `version: number` field to `MemoryItem` for optimistic locking
- ✅ **Weak typing**: `PROMOTION_THRESHOLDS` properly typed as `Record<string, PromotionThresholds>`

---

### 2. `memory-core.ts` — Zustand Store with CRUD
**Purpose**: Core store implementation with CRUD operations and data persistence

**Contents**:
- Zustand store creation with persist middleware
- CRUD operations: `addItem`, `updateItem`, `removeItem`, `archiveItem`, `pinItem`, `approveItem`
- Feedback loop: `submitFeedback`
- Learning: `learnFromRun`, `learnFromEvent`
- Placeholder methods for other engines (registered later)

**Bugs Fixed**:
- ✅ **H4**: `updateItem` filters out immutable fields (`id`, `createdAt`) before applying updates
- ✅ **H16**: Implemented `DebouncedStorage` adapter for debounced Zustand persist writes (1 second debounce)
- ✅ **C3 (partial)**: Version field initialized and incremented on mutations

**Key Features**:
- Custom `DebouncedStorage` adapter to reduce localStorage write frequency
- Proper state partializiation for persist middleware
- Version tracking for optimistic locking

---

### 3. `memory-promotion.ts` — Promotion Engine
**Purpose**: Logic for promoting items between memory levels

**Contents**:
- `checkPromotionEligible()`: Check if item meets promotion criteria
- `promoteItem()`: Promote single item to next level
- `runPromotionScan()`: Scan and promote all eligible items
- `registerPromotionEngine()`: Register with store

**Bugs Fixed**:
- ✅ **TOCTOU Prevention**: `runPromotionScan()` takes snapshot of items at scan start to prevent race conditions where items change during iteration

**Algorithm**:
- Checks access count, usefulness, confidence against thresholds
- Supports approval requirement for L2→L3 promotion
- Maintains promotion history in `PromotionRecord`

---

### 4. `memory-decay.ts` — Decay Engine
**Purpose**: Gradual relevance decay based on time and memory level

**Contents**:
- `applyDecay()`: Apply decay to all non-pinned, non-archived items
- `getDecaySchedule()`: Calculate days until item reaches minimum decay
- `registerDecayEngine()`: Register with store

**Bugs Fixed**:
- ✅ **H5**: Relevance clamped to `[0, 1]` range
- ✅ **Date validation**: Validates date fields before computing decay; logs warnings for invalid dates

**Features**:
- Per-level decay rates (L1: 2%/day, L2: 0.5%/day, L3: none)
- Per-level minimum decay (L1: 0.1, L2: 0.1, L3: 1.0)
- Pinned, archived, and L3 items don't decay
- Version not incremented on automatic decay

---

### 5. `memory-retrieval.ts` — Retrieval System & RAG
**Purpose**: Search, retrieve, and score memory items for AI context injection

**Contents**:
- `retrieve()`: Multi-factor scoring retrieval with filtering
- `retrieveForRAG()`: Format results as markdown for AI prompts
- `accessItem()`: Record access and boost relevance
- `fullTextSearch()`: Search across multiple fields with term frequency
- `getSimilarItems()`: Find related items by tags and type
- `getTopResults()`: Get top results with rounded scores
- `registerRetrievalEngine()`: Register with store

**Bugs Fixed**:
- ✅ **H5**: `accessItem()` clamps relevance to max 1.0 after boosting (+0.05)

**Scoring Formula**:
- Title match: +10
- Content match: +5
- Tag match: +8 each
- Usefulness bonus: (usefulness/100) * 3
- Confidence bonus: (confidence/100) * 2
- Decay multiplier: score *= relevanceDecay
- Pinned boost: score *= 1.5

---

### 6. `memory-sync.ts` — Supabase Synchronization
**Purpose**: Bidirectional sync with Supabase using optimistic locking

**Contents**:
- `syncToSupabase()`: Push local items and promotions to Supabase
- `syncFromSupabase()`: Pull items from Supabase with pagination
- `syncItemToSupabase()`: Sync single item with version checking
- `registerSyncEngine()`: Register with store

**Bugs Fixed**:
- ✅ **C3**: Version-based optimistic locking
  - Include `version` field in upsert
  - Increment version on write
  - Reject if server version > local version (conflicts)
- ✅ **C3**: Cursor-based pagination (200 items/page) instead of 500-item limit
  - Fetches ALL items by looping through pages
  - Stops when page size < 200
- ✅ **Error handling**: Check `.error` after EVERY Supabase call
- ✅ **Field mapping**: Proper camelCase ↔ snake_case including `workspace_id`

**Conflict Resolution**:
- On sync, fetch server version first
- Reject local update if server version > local version
- Prevents overwriting conflicting remote changes

---

### 7. `memory-helpers.ts` — Knowledge Graph & Stats
**Purpose**: Analytics, statistics, and knowledge graph operations

**Contents**:
- `getConnections()`: Find connections via shared tags, runs, and promotions
- `getStats()`: Basic statistics (totals, averages)
- `getDetailedStats()`: Extended statistics with breakdowns
- `registerHelperFunctions()`: Register with store

**Features**:
- Tag-based connections (N² algorithm with deduplication)
- Run-based connections (items from same run)
- Promotion-based connections (parent-child relationships)
- Level-by-type breakdown
- Detailed counts (pinned, approved, archived)

---

### 8. `memory.ts` — Barrel Re-export
**Purpose**: Central export point maintaining backward compatibility

**Contents**:
- Re-exports all types from `memory-types.ts`
- Re-exports all constants from `memory-types.ts`
- Re-exports store and functions from all modules
- `initializeMemoryEngines()`: One-time initialization

**Backward Compatibility**:
- `useMemoryStore` available from main export
- Default export is `useMemoryStore`
- All types and functions accessible from single import

---

## Bug Fixes Summary

| Bug ID | Severity | Module | Fix |
|--------|----------|--------|-----|
| M1 | Low | memory-types.ts | Added `workspace_id?: string` to MemoryItem |
| H4 | High | memory-core.ts | Filter immutable fields in updateItem |
| H5 | High | memory-retrieval.ts, memory-decay.ts | Clamp relevance to [0, 1] |
| H16 | Medium | memory-core.ts | Debounced localStorage writes |
| C3 | Critical | memory-sync.ts, memory-types.ts | Version-based optimistic locking + cursor pagination |

---

## Architecture Benefits

### Separation of Concerns
- Types in single module
- Core CRUD isolated from business logic
- Each engine independent and testable
- Sync logic separated from local state

### Maintainability
- Each module ~200-400 LOC (readable)
- Clear responsibilities
- Easier to locate bugs
- Simpler code review

### Testability
- Mock imports easily
- No circular dependencies
- Pure functions for business logic
- Zustand middleware customizable

### Performance
- Debounced persistence (H16)
- Cursor-based pagination (C3)
- Snapshot-based iteration (TOCTOU fix)
- Clamped calculations (H5)

### Extensibility
- Easy to add new retrieval scoring factors
- New decay rates per level
- Custom promotion rules
- Plugin architecture via registration functions

---

## Usage

### Basic Setup (in app initialization)
```typescript
import { useMemoryStore, initializeMemoryEngines } from '@/stores/memory';

// Initialize engines once
initializeMemoryEngines();
```

### Adding Items
```typescript
const store = useMemoryStore.getState();
const itemId = store.addItem({
  level: 'L1',
  type: 'fact',
  title: 'Example',
  content: 'Content here',
  source: 'API',
  confidence: 75,
  usefulness: 50,
  tags: ['tag1', 'tag2'],
});
```

### Retrieving Items
```typescript
const results = store.retrieve('query', { limit: 10, level: 'L2' });
const ragContext = store.retrieveForRAG('query', 5);
```

### Syncing
```typescript
await store.syncFromSupabase();
// ... make changes ...
await store.syncToSupabase();
```

---

## Migration Checklist

- [x] Create all 6 new modules with complete implementations
- [x] Fix all identified bugs (M1, H4, H5, H16, C3)
- [x] Create barrel re-export maintaining backward compatibility
- [x] Implement engine registration system
- [x] Add comprehensive documentation
- [x] Preserve all original functionality
- [x] Add optimistic locking with version field
- [x] Implement debounced persistence
- [x] Add cursor-based pagination for Supabase
- [x] Add error checking after all Supabase calls

---

## Notes

1. **Initialization Required**: Call `initializeMemoryEngines()` once at app startup to register all engine functions with the store
2. **Type Safety**: Full TypeScript support with proper Record types for thresholds
3. **Error Handling**: All Supabase calls now check for errors explicitly
4. **Backward Compatible**: Existing code importing from `memory.ts` continues to work
5. **Storage Debouncing**: localStorage writes are debounced by 1 second to reduce I/O
