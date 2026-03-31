-- ══════════════════════════════════════════════════════════════
-- Hydra Workbench — Helper Functions
-- Funzioni ausiliarie per memory system
-- ══════════════════════════════════════════════════════════════

-- ── Incrementa access_count per batch di item ──
CREATE OR REPLACE FUNCTION increment_access_count(item_ids TEXT[])
RETURNS void AS $$
BEGIN
  UPDATE memory_items
  SET access_count = access_count + 1,
      updated_at = now()
  WHERE id = ANY(item_ids);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Promotion scan server-side ──
-- Trova tutti gli item elegibili per promozione L1→L2
CREATE OR REPLACE FUNCTION find_promotable_items(p_user_id UUID)
RETURNS TABLE (
  id TEXT,
  current_level memory_level,
  next_level memory_level,
  access_count INTEGER,
  usefulness INTEGER,
  confidence INTEGER,
  approved BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  -- L1 → L2
  SELECT
    mi.id, mi.level AS current_level,
    'L2'::memory_level AS next_level,
    mi.access_count, mi.usefulness, mi.confidence, mi.approved
  FROM memory_items mi
  WHERE mi.user_id = p_user_id
    AND mi.archived = false
    AND mi.level = 'L1'
    AND mi.access_count >= 3
    AND mi.usefulness >= 40
    AND mi.confidence >= 50
  UNION ALL
  -- L2 → L3
  SELECT
    mi.id, mi.level AS current_level,
    'L3'::memory_level AS next_level,
    mi.access_count, mi.usefulness, mi.confidence, mi.approved
  FROM memory_items mi
  WHERE mi.user_id = p_user_id
    AND mi.archived = false
    AND mi.level = 'L2'
    AND mi.access_count >= 8
    AND mi.usefulness >= 70
    AND mi.confidence >= 75
    AND mi.approved = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Applica decay server-side ──
CREATE OR REPLACE FUNCTION apply_memory_decay()
RETURNS INTEGER AS $$
DECLARE
  affected INTEGER;
BEGIN
  -- L1: decay 0.02/giorno, minimo 0.1
  UPDATE memory_items
  SET relevance_decay = GREATEST(
    0.1,
    relevance_decay - (EXTRACT(EPOCH FROM (now() - updated_at)) / 86400.0) * 0.02
  )
  WHERE level = 'L1'
    AND archived = false
    AND pinned = false
    AND relevance_decay > 0.1;

  -- L2: decay 0.005/giorno, minimo 0.1
  UPDATE memory_items
  SET relevance_decay = GREATEST(
    0.1,
    relevance_decay - (EXTRACT(EPOCH FROM (now() - updated_at)) / 86400.0) * 0.005
  )
  WHERE level = 'L2'
    AND archived = false
    AND pinned = false
    AND relevance_decay > 0.1;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Stats aggregati per dashboard ──
CREATE OR REPLACE FUNCTION get_memory_stats(p_user_id UUID)
RETURNS JSON AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'total', COUNT(*),
    'by_level', json_build_object(
      'L1', COUNT(*) FILTER (WHERE level = 'L1'),
      'L2', COUNT(*) FILTER (WHERE level = 'L2'),
      'L3', COUNT(*) FILTER (WHERE level = 'L3')
    ),
    'by_type', (
      SELECT json_object_agg(item_type, cnt)
      FROM (SELECT item_type, COUNT(*) as cnt FROM memory_items WHERE user_id = p_user_id AND NOT archived GROUP BY item_type) sub
    ),
    'avg_confidence', ROUND(AVG(confidence)),
    'avg_usefulness', ROUND(AVG(usefulness)),
    'promotions_today', (
      SELECT COUNT(*) FROM memory_promotions mp
      JOIN memory_items mi ON mi.id = mp.memory_item_id
      WHERE mi.user_id = p_user_id
        AND mp.created_at >= CURRENT_DATE
    ),
    'negative_feedback', COUNT(*) FILTER (WHERE feedback = 'negative'),
    'items_decaying', COUNT(*) FILTER (WHERE relevance_decay < 0.5 AND level != 'L3')
  ) INTO result
  FROM memory_items
  WHERE user_id = p_user_id AND NOT archived;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Cron job per decay automatico (richiede pg_cron) ──
-- Decommentare se pg_cron è disponibile su Supabase Pro
-- SELECT cron.schedule(
--   'hydra-memory-decay',
--   '0 */6 * * *',  -- ogni 6 ore
--   $$ SELECT apply_memory_decay(); $$
-- );
