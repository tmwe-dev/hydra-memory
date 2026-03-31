// ══════════════════════════════════════════════════════════════
// Hydra Memory — Public API (TypeScript)
// Interfaccia completa per integrare il sistema di memoria
// in qualsiasi componente dell'applicazione
// ══════════════════════════════════════════════════════════════

// ── Re-export Types ─────────────────────────────────────────

export type {
  MemoryItem,
  MemoryLevel,
  MemoryItemType,
  PromotionRecord,
  RetrievalResult,
} from '@/stores/memory';

export type {
  Conflict,
  ConflictType,
  ResolutionStrategy,
  ConflictResolutionLog,
} from '@/lib/conflict-resolver';

export type { LearningKPI, KPISnapshot, KPIComputeOptions } from '@/lib/kpi-engine';
export type { SeedPack, SeedItem } from '@/lib/cold-start-seed';
export type {
  SecurityConfig,
  WorkspaceContext,
  WorkspacePermissions,
  PIIDetectionResult,
  AuditEntry,
} from '@/lib/memory-security';

// ── Re-export Store ─────────────────────────────────────────

export { useMemoryStore } from '@/stores/memory';

// ── Re-export Hooks ─────────────────────────────────────────

export { useHydraMemory } from '@/hooks/useHydraMemory';

// ── Re-export Components ────────────────────────────────────

export { default as KnowledgeDashboard } from '@/components/KnowledgeDashboard';
export { default as KnowledgeGraph } from '@/components/KnowledgeGraph';

// ── Re-export Libraries ─────────────────────────────────────

export {
  buildRAGContext,
  augmentPromptWithMemory,
  learnFromAIResponse,
  analyzeNegativeFeedback,
} from '@/lib/memory-rag';

export {
  detectConflicts,
  detectConflictsWithEmbeddings,
  resolveConflict,
  autoResolveConflicts,
  undoResolve,
  commitPendingArchives,
  getResolutionLogs,
} from '@/lib/conflict-resolver';

export {
  computeKPIs,
  computeKPIsWithTrends,
  takeSnapshot,
  saveSnapshotToSupabase,
  loadKPIHistory,
} from '@/lib/kpi-engine';

export {
  LOGISTICS_SEED_PACK,
  SYSTEM_SEED_PACK,
  CUSTOMS_SEED_PACK,
  MARITIME_SEED_PACK,
  applySeedPack,
  initializeColdStart,
  migrateFromLegacy,
  isColdStartCompleted,
  validateSeedItem,
} from '@/lib/cold-start-seed';

export {
  DEFAULT_SECURITY_CONFIG,
  getPermissions,
  checkPermission,
  encryptContent,
  decryptContent,
  encryptItem,
  decryptItem,
  detectPII,
  maskPII,
  sanitizeContent,
  createAuditEntry,
  findExpiredItems,
  validateTags,
  validateMemoryItem,
} from '@/lib/memory-security';

// ══════════════════════════════════════════════════════════════
// Convenience API — Funzioni ad alto livello
// ══════════════════════════════════════════════════════════════

import { useMemoryStore } from '@/stores/memory';
import type { MemoryItemType } from '@/stores/memory';
import { buildRAGContext, learnFromAIResponse } from '@/lib/memory-rag';
import { autoResolveConflicts } from '@/lib/conflict-resolver';
import { computeKPIs } from '@/lib/kpi-engine';
import { initializeColdStart, isColdStartCompleted } from '@/lib/cold-start-seed';
import { sanitizeContent, DEFAULT_SECURITY_CONFIG } from '@/lib/memory-security';

// ── Error types ─────────────────────────────────────────────

export class HydraInitError extends Error {
  constructor(
    message: string,
    public readonly phase: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'HydraInitError';
  }
}

export class HydraSyncError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'HydraSyncError';
  }
}

// ── Valid item types ────────────────────────────────────────

