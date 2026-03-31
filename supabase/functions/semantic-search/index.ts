// ══════════════════════════════════════════════════════════════
// Edge Function: semantic-search
// Ricerca semantica nella knowledge base usando AI
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

interface SemanticSearchRequest {
  query: string;
  level?: 'L1' | 'L2' | 'L3';
  limit?: number;
  types?: string[];
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

    // C9 - Rate limit check
    const rateLimitResult = rateLimit(user.id, 'semantic-search', 30);
    if (!rateLimitResult.allowed) {
      return handleError('Rate limit exceeded', { status: 429, cors });
    }

    // C11 - Safe JSON parsing
    let body: SemanticSearchRequest;
    const bodyText = await req.text();
    const jsonResult = validateJSON<SemanticSearchRequest>(bodyText);
    if (!jsonResult.valid) {
      return handleError(`Invalid JSON: ${jsonResult.error}`, { status: 400, cors });
    }
    body = jsonResult.data!;

    const { query, level, limit = 10, types } = body;

    if (!query || query.trim().length === 0) {
      return handleError('Query required', { status: 400, cors });
    }

    // 1. Carica memory items dell'utente dal DB
    let dbQuery = supabase
      .from('memory_items')
      .select('id, title, content, tags, level, item_type, usefulness, confidence, relevance_decay, pinned')
      .eq('user_id', user.id)
      .eq('archived', false)
      .limit(200);

    if (level) dbQuery = dbQuery.eq('level', level);
    if (types && types.length > 0) dbQuery = dbQuery.in('item_type', types);

    const { data: items, error: dbError } = await dbQuery;
    if (dbError) throw dbError;
    if (!items || items.length === 0) {
      return new Response(JSON.stringify({ results: [], total: 0 }), {
        headers: { ...cors, 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' },
      });
    }

    // 2. Prepara summary per AI ranking with C7 sanitization
    const itemSummaries = items.map((item, i) =>
      `[${i}] ${sanitizeForPrompt(item.title)}: ${sanitizeForPrompt(item.content.slice(0, 150))}`
    ).join('\n');

    // 3. Chiedi all'AI di rankare per rilevanza semantica
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(AI_GATEWAY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-lite',
        messages: [
          {
            role: 'system',
            content: 'Rank memory items by semantic relevance to a query. Return ONLY the function call with ranked indices and scores.',
          },
          {
            role: 'user',
            content: `Query: "${sanitizeForPrompt(query)}"\n\nItems:\n${itemSummaries}`,
          },
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'rank_items',
            parameters: {
              type: 'object',
              properties: {
                ranked_indices: {
                  type: 'array',
                  items: { type: 'number' },
                  description: 'Item indices ordered by relevance (most relevant first)',
                },
                relevance_scores: {
                  type: 'array',
                  items: { type: 'number' },
                  description: 'Relevance scores 0-100 for each ranked item',
                },
              },
              required: ['ranked_indices'],
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'rank_items' } },
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      // Fallback: ricerca testuale semplice se AI non disponibile
      const textResults = items
        .map((item) => {
          const q = query.toLowerCase();
          let score = 0;
          if (item.title.toLowerCase().includes(q)) score += 10;
          if (item.content.toLowerCase().includes(q)) score += 5;
          item.tags?.forEach((t: string) => { if (t.toLowerCase().includes(q)) score += 8; });
          score += (item.usefulness / 100) * 3;
          score += (item.confidence / 100) * 2;
          score *= item.relevance_decay;
          if (item.pinned) score *= 1.5;
          return { ...item, score };
        })
        .filter((i) => i.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return new Response(JSON.stringify({ results: textResults, total: textResults.length, method: 'fallback_text' }), {
        headers: { ...cors, 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' },
      });
    }

    const aiResult = await response.json();
    const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
    let rankedIndices: number[] = [];
    let relevanceScores: number[] = [];

    if (toolCall?.function?.arguments) {
      // C11 - Safe JSON parsing
      const jsonResult = validateJSON<{ ranked_indices?: number[]; relevance_scores?: number[] }>(
        toolCall.function.arguments
      );
      if (jsonResult.valid && jsonResult.data) {
        rankedIndices = jsonResult.data.ranked_indices || [];
        relevanceScores = jsonResult.data.relevance_scores || [];
      }
    }

    // 4. Costruisci risultati ordinati
    const results = rankedIndices
      .filter((idx) => idx >= 0 && idx < items.length)
      .slice(0, limit)
      .map((idx, pos) => ({
        ...items[idx],
        semantic_score: relevanceScores[pos] || 0,
      }));

    // 5. Aggiorna access_count per gli item restituiti
    const topIds = results.slice(0, 3).map((r) => r.id);
    if (topIds.length > 0) {
      await supabase.rpc('increment_access_count', { item_ids: topIds }).catch(() => {});
    }

    return new Response(
      JSON.stringify({ results, total: results.length, method: 'semantic_ai' }),
      { headers: { ...cors, 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' } }
    );
  } catch (err) {
    return handleError(err instanceof Error ? err : 'Unknown error', { status: 500, cors });
  }
});
