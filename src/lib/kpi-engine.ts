// ══════════════════════════════════════════════════════════════
// KPI Engine
// Misura l'efficacia del sistema di apprendimento Hydra
// Traccia metriche, trend, e quality score complessivo
// ══════════════════════════════════════════════════════════════

import { useMemoryStore, type MemoryItem, type MemoryLevel } from '@/stores/memory';
import { supabase } from '@/lib/supabase';

// ── Types ───────────────────────────────────────────────────

export interface LearningKPI {
  // Score complessivo 0-100
  overallScore: number;

  // Metriche di crescita
  growth: {
    itemsAddedLast7d: number;
    itemsAddedLast30d: number;
    promotionsLast7d: number;
    promotionsLast30d: number;
    growthRate: number;  // % variazione settimanale
  };

  // Qualità della conoscenza
  quality: {
    avgConfidence: number;
    avgUsefulness: number;
    l3Percentage: number;        // % item che raggiungono L3
    approvedPercentage: number;  // % item L3 approvati
    decayingItemsCount: number;  // item con decay < 0.3
    highValueItemsCount: number; // item con confidence > 80 e usefulness > 70
  };

  // Efficacia del retrieval
  retrieval: {
    avgResultsPerQuery: number;
    ragUsageCount: number;
    retrievalPrecision: number;  // % feedback positivi / totali
    feedbackPositiveRate: number;  // % feedback positivi
    feedbackNegativeRate: number;
    averageRetrievalTime: number;  // ms media per retrieval
  };

  // Health del sistema
  health: {
    duplicateConflicts: number;
    contradictionConflicts: number;
    orphanedItems: number;        // item senza tag e senza run
    staleItems: number;           // item non acceduti da > 30 giorni
    memoryUtilization: number;    // % item attivi vs totali (inclusi archiviati)
    duplicateRatio: number;       // % item duplicati
  };

  // Trend (valori precedenti per confronto)
  trend: {
    scoreChange: number;          // variazione score vs settimana scorsa
    direction: 'improving' | 'stable' | 'declining';
    trend7d: number;              // % trend su 7 giorni
    trend30d: number;             // % trend su 30 giorni
  };

  // Timestamp
  computedAt: Date;
}

export interface KPISnapshot {
  date: string;  // YYYY-MM-DD
  overallScore: number;
  totalItems: number;
  l1Count: number;
  l2Count: number;
  l3Count: number;
  avgConfidence: number;
  avgUsefulness: number;
  promotions: number;
  feedbackPositive: number;
  feedbackNegative: number;
  retrievalPrecision: number;
  averageRetrievalTime: number;
}

// ── Compute KPIs ────────────────────────────────────────────