const VALID_ITEM_TYPES: Set<string> = new Set([
  'fact', 'rule', 'pattern', 'workflow', 'preference',
  'schema', 'template', 'glossary', 'metric',
]);

function validateItemType(type: string): MemoryItemType {
  if (!VALID_ITEM_TYPES.has(type)) {
    throw new Error(`Invalid item type "${type}". Valid types: ${[...VALID_ITEM_TYPES].join(', ')}`);
  }
  return type as MemoryItemType;
}

/**
 * Inizializza il sistema completo di memoria Hydra.
 * Da chiamare una volta al boot dell'applicazione.
 *
 * @example
 * ```ts
 * import { initHydraMemory } from '@/api';
 *
 * const result = await initHydraMemory();
 * console.log(`Sistema inizializzato: ${result.itemsLoaded} item caricati`);
 * ```
 */
export async function initHydraMemory(options?: {
  skipColdStart?: boolean;
  skipSync?: boolean;
}): Promise<{
  itemsLoaded: number;
  coldStartApplied: boolean;
  conflictsResolved: number;
  errors: string[];
}> {
  const store = useMemoryStore.getState();
  const errors: string[] = [];

  // 1. Cold start se prima volta
  let coldStartApplied = false;
  if (!options?.skipColdStart && !isColdStartCompleted()) {
    try {
      initializeColdStart();
      coldStartApplied = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Cold start failed: ${msg}`);
    }
  }

  // 2. Sync da Supabase
  if (!options?.skipSync) {
    try {
      await store.syncFromSupabase();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Sync failed (using local data): ${msg}`);
    }
  }

  // 3. Applica decay
  try {
    store.applyDecay();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Decay failed: ${msg}`);
  }

  // 4. Auto-resolve conflitti
  let conflictsResolved = 0;
  try {
    const { resolved } = autoResolveConflicts();
    conflictsResolved = resolved;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Conflict resolution failed: ${msg}`);
  }

  // 5. Promozione automatica
  try {
    store.runPromotionScan();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Promotion scan failed: ${msg}`);
  }

  return {
    itemsLoaded: store.items.length,
    coldStartApplied,
    conflictsResolved,
    errors,
  };
}

/**
 * Wrapper per chiamate AI con RAG automatico.
 * Arricchisce il prompt con contesto dalla memoria.
 *
 * @example
 * ```ts
 * import { withMemoryContext } from '@/api';
 *
 * const { system, user } = withMemoryContext(
 *   'Sei un assistente logistico.',
 *   'Qual è la tariffa migliore per spedire 50kg in Francia?'
 * );
 * ```
 */
export function withMemoryContext(
  systemPrompt: string,
  userPrompt: string,
  options?: { maxItems?: number; maxTokens?: number }
): { system: string; user: string } {
  if (!systemPrompt || typeof systemPrompt !== 'string') {
    throw new Error('systemPrompt must be a non-empty string');
  }
  if (!userPrompt || typeof userPrompt !== 'string') {
    throw new Error('userPrompt must be a non-empty string');
  }

  try {
    const ragContext = buildRAGContext(userPrompt, options);
    if (!ragContext) return { system: systemPrompt, user: userPrompt };
    return {
      system: `${systemPrompt}\n\n${ragContext}`,
      user: userPrompt,
    };
  } catch (err) {
    // If RAG fails, return original prompts rather than crashing
    console.error('[Hydra] RAG context build failed:', err);
    return { system: systemPrompt, user: userPrompt };
  }
}

/**
 * Registra il risultato di una run AI nella memoria.
 * Estrae automaticamente fatti e li salva come L1.
 *
 * @example
 * ```ts
 * import { recordAIResult } from '@/api';
 *
 * const ids = recordAIResult('run-123', 'Analizza listino DHL', response, {
 *   provider: 'gemini',
 *   model: 'gemini-2.5-flash',
 *   latencyMs: 1200,
 * });
 * ```
 */
export function recordAIResult(
  runId: string,
  prompt: string,
  response: string,
  metadata?: {
    provider?: string;
    model?: string;
    latencyMs?: number;
    tokenUsage?: number;
  }
): string[] {
  if (!runId || !prompt || !response) {
    throw new Error('runId, prompt, and response are required');
  }

  try {
    return learnFromAIResponse(runId, prompt, response, metadata);
  } catch (err) {
    console.error('[Hydra] recordAIResult failed:', err);
    return [];
  }
}

/**
 * Salva un item con sanitizzazione automatica.
 * Valida il tipo e sanitizza il contenuto prima del salvataggio.
 *
 * @example
 * ```ts
 * import { safeLearn } from '@/api';
 *
 * const { id, warnings } = safeLearn({
 *   type: 'fact',
 *   title: 'Nuovo pattern DHL',
 *   content: 'DHL France usa formato XLS con colonne A-F...',
 *   source: 'import-pipeline',
 *   tags: ['DHL', 'pattern'],
 * });
 * ```
 */
export function safeLearn(event: {
  type: string;
  title: string;
  content: string;
  source: string;
  tags?: string[];
}): { id: string; warnings: string[] } {
  if (!event.title || !event.content || !event.source) {
    throw new Error('title, content, and source are required');
  }

  const validType = validateItemType(event.type);
  const store = useMemoryStore.getState();
  const { sanitized, warnings } = sanitizeContent(event.content, DEFAULT_SECURITY_CONFIG);

  const id = store.learnFromEvent({
    ...event,
    content: sanitized,
    type: validType,
    tags: event.tags || [],
  });

  return { id, warnings };
}

/**
 * Ottieni lo stato di salute del sistema in formato leggibile.
 *
 * @example
 * ```ts
 * import { getHealthReport } from '@/api';
 *
 * const report = getHealthReport();
 * console.log(`Score: ${report.score}/100 — ${report.status}`);
 * ```
 */
export function getHealthReport(): {
  score: number;
  status: string;
  summary: string;
  recommendations: string[];
} {
  try {
    const kpi = computeKPIs();
    const recommendations: string[] = [];

    if (kpi.quality.avgConfidence < 50) {
      recommendations.push('La confidence media è bassa. Rivedi e approva gli item L2 importanti.');
    }
    if (kpi.health.staleItems > 10) {
      recommendations.push(`${kpi.health.staleItems} item non acceduti da >30 giorni. Considera di archiviarli.`);
    }
    if (kpi.health.orphanedItems > 5) {
      recommendations.push(`${kpi.health.orphanedItems} item senza tag. Aggiungere tag migliora il retrieval.`);
    }
    if (kpi.quality.l3Percentage < 5) {
      recommendations.push('Pochi item L3. Approva gli item L2 maturi per consolidare la conoscenza.');
    }
    if (kpi.retrieval.feedbackNegativeRate > 30) {
      recommendations.push('Troppo feedback negativo. Rivedi gli item con bassa qualità.');
    }
    if (kpi.growth.growthRate < -20) {
      recommendations.push('Il sistema sta crescendo lentamente. Esegui più run per alimentare L1.');
    }

    const status = kpi.overallScore >= 80 ? 'Eccellente'
      : kpi.overallScore >= 60 ? 'Buono'
      : kpi.overallScore >= 40 ? 'Sufficiente'
      : 'Critico';

    return {
      score: kpi.overallScore,
      status,
      summary: `${kpi.quality.avgConfidence}% confidence media, ${kpi.growth.promotionsLast7d} promozioni questa settimana, ${kpi.health.memoryUtilization}% utilizzo`,
      recommendations,
    };
  } catch (err) {
    console.error('[Hydra] Health report failed:', err);
    return {
      score: 0,
      status: 'Errore',
      summary: 'Impossibile calcolare KPI',
      recommendations: ['Verificare la connessione al database e riprovare.'],
    };
  }
}
