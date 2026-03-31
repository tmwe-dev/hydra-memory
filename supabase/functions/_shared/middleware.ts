// ══════════════════════════════════════════════════════════════
// Shared Middleware for Edge Functions
// Security utilities for authentication, CORS, rate limiting, validation
// ══════════════════════════════════════════════════════════════

const RATE_LIMIT_MAP = new Map<string, { count: number; resetAt: number }>();

// ────────────────────────────────────────────────────────────────
// validateAuth: Extract and validate Bearer token properly
// ────────────────────────────────────────────────────────────────
export function validateAuth(req: Request): { token: string; valid: boolean; error?: string } {
  const authHeader = req.headers.get('Authorization');

  if (!authHeader) {
    return { token: '', valid: false, error: 'Missing Authorization header' };
  }

  if (!authHeader.startsWith('Bearer ')) {
    return { token: '', valid: false, error: 'Invalid Authorization format' };
  }

  const token = authHeader.slice(7); // Remove "Bearer " prefix

  if (!token || token.length === 0) {
    return { token: '', valid: false, error: 'Empty Bearer token' };
  }

  return { token, valid: true };
}

// ────────────────────────────────────────────────────────────────
// rateLimit: In-memory rate limiter with Map<string, {count, resetAt}>
// ────────────────────────────────────────────────────────────────
export function rateLimit(
  userId: string,
  endpoint: string,
  maxPerMin: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const key = `${userId}:${endpoint}`;
  const now = Date.now();
  let bucket = RATE_LIMIT_MAP.get(key);

  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + 60000 };
    RATE_LIMIT_MAP.set(key, bucket);
  }

  bucket.count++;

  const remaining = Math.max(0, maxPerMin - bucket.count);
  const allowed = bucket.count <= maxPerMin;

  // Cleanup old entries
  if (RATE_LIMIT_MAP.size > 10000) {
    for (const [k, v] of RATE_LIMIT_MAP.entries()) {
      if (v.resetAt < now) {
        RATE_LIMIT_MAP.delete(k);
      }
    }
  }

  return { allowed, remaining, resetAt: bucket.resetAt };
}

// ────────────────────────────────────────────────────────────────
// corsHeaders: Whitelist-based CORS (default: allow configured domains)
// ────────────────────────────────────────────────────────────────
export function corsHeaders(
  origin: string | null,
  allowedOrigins: string[] = []
): Record<string, string> {
  const isAllowed = allowedOrigins.length === 0 || (origin && allowedOrigins.includes(origin));

  return {
    'Access-Control-Allow-Origin': isAllowed && origin ? origin : '',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

// ────────────────────────────────────────────────────────────────
// handleError: Consistent error response with proper HTTP status codes
// ────────────────────────────────────────────────────────────────
export function handleError(
  error: Error | string,
  context?: { status?: number; cors?: Record<string, string> }
): Response {
  const status = context?.status || 500;
  const cors = context?.cors || { 'Content-Type': 'application/json' };

  let message = typeof error === 'string' ? error : error.message;

  // Log error details (in production, send to logging service)
  if (typeof error !== 'string') {
    console.error('[Edge Function Error]', {
      message: error.message,
      stack: error.stack,
      status,
    });
  }

  // Sanitize error message for client
  if (status === 500) {
    message = 'Internal server error';
  }

  return new Response(
    JSON.stringify({
      error: message,
      status,
      timestamp: new Date().toISOString(),
    }),
    {
      status,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
}

// ────────────────────────────────────────────────────────────────
// validateJSON: Safe JSON.parse with try/catch
// ────────────────────────────────────────────────────────────────
export function validateJSON<T = any>(text: string): { valid: boolean; data?: T; error?: string } {
  try {
    const data = JSON.parse(text) as T;
    return { valid: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid JSON';
    return { valid: false, error: message };
  }
}

// ────────────────────────────────────────────────────────────────
// sanitizeForPrompt: Escape user content before AI prompt injection
// ────────────────────────────────────────────────────────────────
export function sanitizeForPrompt(text: string): string {
  if (!text) return '';

  // Escape special characters that could break prompt structure
  return text
    .replace(/\\/g, '\\\\') // Backslash
    .replace(/"/g, '\\"') // Double quotes
    .replace(/\n/g, '\\n') // Newlines
    .replace(/\r/g, '\\r') // Carriage returns
    .replace(/\t/g, '\\t') // Tabs
    .slice(0, 1000); // Limit length to prevent token exhaustion
}

// ────────────────────────────────────────────────────────────────
// validateAIResponse: Schema validation for AI outputs
// ────────────────────────────────────────────────────────────────
export function validateAIResponse(
  data: any,
  requiredFields: string[]
): { valid: boolean; error?: string } {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Response is not an object' };
  }

  for (const field of requiredFields) {
    if (!(field in data)) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  return { valid: true };
}