export function computeKPIs(options?: {
  conflictsDetected?: number;
  conflictsResolved?: number;
  duplicateRatio?: number;
  retrievalTimes?: number[];
}): LearningKPI {
  const store = useMemoryStore.getState();
  const allItems = store.items;
  const activeItems = allItems.filter((i) => !i.archived);
  const promotions = store.promotions;
  const now = new Date();

  // ── Date boundaries ──
  const d7 = new Date(now.getTime() - 7 * 86400000);
  const d30 = new Date(now.getTime() - 30 * 86400000);

  // ── Growth ──
  const itemsAdded7d = activeItems.filter((i) => new Date(i.createdAt) >= d7).length;
  const itemsAdded30d = activeItems.filter((i) => new Date(i.createdAt) >= d30).length;
  const promos7d = promotions.filter((p) => new Date(p.createdAt) >= d7).length;
  const promos30d = promotions.filter((p) => new Date(p.createdAt) >= d30).length;

  // Growth rate: items questa settimana vs settimana precedente
  const d14 = new Date(now.getTime() - 14 * 86400000);
  const itemsPrevWeek = activeItems.filter(
    (i) => new Date(i.createdAt) >= d14 && new Date(i.createdAt) < d7
  ).length;
  const growthRate = itemsPrevWeek > 0
    ? ((itemsAdded7d - itemsPrevWeek) / itemsPrevWeek) * 100
    : itemsAdded7d > 0 ? 100 : 0;

  // ── Quality ──
  const avgConf = activeItems.length > 0
    ? activeItems.reduce((s, i) => s + i.confidence, 0) / activeItems.length
    : 0;
  const avgUse = activeItems.length > 0
    ? activeItems.reduce((s, i) => s + i.usefulness, 0) / activeItems.length
    : 0;

  // L1, L2, L3 counts - ALWAYS calculated regardless of L3 percentage
  const l1Items = activeItems.filter((i) => i.level === 'L1');
  const l2Items = activeItems.filter((i) => i.level === 'L2');
  const l3Items = activeItems.filter((i) => i.level === 'L3');
  const l1Count = l1Items.length;
  const l2Count = l2Items.length;
  const l3Count = l3Items.length;

  const l3Pct = activeItems.length > 0 ? (l3Items.length / activeItems.length) * 100 : 0;
  const approvedPct = l3Items.length > 0
    ? (l3Items.filter((i) => i.approved).length / l3Items.length) * 100
    : 0;
  const decaying = activeItems.filter((i) => i.relevanceDecay < 0.3 && i.level !== 'L3').length;
  const highValue = activeItems.filter((i) => i.confidence > 80 && i.usefulness > 70).length;

  // ── Retrieval / Feedback ──
  const withFeedback = activeItems.filter((i) => i.feedback);
  const positiveFeedback = withFeedback.filter((i) => i.feedback === 'positive').length;
  const negativeFeedback = withFeedback.filter((i) => i.feedback === 'negative').length;
  const totalFeedback = withFeedback.length;
  const positiveRate = totalFeedback > 0 ? (positiveFeedback / totalFeedback) * 100 : 50;
  const negativeRate = totalFeedback > 0 ? (negativeFeedback / totalFeedback) * 100 : 0;

  // Retrieval precision: ratio of positive feedback / total feedback
  const retrievalPrecision = totalFeedback > 0
    ? (positiveFeedback / totalFeedback) * 100
    : 0;

  // Average retrieval time from options or default to 0
  const avgRetrievalTime = options?.retrievalTimes && options.retrievalTimes.length > 0
    ? options.retrievalTimes.reduce((a, b) => a + b, 0) / options.retrievalTimes.length
    : 0;

  // ── Health ──
  const orphaned = activeItems.filter(
    (i) => i.tags.length === 0 && !i.runId
  ).length;
  const stale = activeItems.filter((i) => {
    const lastAccess = new Date(i.updatedAt);
    return (now.getTime() - lastAccess.getTime()) > 30 * 86400000;
  }).length;
  const utilization = allItems.length > 0
    ? (activeItems.length / allItems.length) * 100
    : 100;

  // Conflicts from conflict resolver
  const duplicateConflicts = options?.conflictsDetected || 0;
  const conflictsResolved = options?.conflictsResolved || 0;
  const duplicateRatio = options?.duplicateRatio || 0;

  // ── Overall Score (0-100) ──
  // Pesi: qualità 35%, growth 20%, retrieval 25%, health 20%
  const qualityScore = (
    normalize(avgConf, 0, 100) * 0.3 +
    normalize(avgUse, 0, 100) * 0.3 +
    normalize(l3Pct, 0, 30) * 0.2 +   // 30% L3 = massimo
    normalize(highValue, 0, Math.max(activeItems.length * 0.3, 1)) * 0.2
  ) * 100;

  const growthScore = (
    normalize(itemsAdded7d, 0, 20) * 0.4 +
    normalize(promos7d, 0, 5) * 0.4 +
    (growthRate > 0 ? 0.2 : growthRate > -20 ? 0.1 : 0)
  ) * 100;

  const retrievalScore = (
    normalize(positiveRate, 0, 100) * 0.6 +
    (1 - normalize(negativeRate, 0, 50)) * 0.4
  ) * 100;

  const healthScore = (
    (1 - normalize(orphaned, 0, Math.max(activeItems.length * 0.3, 1))) * 0.3 +
    (1 - normalize(stale, 0, Math.max(activeItems.length * 0.5, 1))) * 0.3 +
    normalize(utilization, 0, 100) * 0.2 +
    (1 - normalize(decaying, 0, Math.max(activeItems.length * 0.4, 1))) * 0.2
  ) * 100;

  const overallScore = Math.round(
    qualityScore * 0.35 +
    growthScore * 0.20 +
    retrievalScore * 0.25 +
    healthScore * 0.20
  );

  return {
    overallScore: Math.min(100, Math.max(0, overallScore)),
    growth: {
      itemsAddedLast7d: itemsAdded7d,
      itemsAddedLast30d: itemsAdded30d,
      promotionsLast7d: promos7d,
      promotionsLast30d: promos30d,
      growthRate: Math.round(growthRate),
    },
    quality: {
      avgConfidence: Math.round(avgConf),
      avgUsefulness: Math.round(avgUse),
      l3Percentage: Math.round(l3Pct * 10) / 10,
      approvedPercentage: Math.round(approvedPct),
      decayingItemsCount: decaying,
      highValueItemsCount: highValue,
    },
    retrieval: {
      avgResultsPerQuery: 0, // Richiede tracking separato
      ragUsageCount: 0,
      retrievalPrecision: Math.round(retrievalPrecision),
      feedbackPositiveRate: Math.round(positiveRate),
      feedbackNegativeRate: Math.round(negativeRate),
      averageRetrievalTime: Math.round(avgRetrievalTime * 10) / 10,
    },
    health: {
      duplicateConflicts: duplicateConflicts,
      contradictionConflicts: conflictsResolved,
      orphanedItems: orphaned,
      staleItems: stale,
      memoryUtilization: Math.round(utilization),
      duplicateRatio: Math.round(duplicateRatio * 10) / 10,
    },
    trend: {
      scoreChange: 0, // Calcolato sotto con storia
      direction: 'stable',
      trend7d: 0,
      trend30d: 0,
    },
    computedAt: now,
  };
}

// ── Snapshot per storico ────────────────────────────────────

