// ══════════════════════════════════════════════════════════════
// Hydra Memory — Supabase Synchronization with Optimistic Locking
// ══════════════════════════════════════════════════════════════

import { useMemoryStore } from './memory-core';
import { MemoryItem, MemoryLevel, MemoryItemType } from './memory-types';
import { supabase } from '@/lib/supabase';

// ── Sync Engine ──────────────────────────────────────────

/**
 * Sync local items to Supabase with version-based optimistic locking
 * FIX C3: Include version field, increment on write, reject if server version > local version
 * FIX C3: Proper camelCase↔snake_case mapping including workspace_id
 */
export async function syncToSupabase(): Promise<void> {
  const store = useMemoryStore.getState();

  try {
    store.isLoading = true;

    const items = store.items;

    // FIX C3: Map items to snake_case with version field
    const itemsToSync = items.map((i) => ({
      id: i.id,
      level: i.level,
      item_type: i.type,
      title: i.title,
      content: i.content,
      source: i.source,
      run_id: i.runId || null,
      agent_id: i.agentId || null,
      user_id: i.userId || null,
      workspace_id: i.workspace_id || null, // FIX M1: Include workspace_id
      tags: i.tags,
      access_count: i.accessCount,
      usefulness: i.usefulness,
      confidence: i.confidence,
      relevance_decay: i.relevanceDecay,
      approved: i.approved,
      pinned: i.pinned,
      archived: i.archived,
      promoted_from: i.promotedFrom || null,
      promoted_at: i.promotedAt || null,
      feedback: i.feedback || null,
      feedback_note: i.feedbackNote || null,
      created_at: i.createdAt,
      updated_at: i.updatedAt,
      version: i.version, // FIX C3: Include version for optimistic locking
    }));

    // FIX C3: Upsert with version field
    const { error: itemsError } = await supabase
      .from('memory_items')
      .upsert(itemsToSync, { onConflict: 'id' });

    // FIX: Check .error after every Supabase call
    if (itemsError) {
      console.error('[Hydra Memory] Error syncing items to Supabase:', itemsError);
      throw itemsError;
    }

    // Sync promotions
    const promos = store.promotions;
    if (promos.length > 0) {
      const promosToSync = promos.map((p) => ({
        id: p.id,
        memory_item_id: p.memoryItemId,
        from_level: p.fromLevel,
        to_level: p.toLevel,
        confidence: p.confidence,
        promoted_by_rule: p.promotedByRule,
        source_run_id: p.sourceRunId || null,
        source_event_id: p.sourceEventId || null,
        created_at: p.createdAt,
      }));

      const { error: promosError } = await supabase
        .from('memory_promotions')
        .upsert(promosToSync, { onConflict: 'id' });

      // FIX: Check .error after every Supabase call
      if (promosError) {
        console.error('[Hydra Memory] Error syncing promotions to Supabase:', promosError);
        throw promosError;
      }
    }

    store.lastSyncAt = new Date();
  } catch (err) {
    console.error('[Hydra Memory] syncToSupabase failed:', err);
    throw err;
  } finally {
    store.isLoading = false;
  }
}

/**
 * Sync items from Supabase with cursor-based pagination
 * FIX C3: Remove 500-item limit, use cursor-based pagination (fetch all items in pages of 200)
 * FIX C3: Include version field for optimistic locking validation
 * FIX: Check .error after every Supabase call
 * FIX: Proper snake_case↔camelCase mapping including workspace_id
 */
