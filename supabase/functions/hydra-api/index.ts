// ══════════════════════════════════════════════════════════════
// HYDRA MEMORY — Standalone REST API
// Servizio centralizzato di memoria AI. Qualsiasi app si collega.
// Endpoint: POST /hydra-api { action, ... }
// Auth: Bearer token (Supabase JWT o API key)
// ══════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

// ── Types ──

interface RequestBody {
  action: string;
  user_id?: string;
  [key: string]: unknown;
}

// ── Helpers ──

function getEnv(key: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing env: ${key}`);
  return value;
}

function corsHeaders(origin?: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-hydra-key",
    "Content-Type": "application/json",
  };
}

// Rate limiting
const rateLimits = new Map<string, number[]>();
function checkRate(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (rateLimits.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  rateLimits.set(key, hits);
  return true;
}

// Extract user from JWT or API key
async function authenticateRequest(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<string> {
  // Option 1: Supabase JWT in Authorization header
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (user && !error) return user.id;
  }

  // Option 2: x-hydra-key header (for extensions like FireScrape)
  const hydraKey = req.headers.get("x-hydra-key");
  if (hydraKey) {
    const { data, error } = await supabase
      .from("hydra_api_keys")
      .select("user_id, is_active")
      .eq("api_key_hash", await hashKey(hydraKey))
      .eq("is_active", true)
      .single();

    if (data && !error) return data.user_id;
  }

  throw new Error("Authentication required");
}

async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ══════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ══════════════════════════════════════════════════════════════

// ── Memory: Save ──
async function handleMemorySave(
  body: RequestBody,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Record<string, unknown>> {
  const { level, type, title, content, tags, carrier, confidence, source } = body;

  if (!title || !content || !type) {
    throw new Error("Required: title, content, type");
  }

  const { data, error } = await supabase
    .from("hydra_memory_items")
    .insert({
      user_id: userId,
      level: level || "L1",
      type,
      title,
      content,
      tags: tags || [],
      carrier: carrier || null,
      confidence: confidence || 50,
      usefulness: 50,
      relevance: 1.0,
      source: source || "api",
      approved: false,
      pinned: false,
      archived: false,
      version: 1,
    })
    .select("id, level, title, created_at")
    .single();

  if (error) throw error;
  return { success: true, item: data };
}

// ── Memory: Search ──
async function handleMemorySearch(
  body: RequestBody,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Record<string, unknown>> {
  const { query, carrier, level, limit: maxItems } = body;
  const searchLimit = Math.min(Number(maxItems) || 20, 100);

  let q = supabase
    .from("hydra_memory_items")
    .select("*")
    .eq("user_id", userId)
    .eq("archived", false)
    .order("confidence", { ascending: false })
    .order("relevance", { ascending: false })
    .limit(searchLimit);

  if (level) q = q.eq("level", level);
  if (carrier) q = q.eq("carrier", carrier);

  // Text search via title/content/tags
  if (query && typeof query === "string") {
    q = q.or(`title.ilike.%${query}%,content.ilike.%${query}%`);
  }

  const { data, error } = await q;
  if (error) throw error;

  return { items: data || [], count: (data || []).length };
}

// ── Memory: Update ──
async function handleMemoryUpdate(
  body: RequestBody,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Record<string, unknown>> {
  const { item_id, updates } = body;
  if (!item_id) throw new Error("Required: item_id");

  const allowedFields = [
    "title", "content", "tags", "carrier", "confidence",
    "usefulness", "relevance", "approved", "pinned", "archived"
  ];

  const safeUpdates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if ((updates as Record<string, unknown>)?.[field] !== undefined) {
      safeUpdates[field] = (updates as Record<string, unknown>)[field];
    }
  }
  safeUpdates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("hydra_memory_items")
    .update(safeUpdates)
    .eq("id", item_id)
    .eq("user_id", userId)
    .select("id, level, title, version")
    .single();

  if (error) throw error;
  return { success: true, item: data };
}

// ── Memory: Delete ──
async function handleMemoryDelete(
  body: RequestBody,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Record<string, unknown>> {
  const { item_id } = body;
  if (!item_id) throw new Error("Required: item_id");

  const { error } = await supabase
    .from("hydra_memory_items")
    .update({ archived: true, updated_at: new Date().toISOString() })
    .eq("id", item_id)
    .eq("user_id", userId);

  if (error) throw error;
  return { success: true, archived: item_id };
}

// ── Memory: Promote ──
async function handleMemoryPromote(
  body: RequestBody,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Record<string, unknown>> {
  const { item_id } = body;
  if (!item_id) throw new Error("Required: item_id");

  // Get current item
  const { data: item, error: getErr } = await supabase
    .from("hydra_memory_items")
    .select("*")
    .eq("id", item_id)
    .eq("user_id", userId)
    .single();

  if (getErr || !item) throw new Error("Item not found");

  const nextLevel = item.level === "L1" ? "L2" : item.level === "L2" ? "L3" : null;
  if (!nextLevel) return { success: false, reason: "Already at L3" };

  // Update item level
  const { error: updateErr } = await supabase
    .from("hydra_memory_items")
    .update({
      level: nextLevel,
      promoted_from: item.level,
      promoted_at: new Date().toISOString(),
      relevance: Math.min((item.relevance || 0.5) * 1.2, 1.0),
      version: (item.version || 1) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", item_id)
    .eq("user_id", userId);

  if (updateErr) throw updateErr;

  // Log promotion
  await supabase.from("hydra_memory_promotions").insert({
    item_id,
    user_id: userId,
    from_level: item.level,
    to_level: nextLevel,
    reason: (body.reason as string) || "api_promote",
    snapshot: item,
  });

  return { success: true, from: item.level, to: nextLevel };
}

// ── Memory: Increment Access ──
async function handleMemoryAccess(
  body: RequestBody,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Record<string, unknown>> {
  const { item_id } = body;
  if (!item_id) throw new Error("Required: item_id");

  const { data, error } = await supabase.rpc("hydra_increment_access", {
    p_item_id: item_id,
  });

  if (error) throw error;
  return { success: true };
}

// ── KB: Save Rule ──
async function handleKBSave(
  body: RequestBody,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Record<string, unknown>> {
  const { carrier_code, title, content, rule_type, operation_type, priority, tags } = body;

  if (!title || !content) throw new Error("Required: title, content");

  const { data, error } = await supabase
    .from("hydra_knowledge_rules")
    .insert({
      user_id: userId,
      carrier_code: carrier_code || null,
      title,
      content,
      rule_type: rule_type || "instruction",
      operation_type: operation_type || "general",
      priority: priority || 5,
      tags: tags || [],
      source: (body.source as string) || "api",
      is_active: true,
    })
    .select("id, title, carrier_code, created_at")
    .single();

  if (error) throw error;
  return { success: true, rule: data };
}

// ── KB: Search Rules ──
async function handleKBSearch(
  body: RequestBody,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Record<string, unknown>> {
  const { query, carrier, limit: maxItems } = body;
  const searchLimit = Math.min(Number(maxItems) || 50, 200);

  let q = supabase
    .from("hydra_knowledge_rules")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("priority", { ascending: false })
    .limit(searchLimit);

  if (carrier) q = q.eq("carrier_code", carrier);
  if (query && typeof query === "string") {
    q = q.or(`title.ilike.%${query}%,content.ilike.%${query}%`);
  }

  const { data, error } = await q;
  if (error) throw error;

  return { rules: data || [], count: (data || []).length };
}

// ── KB: Update Rule ──
async function handleKBUpdate(
  body: RequestBody,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Record<string, unknown>> {
  const { rule_id, updates } = body;
  if (!rule_id) throw new Error("Required: rule_id");

  const allowedFields = [
    "title", "content", "carrier_code", "rule_type", "operation_type",
    "priority", "tags", "is_active"
  ];

  const safeUpdates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if ((updates as Record<string, unknown>)?.[field] !== undefined) {
      safeUpdates[field] = (updates as Record<string, unknown>)[field];
    }
  }
  safeUpdates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("hydra_knowledge_rules")
    .update(safeUpdates)
    .eq("id", rule_id)
    .eq("user_id", userId)
    .select("id, title")
    .single();

  if (error) throw error;
  return { success: true, rule: data };
}

// ── KB: Delete Rule ──
async function handleKBDelete(
  body: RequestBody,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Record<string, unknown>> {
  const { rule_id } = body;
  if (!rule_id) throw new Error("Required: rule_id");

  const { error } = await supabase
    .from("hydra_knowledge_rules")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", rule_id)
    .eq("user_id", userId);

  if (error) throw error;
  return { success: true, deactivated: rule_id };
}

// ── Memory: Get Context (RAG) ──
async function handleGetContext(
  body: RequestBody,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Record<string, unknown>> {
  const { query, carrier, max_items } = body;
  const limit = Math.min(Number(max_items) || 20, 50);

  // Get relevant memory items (L2 + L3 prioritized, then high-confidence L1)
  let memQ = supabase
    .from("hydra_memory_items")
    .select("level, type, title, content, tags, carrier, confidence")
    .eq("user_id", userId)
    .eq("archived", false)
    .or("level.eq.L3,level.eq.L2,and(level.eq.L1,confidence.gte.60)")
    .order("level", { ascending: false })
    .order("confidence", { ascending: false })
    .limit(limit);

  if (carrier) memQ = memQ.or(`carrier.eq.${carrier},tags.cs.{${carrier}}`);

  // Get active KB rules
  let rulesQ = supabase
    .from("hydra_knowledge_rules")
    .select("title, content, carrier_code, priority, tags")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("priority", { ascending: false })
    .limit(30);

  if (carrier) rulesQ = rulesQ.eq("carrier_code", carrier);

  const [memResult, rulesResult] = await Promise.all([memQ, rulesQ]);

  // Build context string
  const memoryContext = (memResult.data || [])
    .map((m: any) => `[${m.level}|${m.type}|conf:${m.confidence}] ${m.title}: ${m.content}`)
    .join("\n");

  const rulesContext = (rulesResult.data || [])
    .map((r: any) => `[RULE|p:${r.priority}] ${r.title}: ${r.content}`)
    .join("\n");

  return {
    memory_context: memoryContext,
    rules_context: rulesContext,
    memory_count: (memResult.data || []).length,
    rules_count: (rulesResult.data || []).length,
  };
}

// ── Health ──
async function handleHealth(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Record<string, unknown>> {
  const { data } = await supabase.rpc("hydra_memory_stats", { p_user_id: userId });

  return {
    status: "ok",
    stats: data?.[0] || {},
    timestamp: new Date().toISOString(),
  };
}

// ── Feedback ──
async function handleFeedback(
  body: RequestBody,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Record<string, unknown>> {
  const { item_id, feedback_type, context } = body;
  if (!item_id || !feedback_type) throw new Error("Required: item_id, feedback_type");

  const { error } = await supabase.from("hydra_memory_feedback").insert({
    item_id,
    user_id: userId,
    feedback_type,
    context: context || null,
  });

  if (error) throw error;

  // Adjust confidence based on feedback
  const delta = feedback_type === "positive" ? 5 : -5;
  await supabase.rpc("hydra_adjust_confidence", { p_item_id: item_id, p_delta: delta });

  return { success: true };
}

// ── Decay (run maintenance) ──
async function handleDecay(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc("hydra_apply_decay", { p_user_id: userId });
  if (error) throw error;

  return {
    success: true,
    decayed: (data || []).length,
    items: data || [],
  };
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════

serve(async (req: Request) => {
  const origin = req.headers.get("origin") || undefined;
  const cors = corsHeaders(origin);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  // Rate limit by IP
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  if (!checkRate(ip, 120, 60000)) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429, headers: cors,
    });
  }

  try {
    const body = (await req.json()) as RequestBody;
    const { action } = body;

    if (!action) {
      return new Response(JSON.stringify({ error: "Missing action" }), {
        status: 400, headers: cors,
      });
    }

    // Init Supabase with service role
    const supabaseUrl = getEnv("SUPABASE_URL");
    const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Authenticate user
    const userId = await authenticateRequest(req, supabase);

    // Route to handler
    let result: Record<string, unknown>;

    switch (action) {
      // Memory operations
      case "memory.save":
        result = await handleMemorySave(body, supabase, userId);
        break;
      case "memory.search":
        result = await handleMemorySearch(body, supabase, userId);
        break;
      case "memory.update":
        result = await handleMemoryUpdate(body, supabase, userId);
        break;
      case "memory.delete":
        result = await handleMemoryDelete(body, supabase, userId);
        break;
      case "memory.promote":
        result = await handleMemoryPromote(body, supabase, userId);
        break;
      case "memory.access":
        result = await handleMemoryAccess(body, supabase, userId);
        break;
      case "memory.feedback":
        result = await handleFeedback(body, supabase, userId);
        break;
      case "memory.decay":
        result = await handleDecay(supabase, userId);
        break;

      // KB operations
      case "kb.save":
        result = await handleKBSave(body, supabase, userId);
        break;
      case "kb.search":
        result = await handleKBSearch(body, supabase, userId);
        break;
      case "kb.update":
        result = await handleKBUpdate(body, supabase, userId);
        break;
      case "kb.delete":
        result = await handleKBDelete(body, supabase, userId);
        break;

      // Context (RAG)
      case "context.get":
        result = await handleGetContext(body, supabase, userId);
        break;

      // Health
      case "health":
        result = await handleHealth(supabase, userId);
        break;

      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400, headers: cors,
        });
    }

    return new Response(JSON.stringify(result), { status: 200, headers: cors });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Authentication") ? 401 : 500;
    return new Response(JSON.stringify({ error: message }), {
      status, headers: cors,
    });
  }
});