export function takeSnapshot(): KPISnapshot {
  const kpi = computeKPIs();
  const store = useMemoryStore.getState();
  const active = store.items.filter((i) => !i.archived);

  const l1Count = active.filter((i) => i.level === 'L1').length;
  const l2Count = active.filter((i) => i.level === 'L2').length;
  const l3Count = active.filter((i) => i.level === 'L3').length;

  return {
    date: new Date().toISOString().slice(0, 10),
    overallScore: kpi.overallScore,
    totalItems: active.length,
    l1Count: l1Count,
    l2Count: l2Count,
    l3Count: l3Count,
    avgConfidence: kpi.quality.avgConfidence,
    avgUsefulness: kpi.quality.avgUsefulness,
    promotions: kpi.growth.promotionsLast7d,
    feedbackPositive: store.items.filter((i) => i.feedback === 'positive').length,
    feedbackNegative: store.items.filter((i) => i.feedback === 'negative').length,
    retrievalPrecision: kpi.retrieval.retrievalPrecision,
    averageRetrievalTime: kpi.retrieval.averageRetrievalTime,
  };
}

/**
 * Salva snapshot su Supabase per storico KPI
 */
export async function saveSnapshotToSupabase(userId: string): Promise<void> {
  const snapshot = takeSnapshot();
  await supabase.from('memory_kpi_snapshots').upsert({
    user_id: userId,
    date: snapshot.date,
    data: snapshot,
  }, { onConflict: 'user_id,date' });
}

/**
 * Carica storico KPI per grafici trend
 */
export async function loadKPIHistory(
  userId: string,
  days: number = 30
): Promise<KPISnapshot[]> {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const { data } = await supabase
    .from('memory_kpi_snapshots')
    .select('data')
    .eq('user_id', userId)
    .gte('date', since)
    .order('date', { ascending: true });

  return (data || []).map((row: any) => row.data as KPISnapshot);
}

/**
 * Calcola trend reali da storico: 7-day e 30-day
 * Ritorna % di cambio dal valore medio precedente
 */
export function calculateTrends(history: KPISnapshot[]): {
  scoreChange: number;
  direction: 'improving' | 'stable' | 'declining';
  trend7d: number;
  trend30d: number;
} {
  if (history.length < 2) {
    return {
      scoreChange: 0,
      direction: 'stable',
      trend7d: 0,
      trend30d: 0,
    };
  }

  const currentScore = history[history.length - 1].overallScore;

  // Calcola trend 7 giorni: media dei 7 giorni precedenti vs media degli ultimi 2
  let trend7d = 0;
  if (history.length >= 7) {
    const last7 = history.slice(-7);
    const avg7Recent = last7.reduce((s, h) => s + h.overallScore, 0) / last7.length;
    const prevWeek = history.length >= 14
      ? history.slice(-14, -7).reduce((s, h) => s + h.overallScore, 0) / 7
      : avg7Recent;
    trend7d = prevWeek > 0 ? ((avg7Recent - prevWeek) / prevWeek) * 100 : 0;
  }

  // Calcola trend 30 giorni
  let trend30d = 0;
  if (history.length >= 30) {
    const last30 = history.slice(-30);
    const avg30Recent = last30.reduce((s, h) => s + h.overallScore, 0) / last30.length;
    const prevMonth = history.length >= 60
      ? history.slice(-60, -30).reduce((s, h) => s + h.overallScore, 0) / 30
      : avg30Recent;
    trend30d = prevMonth > 0 ? ((avg30Recent - prevMonth) / prevMonth) * 100 : 0;
  } else if (history.length > 1) {
    // Se meno di 30 giorni di storia, usa quello che abbiamo
    const firstScore = history[0].overallScore;
    trend30d = firstScore > 0 ? ((currentScore - firstScore) / firstScore) * 100 : 0;
  }

  // Determina direzione da trend7d (più recente)
  let direction: 'improving' | 'stable' | 'declining' = 'stable';
  if (trend7d > 2) {
    direction = 'improving';
  } else if (trend7d < -2) {
    direction = 'declining';
  }

  // Score change: differenza dal giorno precedente (se disponibile)
  let scoreChange = 0;
  if (history.length >= 2) {
    const prevScore = history[history.length - 2].overallScore;
    scoreChange = currentScore - prevScore;
  }

  return {
    scoreChange: Math.round(scoreChange * 10) / 10,
    direction,
    trend7d: Math.round(trend7d * 10) / 10,
    trend30d: Math.round(trend30d * 10) / 10,
  };
}

/**
 * Compute KPIs con trend dal storico
 */
export async function computeKPIsWithTrends(
  userId: string,
  options?: {
    conflictsDetected?: number;
    conflictsResolved?: number;
    duplicateRatio?: number;
    retrievalTimes?: number[];
  }
): Promise<LearningKPI> {
  const kpi = computeKPIs(options);
  const history = await loadKPIHistory(userId, 30);
  const trends = calculateTrends(history);

  return {
    ...kpi,
    trend: trends,
  };
}

// ── Helpers ─────────────────────────────────────────────────

function normalize(value: number, min: number, max: number): number {
  if (max <= min) return 0.5;  // midpoint instead of floor when max=min
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}
