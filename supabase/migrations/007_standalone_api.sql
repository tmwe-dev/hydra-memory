-- HYDRA MEMORY Migration 007: Standalone API Support
-- Adds API key auth for external apps (FireScrape, ERNESTO, etc.)

-- ============================================================================
-- RENAME TABLES to hydra_ namespace (if not already)
-- These CREATE IF NOT EXISTS ensure standalone deployment works
-- ============================================================================

-- Core memory table (may already exist as memory_items)
CREATE TABLE IF NOT EXISTS hydra_memory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'L1' CHECK (level IN ('L1','L2','L3')),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  carrier TEXT,
  confidence NUMERIC(5,2) DEFAULT 50,
  usefulness NUMERIC(5,2) DEFAULT 50,
  relevance NUMERIC(5,4) DEFAULT 1.0,
  access_count INTEGER DEFAULT 0,
  source TEXT DEFAULT 'api',
  approved BOOLEAN DEFAULT false,
  pinned BOOLEAN DEFAULT false,
  archived BOOLEAN DEFAULT false,
  version INTEGER DEFAULT 1,
  promoted_from TEXT,
  promoted_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hydra_mem_user ON hydra_memory_items(user_id);
CREATE INDEX IF NOT EXISTS idx_hydra_mem_level ON hydra_memory_items(user_id, level, archived);
CREATE INDEX IF NOT EXISTS idx_hydra_mem_carrier ON hydra_memory_items(user_id, carrier);
CREATE INDEX IF NOT EXISTS idx_hydra_mem_retrieval ON hydra_memory_items(user_id, archived, confidence DESC);

-- Knowledge rules
CREATE TABLE IF NOT EXISTS hydra_knowledge_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  carrier_code TEXT,
  operation_type TEXT DEFAULT 'general',
  rule_type TEXT DEFAULT 'instruction',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  priority INTEGER DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  tags TEXT[] DEFAULT '{}',
  source TEXT DEFAULT 'user',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hydra_rules_user ON hydra_knowledge_rules(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_hydra_rules_carrier ON hydra_knowledge_rules(user_id, carrier_code);

-- Promotions log
CREATE TABLE IF NOT EXISTS hydra_memory_promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES hydra_memory_items(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  from_level TEXT NOT NULL,
  to_level TEXT NOT NULL,
  reason TEXT,
  snapshot JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Feedback
CREATE TABLE IF NOT EXISTS hydra_memory_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES hydra_memory_items(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  feedback_type TEXT NOT NULL CHECK (feedback_type IN ('positive','negative')),
  context TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- API KEYS TABLE (for external apps like FireScrape)
-- ============================================================================
CREATE TABLE IF NOT EXISTS hydra_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  app_name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,  -- First 8 chars for display (e.g., "hk_a3f2...")
  permissions TEXT[] DEFAULT '{memory.read,memory.write,kb.read,kb.write}',
  is_active BOOLEAN DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hydra_api_keys_hash ON hydra_api_keys(api_key_hash);
CREATE INDEX IF NOT EXISTS idx_hydra_api_keys_user ON hydra_api_keys(user_id);

-- ============================================================================
-- RLS POLICIES
-- ============================================================================
ALTER TABLE hydra_memory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE hydra_knowledge_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE hydra_memory_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hydra_memory_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE hydra_api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their memory" ON hydra_memory_items
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users own their rules" ON hydra_knowledge_rules
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users own their promotions" ON hydra_memory_promotions
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users own their feedback" ON hydra_memory_feedback
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users own their api keys" ON hydra_api_keys
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Increment access count
CREATE OR REPLACE FUNCTION hydra_increment_access(p_item_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE hydra_memory_items
  SET access_count = access_count + 1,
      last_accessed_at = now(),
      updated_at = now()
  WHERE id = p_item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Adjust confidence (for feedback)
CREATE OR REPLACE FUNCTION hydra_adjust_confidence(p_item_id UUID, p_delta NUMERIC)
RETURNS void AS $$
BEGIN
  UPDATE hydra_memory_items
  SET confidence = GREATEST(0, LEAST(100, confidence + p_delta)),
      updated_at = now()
  WHERE id = p_item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Memory stats
CREATE OR REPLACE FUNCTION hydra_memory_stats(p_user_id UUID)
RETURNS TABLE (
  total_items BIGINT,
  l1_count BIGINT,
  l2_count BIGINT,
  l3_count BIGINT,
  avg_confidence NUMERIC,
  rules_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT,
    COUNT(*) FILTER (WHERE level = 'L1')::BIGINT,
    COUNT(*) FILTER (WHERE level = 'L2')::BIGINT,
    COUNT(*) FILTER (WHERE level = 'L3')::BIGINT,
    COALESCE(AVG(confidence), 0)::NUMERIC,
    (SELECT COUNT(*) FROM hydra_knowledge_rules WHERE user_id = p_user_id AND is_active = true)::BIGINT
  FROM hydra_memory_items
  WHERE user_id = p_user_id AND archived = false;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Apply decay
CREATE OR REPLACE FUNCTION hydra_apply_decay(p_user_id UUID)
RETURNS TABLE (item_id UUID, old_conf NUMERIC, new_conf NUMERIC) AS $$
BEGIN
  RETURN QUERY
  WITH decayed AS (
    SELECT
      i.id,
      i.confidence as old_confidence,
      GREATEST(0, i.confidence - (
        EXTRACT(DAY FROM now() - i.last_accessed_at) *
        CASE WHEN i.level = 'L1' THEN 2 WHEN i.level = 'L2' THEN 0.5 ELSE 0 END
      )) as new_confidence
    FROM hydra_memory_items i
    WHERE i.user_id = p_user_id
      AND i.archived = false
      AND i.level IN ('L1', 'L2')
      AND (now() - i.last_accessed_at) > interval '1 day'
  )
  UPDATE hydra_memory_items m
  SET confidence = d.new_confidence, updated_at = now()
  FROM decayed d
  WHERE m.id = d.id AND d.new_confidence != d.old_confidence
  RETURNING m.id, d.old_confidence, d.new_confidence;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION hydra_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hydra_mem_updated BEFORE UPDATE ON hydra_memory_items
  FOR EACH ROW EXECUTE FUNCTION hydra_update_timestamp();
CREATE TRIGGER hydra_rules_updated BEFORE UPDATE ON hydra_knowledge_rules
  FOR EACH ROW EXECUTE FUNCTION hydra_update_timestamp();
