// ══════════════════════════════════════════════════════════════
// Edge Function: generate-embedding
// Genera embeddings vettoriali per memory items
// Supporta batch processing e aggiornamento incrementale
// ══════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  validateAuth,
  rateLimit,
  corsHeaders,
  handleError,
  validateJSON,
  sanitizeForPrompt,
  validateAIResponse,
} from '../_shared/middleware.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const AI_GATEWAY_URL = Deno.env.get('AI_GATEWAY_URL')!;
const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY')!;
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || 'http://localhost:3000').split(',');

// Modello embedding: gte-small (384 dimensioni, veloce, buona qualità)
const EMBEDDING_MODEL = 'thenlper/gte-small';

interface EmbeddingRequest {
  mode: 'single' | 'batch' | 'backfill';
  itemId?: string;       // per mode=single
  itemIds?: string[];    // per mode=batch
  batchSize?: number;    // per mode=backfill (default 50)
}

serve(async (req: Request) => {
  const origin = req.headers.get('Origin');
  const cors = corsHeaders(origin, ALLOWED_ORIGINS);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  try {
    // C9 - Rate limiting
    const authValidation = validateAuth(req);
    if (!authValidation.valid) {
      return handleError(authValidation.error || 'Invalid auth', {
        status: 401,
        cors,
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      global: { headers: { Authorization: `Bearer ${authValidation.token}` } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return handleError('Unauthorized', { status: 401, cors });
    }

    // C9 - Rate limit check (higher for embeddings)
    const rateLimitResult = rateLimit(user.id, 'generate-embedding', 20);
    if (!rateLimitResult.allowed) {
      return handleError('Rate limit exceeded', { status: 429, cors });
    }

    // C11 - Safe JSON parsing
    let body: EmbeddingRequest;
    const bodyText = await req.text();
    const jsonResult = validateJSON<EmbeddingRequest>(bodyText);
    if (!jsonResult.valid) {
      return handleError(`Invalid JSON: ${jsonResult.error}`, { status: 400, cors });
    }
    body = jsonResult.data!;

    const { mode = 'backfill', itemId, itemIds, batchSize = 50 } = body;

    // ── Determina quali item processare ──
    let targetIds: string[] = [];

    if (mode === 'single' && itemId) {
      targetIds = [itemId];
    } else if (mode === 'batch' && itemIds) {
      targetIds = itemIds.slice(0, 100); // max 100 per batch
    } else if (mode === 'backfill') {
      // Trova item senza embedding
      const { data } = await supabase
        .from('memory_items')
        .select('id')
        .eq('user_id', user.id)
        .eq('archived', false)
        .is('embedding', null)
        .limit(batchSize);
      targetIds = (data || []).map((d: any) => d.id);
    }

    if (targetIds.length === 0) {
      return new Response(
        JSON.stringify({ processed: 0, message: 'No items to process' }),
        { headers: { ...cors, 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' } }
      );
    }

    // ── Carica contenuto degli item ──
    const { data: items, error: fetchError } = await supabase
      .from('memory_items')
      .select('id, title, content, tags')
      .in('id', targetIds);

    if (fetchError) throw fetchError;
    if (!items || items.length === 0) {
      return new Response(
        JSON.stringify({ processed: 0, message: 'No items found' }),
        { headers: { ...cors, 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' } }
      );
    }

    // ── Prepara testi per embedding ──
    // Formato: "titolo. contenuto (primi 500 chars). tags: tag1, tag2"
    const texts = items.map((item: any) => {
      const tagStr = (item.tags || []).join(', ');
      const content = item.content.slice(0, 500);
      return `${sanitizeForPrompt(item.title)}. ${sanitizeForPrompt(content)}${tagStr ? '. Tags: ' + sanitizeForPrompt(tagStr) : ''}`;
    });

    // ── Genera embeddings via AI Gateway ──
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const embeddingResponse = await fetch(`${AI_GATEWAY_URL}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts,
      }),
    });

    clearTimeout(timeout);

    if (!embeddingResponse.ok) {
      throw new Error(`Embedding API error: ${embeddingResponse.status}`);
    }

    const embeddingResult = await embeddingResponse.json();
    const embeddings = embeddingResult.data || [];

    // ── H14: Salva embeddings nel DB con batch upsert ──
    let processed = 0;
    const errors: string[] = [];

    // Prepara dati per upsert
    const upsertData = [];
    for (let i = 0; i < items.length && i < embeddings.length; i++) {
      const item = items[i];
      const embedding = embeddings[i]?.embedding;

      if (!embedding || embedding.length !== 384) {
        errors.push(`Item ${item.id}: invalid embedding dimension`);
        continue;
      }

      upsertData.push({
        id: item.id,
        embedding: embedding,
      });
    }

    // Esegui batch upsert
    if (upsertData.length > 0) {
      const { error: batchError, count } = await supabase
        .from('memory_items')
        .upsert(upsertData, { onConflict: 'id' });

      if (batchError) {
        errors.push(`Batch upsert error: ${batchError.message}`);
      } else {
        processed = count || upsertData.length;
      }
    }

    return new Response(
      JSON.stringify({
        processed,
        total: items.length,
        errors: errors.length > 0 ? errors : undefined,
        remaining: mode === 'backfill'
          ? await countItemsWithoutEmbedding(supabase, user.id)
          : undefined,
      }),
      { headers: { ...cors, 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' } }
    );
  } catch (err) {
    return handleError(err instanceof Error ? err : 'Unknown error', { status: 500, cors });
  }
});

async function countItemsWithoutEmbedding(supabase: any, userId: string): Promise<number> {
  const { count } = await supabase
    .from('memory_items')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('archived', false)
    .is('embedding', null);
  return count || 0;
}
