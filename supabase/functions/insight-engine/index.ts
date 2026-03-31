// ══════════════════════════════════════════════════════════════
// Edge Function: insight-engine
// Genera insight azionabili analizzando run, eventi e memoria
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

interface Insight {
  title: string;
  description: string;
  category: 'performance' | 'workflow' | 'cost' | 'quality';
  priority: 'high' | 'medium' | 'low';
  actionable: boolean;
  suggested_action: string;
}

const PROMPT_MAP: Record<string, string> = {
  general: 'Analizza attività recente → 3-5 insight azionabili',
  workflows: 'Suggerisci 3-5 workflow automatizzabili basandoti sui pattern',
  performance: 'Analizza performance provider e suggerisci ottimizzazioni',
  costs: 'Analizza costi e token usage, suggerisci risparmi',
};

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
    const rateLimitResult = rateLimit(user.id, 'insight-engine', 10);
    if (!rateLimitResult.allowed) {
      return handleError('Rate limit exceeded', { status: 429, cors });
    }

    // C11 - Safe JSON parsing
    let body: any;
    const bodyText = await req.text();
    const jsonResult = validateJSON(bodyText);
    if (!jsonResult.valid) {
      return handleError(`Invalid JSON: ${jsonResult.error}`, { status: 400, cors });
    }
    body = jsonResult.data || {};

    const analysisType: string = (body.type || 'general').toString().slice(0, 50);

    // Raccoglie dati da 3 fonti in parallelo
    const [runsRes, eventsRes, memoryRes] = await Promise.all([
      supabase
        .from('runs')
        .select('id, title, status, mode, providers, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('run_events')
        .select('event_type, severity, message, created_at')
        .order('created_at', { ascending: false })
        .limit(100),
      supabase
        .from('memory_items')
        .select('level, item_type, title, usefulness, confidence, feedback, tags')
        .eq('user_id', user.id)
        .eq('archived', false)
        .limit(100),
    ]);

    const runs = runsRes.data || [];
    const events = eventsRes.data || [];
    const memory = memoryRes.data || [];

    // Componi contesto per AI with C7 sanitization
    const context = [
      `=== RUNS RECENTI (${runs.length}) ===`,
      runs.slice(0, 20).map((r) =>
        `${sanitizeForPrompt(r.title)} | ${r.status} | ${r.mode} | ${new Date(r.created_at).toLocaleDateString()}`
      ).join('\n'),
      `\n=== EVENTI (${events.length}) ===`,
      events.slice(0, 30).map((e) =>
        `[${e.severity}] ${e.event_type}: ${sanitizeForPrompt(e.message?.slice(0, 100) || '')}`
      ).join('\n'),
      `\n=== MEMORIA (${memory.length} items) ===`,
      `L1: ${memory.filter((m) => m.level === 'L1').length} | L2: ${memory.filter((m) => m.level === 'L2').length} | L3: ${memory.filter((m) => m.level === 'L3').length}`,
      `Feedback negativo: ${memory.filter((m) => m.feedback === 'negative').length}`,
      `Top tags: ${[...new Set(memory.flatMap((m) => m.tags || []))].slice(0, 15).map(sanitizeForPrompt).join(', ')}`,
    ].join('\n');

    const prompt = PROMPT_MAP[analysisType] || PROMPT_MAP.general;

    // Chiama AI con tool calling per output strutturato
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

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
          { role: 'system', content: prompt },
          { role: 'user', content: context },
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'generate_insights',
            parameters: {
              type: 'object',
              properties: {
                insights: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' },
                      description: { type: 'string' },
                      category: { type: 'string', enum: ['performance', 'workflow', 'cost', 'quality'] },
                      priority: { type: 'string', enum: ['high', 'medium', 'low'] },
                      actionable: { type: 'boolean' },
                      suggested_action: { type: 'string' },
                    },
                    required: ['title', 'description', 'category', 'priority', 'actionable', 'suggested_action'],
                  },
                },
              },
              required: ['insights'],
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'generate_insights' } },
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`AI Gateway error: ${response.status}`);
    }

    const aiResult = await response.json();
    const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
    let insights: Insight[] = [];

    if (toolCall?.function?.arguments) {
      // C11 - Safe JSON parsing
      const jsonResult = validateJSON<{ insights?: Insight[] }>(toolCall.function.arguments);
      if (jsonResult.valid && jsonResult.data) {
        insights = jsonResult.data.insights || [];
      }
    }

    // Salva insights come memory items L1
    for (const insight of insights) {
      await supabase.from('memory_items').insert({
        id: `ins·${Date.now().toString(36)}·${Math.random().toString(36).slice(2, 6)}`,
        user_id: user.id,
        level: 'L1',
        item_type: 'insight',
        title: sanitizeForPrompt(insight.title),
        content: `${sanitizeForPrompt(insight.description)}\n\nAzione suggerita: ${sanitizeForPrompt(insight.suggested_action)}`,
        source: `insight-engine:${analysisType}`,
        tags: [insight.category, insight.priority],
        confidence: insight.priority === 'high' ? 80 : insight.priority === 'medium' ? 60 : 40,
        usefulness: insight.actionable ? 70 : 40,
      });
    }

    return new Response(
      JSON.stringify({
        insights,
        total: insights.length,
        analysisType,
        dataPoints: { runs: runs.length, events: events.length, memory: memory.length },
      }),
      { headers: { ...cors, 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' } }
    );
  } catch (err) {
    return handleError(err instanceof Error ? err : 'Unknown error', { status: 500, cors });
  }
});