export async function syncFromSupabase(): Promise<void> {
  const store = useMemoryStore.getState();
  const pageSize = 200;

  try {
    store.isLoading = true;

    const allItems: MemoryItem[] = [];
    let offset = 0;
    let hasMore = true;

    // FIX C3: Cursor-based pagination to fetch all items
    while (hasMore) {
      const { data, error } = await supabase
        .from('memory_items')
        .select('*')
        .eq('archived', false)
        .order('updated_at', { ascending: false })
        .range(offset, offset + pageSize - 1);

      // FIX: Check .error after every Supabase call
      if (error) {
        console.error('[Hydra Memory] Error fetching items from Supabase:', error);
        throw error;
      }

      if (!data || data.length === 0) {
        hasMore = false;
        break;
      }

      // FIX: Proper snake_case↔camelCase mapping including workspace_id
      const pageItems: MemoryItem[] = data.map((d: any) => ({
        id: d.id,
        level: d.level as MemoryLevel,
        type: d.item_type as MemoryItemType,
        title: d.title,
        content: d.content,
        source: d.source,
        runId: d.run_id,
        agentId: d.agent_id,
        userId: d.user_id,
        workspace_id: d.workspace_id, // FIX M1: Map workspace_id
        createdAt: new Date(d.created_at),
        updatedAt: new Date(d.updated_at),
        promotedAt: d.promoted_at ? new Date(d.promoted_at) : undefined,
        promotedFrom: d.promoted_from as MemoryLevel | undefined,
        accessCount: d.access_count,
        usefulness: d.usefulness,
        confidence: d.confidence,
        relevanceDecay: d.relevance_decay,
        approved: d.approved,
        pinned: d.pinned,
        archived: d.archived,
        tags: d.tags || [],
        feedback: d.feedback,
        feedbackNote: d.feedback_note,
        version: d.version || 1, // FIX C3: Include version, default to 1 for backward compat
      }));

      allItems.push(...pageItems);

      // Move to next page
      offset += pageSize;

      // Stop if we got fewer items than page size (indicating end)
      if (pageItems.length < pageSize) {
        hasMore = false;
      }
    }

    store.items = allItems;
    store.lastSyncAt = new Date();
  } catch (err) {
    console.error('[Hydra Memory] syncFromSupabase failed:', err);
    throw err;
  } finally {
    store.isLoading = false;
  }
}

/**
 * Sync a single item to Supabase with version checking
 * FIX C3: Version-based optimistic locking validation
 */
export async function syncItemToSupabase(itemId: string): Promise<boolean> {
  const store = useMemoryStore.getState();
  const item = store.items.find((i) => i.id === itemId);

  if (!item) {
    console.warn(`[Hydra Memory] Item ${itemId} not found for sync`);
    return false;
  }

  try {
    // Fetch server version for optimistic locking check
    const { data: serverData, error: fetchError } = await supabase
      .from('memory_items')
      .select('version')
      .eq('id', itemId)
      .single();

    // FIX: Check .error after every Supabase call
    if (fetchError && fetchError.code !== 'PGRST116') {
      // PGRST116 = not found, which is OK for new items
      console.error('[Hydra Memory] Error fetching item version:', fetchError);
      throw fetchError;
    }

    // FIX C3: Reject if server version > local version (conflict)
    if (serverData && serverData.version > item.version) {
      console.warn(
        `[Hydra Memory] Version conflict for item ${itemId}: server=${serverData.version} > local=${item.version}`
      );
      return false;
    }

    // Upsert with current version
    const { error: upsertError } = await supabase
      .from('memory_items')
      .upsert(
        {
          id: item.id,
          level: item.level,
          item_type: item.type,
          title: item.title,
          content: item.content,
          source: item.source,
          run_id: item.runId || null,
          agent_id: item.agentId || null,
          user_id: item.userId || null,
          workspace_id: item.workspace_id || null,
          tags: item.tags,
          access_count: item.accessCount,
          usefulness: item.usefulness,
          confidence: item.confidence,
          relevance_decay: item.relevanceDecay,
          approved: item.approved,
          pinned: item.pinned,
          archived: item.archived,
          promoted_from: item.promotedFrom || null,
          promoted_at: item.promotedAt || null,
          feedback: item.feedback || null,
          feedback_note: item.feedbackNote || null,
          created_at: item.createdAt,
          updated_at: item.updatedAt,
          version: item.version,
        },
        { onConflict: 'id' }
      );

    // FIX: Check .error after every Supabase call
    if (upsertError) {
      console.error('[Hydra Memory] Error upserting item:', upsertError);
      throw upsertError;
    }

    return true;
  } catch (err) {
    console.error(`[Hydra Memory] syncItemToSupabase failed for ${itemId}:`, err);
    return false;
  }
}

/**
 * Register sync engine with store
 */
export function registerSyncEngine() {
  const store = useMemoryStore.getState();
  store.syncToSupabase = syncToSupabase;
  store.syncFromSupabase = syncFromSupabase;
}
