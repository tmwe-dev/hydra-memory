// ══════════════════════════════════════════════════════════════
// Edge Function: workflow-generator
// Suggerisce workflow automatizzabili basandosi su pattern
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

interface WorkflowSuggestion {
  title: string;
  description: string;
  trigger: string;
  steps: string[];
  estimated_savings: string;
  confidence: number;
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
    const rateLimitResult = rateLimit(user.id, 'workflow-generator', 10);
    if (!rateLimitResult.allowed) {
      return handleError('Rate limit exceeded', { status: 429, cors });
    }

    // 1. Recupera run completate e pattern eventi
    const [runsRes, eventsRes] = await Promise.all([
      supabase
        .from('runs')
        .select('id, title, status, mode, created_at')
        .eq('user_id', user.id)
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('run_events')
        .select('event_type, source_type, message, created_at')
        .order('created_at', { ascending: false })
        .limit(200),
    ]);

    const runs = runsRes.data || [];
    const events = eventsRes.data || [];

    // 2. Calcola frequenza pattern eventi
    const eventPatterns: Record<string, number> = {};
    for (const e of events) {
      const key = `${e.event_type}:${e.source_type || 'unknown'}`;
      eventPatterns[key] = (eventPatterns[key] || 0) + 1;
    }

    // Ordina per frequenza
    const topPatterns = Object.entries(eventPatterns)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([key, count]) => `${sanitizeForPrompt(key)} (×${count})`);

    // 3. Recupera workflow L2/L3 esistenti dalla memoria
    const { data: existingWorkflows } = await supabase
      .from('memory_items')
      .select('title, content, tags')
      .eq('user_id', user.id)
      .in('level', ['L2', 'L3'])
      .eq('item_type', 'workflow')
      .eq('archived', false)
      .limit(20);

    const context = [
      `=== RUN COMPLETATE (${runs.length}) ===`,
      runs.slice(0, 15).map((r) => `${sanitizeForPrompt(r.title)} | ${r.mode}`).join('\n'),
      `\n=== PATTERN EVENTI TOP ===`,
      topPatterns.join('\n'),
      `\n=== WORKFLOW GIÀ NOTI (${(existingWorkflows || []).length}) ===`,
      (existingWorkflows || []).map((w) => `${sanitizeForPrompt(w.title)}: ${sanitizeForPrompt(w.content.slice(0, 80))}`).join('\n'),
    ].join('\n');

    // 4. AI genera suggerimenti (con fallback euristico)
    let suggestions: WorkflowSuggestion[] = [];

    try {
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
          model: 'google/gemini-2.5-flash',
          messages: [
            {
              role: 'system',
              content: 'Analizza i pattern di utilizzo e suggerisci 3-5 workflow automatizzabili. Ogni workflow deve avere trigger, step concreti, e stima del tempo risparmiato.',
            },
            { role: 'user', content: context },
          ],
          tools: [{
            type: 'function',
            function: {
              name: 'suggest_workflows',
              parameters: {
                type: 'object',
                properties: {
                  suggestions: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        title: { type: 'string' },
                        description: { type: 'string' },
                        trigger: { type: 'string' },
                        steps: { type: 'array', items: { type: 'string' } },
                        estimated_savings: { type: 'string' },
                        confidence: { type: 'number' },
                      },
                      required: ['title', 'description', 'trigger', 'steps', 'estimated_savings', 'confidence'],
                    },
                  },
                },
                required: ['suggestions'],
              },
            },
          }],
          tool_choice: { type: 'function', function: { name: 'suggest_workflows' } },
        }),
      });

      clearTimeout(timeout);

      if (response.ok) {
        const aiResult = await response.json();
        const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
        if (toolCall?.function?.arguments) {
          // C11 - Safe JSON parsing
          const jsonResult = validateJSON<{ suggestions?: WorkflowSuggestion[] }>(toolCall.function.arguments);
          if (jsonResult.valid && jsonResult.data) {
            suggestions = jsonResult.data.suggestions || [];
          }
        }
      }
    } catch {
      // Fallback: genera suggerimenti euristici basati su frequenza
    }

    // 5. Fallback euristico se AI non ha prodotto risultati
    if (suggestions.length === 0) {
      const frequentPatterns = Object.entries(eventPatterns)
        .filter(([, count]) => count >= 3)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3);

      for (const [pattern, count] of frequentPatterns) {
        const [eventType, sourceType] = pattern.split(':');
        suggestions.push({
          title: `Automatizza ${sanitizeForPrompt(eventType)} da ${sanitizeForPrompt(sourceType)}`,
          description: `Questo pattern si ripete ${count} volte. Potrebbe essere automatizzato.`,
          trigger: `Quando si verifica ${sanitizeForPrompt(eventType)} da ${sanitizeForPrompt(sourceType)}`,
          steps: ['Rileva evento', 'Applica regole da memoria L2/L3', 'Esegui azione', 'Valida risultato'],
          estimated_savings: `~${Math.round(count * 2)} min/settimana`,
          confidence: Math.min(90, 40 + count * 5),
        });
      }
    }

    // 6. Salva suggerimenti come memory items L1
    for (const s of suggestions) {
      await supabase.from('memory_items').insert({
        id: `wf·${Date.now().toString(36)}·${Math.random().toString(36).slice(2, 6)}`,
        user_id: user.id,
        level: 'L1',
        item_type: 'workflow',
        title: sanitizeForPrompt(s.title),
        content: `${sanitizeForPrompt(s.description)}\n\nTrigger: ${sanitizeForPrompt(s.trigger)}\nStep: ${s.steps.map(sanitizeForPrompt).join(' → ')}\nRisparmio stimato: ${sanitizeForPrompt(s.estimated_savings)}`,
        source: 'workflow-generator',
        tags: ['workflow', 'suggerimento', 'automazione'],
        confidence: s.confidence,
        usefulness: 50,
      });
    }

    return new Response(
      JSON.stringify({
        suggestions,
        total: suggestions.length,
        patternsAnalyzed: Object.keys(eventPatterns).length,
      }),
      { headers: { ...cors, 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' } }
    );
  } catch (err) {
    return handleError(err instanceof Error ? err : 'Unknown error', { status: 500, cors });
  }
});
