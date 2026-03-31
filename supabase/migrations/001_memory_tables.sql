-- ══════════════════════════════════════════════════════════════
-- Hydra Workbench — Database Migration: Memory System
-- Tabelle per il sistema di apprendimento AI multi-livello
-- ══════════════════════════════════════════════════════════════

-- ── Enum per livelli memoria ──
DO $$ BEGIN
  CREATE TYPE memory_level AS ENUM ('L1', 'L2', 'L3');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Enum per tipi item ──
DO $$ BEGIN
  CREATE TYPE memory_item_type AS ENUM (
    'fact', 'workflow', 'prompt', 'strategy',
    'preference', 'rule', 'schema', 'insight', 'pattern'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ══════════════════════════════════════════════════════════════
-- Tabella: memory_items
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS memory_items (
  id              TEXT PRIMARY KEY,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  level           memory_level NOT NULL DEFAULT 'L1',
  item_type       memory_item_type NOT NULL,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  source          TEXT NOT NULL,
  run_id          TEXT,
  agent_id        TEXT,
  tags            TEXT[] DEFAULT '{}',

  -- Metriche di apprendimento
  access_count    INTEGER DEFAULT 0,
  usefulness      INTEGER DEFAULT 0 CHECK (usefulness >= 0 AND usefulness <= 100),
  confidence      INTEGER DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),
  relevance_decay NUMERIC DEFAULT 1.0 CHECK (relevance_decay >= 0 AND relevance_decay <= 1.0),

  -- Stato
  approved        BOOLEAN DEFAULT false,
  pinned          BOOLEAN DEFAULT false,
  archived        BOOLEAN DEFAULT false,

  -- Promozione
  promoted_from   memory_level,
  promoted_at     TIMESTAMPTZ,

  -- Feedback loop
  feedback        TEXT CHECK (feedback IN ('positive', 'negative')),
  feedback_note   TEXT,

  -- Timestamps
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ── Indici per query frequenti ──
CREATE INDEX IF NOT EXISTS idx_memory_items_user_level ON memory_items(user_id, level);
CREATE INDEX IF NOT EXISTS idx_memory_items_user_type ON memory_items(user_id, item_type);
CREATE INDEX IF NOT EXISTS idx_memory_items_archived ON memory_items(archived) WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_memory_items_tags ON memory_items USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_memory_items_run ON memory_items(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_items_search ON memory_items USING GIN(
  to_tsvector('italian', coalesce(title, '') || ' ' || coalesce(content, ''))
);

-- ── RLS: ogni utente vede solo i propri item ──
ALTER TABLE memory_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own memory items"
  ON memory_items FOR ALL
  USING (auth.uid() = user_id);

-- ══════════════════════════════════════════════════════════════
-- Tabella: memory_promotions (audit trail)
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS memory_promotions (
  id              TEXT PRIMARY KEY,
  memory_item_id  TEXT REFERENCES memory_items(id) ON DELETE CASCADE,
  from_level      memory_level NOT NULL,
  to_level        memory_level NOT NULL,
  confidence      INTEGER DEFAULT 0,
  promoted_by_rule TEXT,
  source_run_id   TEXT,
  source_event_id TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_promotions_item ON memory_promotions(memory_item_id);
CREATE INDEX IF NOT EXISTS idx_memory_promotions_date ON memory_promotions(created_at);

ALTER TABLE memory_promotions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own promotions"
  ON memory_promotions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM memory_items
      WHERE memory_items.id = memory_promotions.memory_item_id
        AND memory_items.user_id = auth.uid()
    )
  );

-- ══════════════════════════════════════════════════════════════
-- Tabella: memory_feedback (storico feedback per analytics)
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS memory_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_item_id  TEXT REFERENCES memory_items(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  feedback        TEXT NOT NULL CHECK (feedback IN ('positive', 'negative')),
  note            TEXT,
  context         JSONB DEFAULT '{}',  -- metadata su dove/quando il feedback è stato dato
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_feedback_item ON memory_feedback(memory_item_id);

ALTER TABLE memory_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own feedback"
  ON memory_feedback FOR ALL
  USING (auth.uid() = user_id);

-- ══════════════════════════════════════════════════════════════
-- Function: auto-update updated_at
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_memory_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memory_items_updated_at
  BEFORE UPDATE ON memory_items
  FOR EACH ROW EXECUTE FUNCTION update_memory_updated_at();

-- ══════════════════════════════════════════════════════════════
-- Function: full-text search sui memory items
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION search_memory_items(
  p_user_id UUID,
  p_query TEXT,
  p_level memory_level DEFAULT NULL,
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
  id TEXT,
  level memory_level,
  item_type memory_item_type,
  title TEXT,
  content TEXT,
  confidence INTEGER,
  usefulness INTEGER,
  relevance_decay NUMERIC,
  tags TEXT[],
  rank REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    mi.id, mi.level, mi.item_type, mi.title, mi.content,
    mi.confidence, mi.usefulness, mi.relevance_decay, mi.tags,
    ts_rank(
      to_tsvector('italian', coalesce(mi.title, '') || ' ' || coalesce(mi.content, '')),
      plainto_tsquery('italian', p_query)
    ) AS rank
  FROM memory_items mi
  WHERE mi.user_id = p_user_id
    AND mi.archived = false
    AND (p_level IS NULL OR mi.level = p_level)
    AND (
      to_tsvector('italian', coalesce(mi.title, '') || ' ' || coalesce(mi.content, ''))
      @@ plainto_tsquery('italian', p_query)
      OR mi.title ILIKE '%' || p_query || '%'
      OR EXISTS (SELECT 1 FROM unnest(mi.tags) t WHERE t ILIKE '%' || p_query || '%')
    )
  ORDER BY
    -- Priorità: L3 > L2 > L1, poi per rank, poi per confidence
    CASE mi.level WHEN 'L3' THEN 3 WHEN 'L2' THEN 2 ELSE 1 END DESC,
    rank DESC,
    mi.confidence DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
