-- ══════════════════════════════════════════════════════════════
-- Hydra Workbench — Migration 003: Vector Embeddings (pgvector)
-- Ricerca semantica scalabile con embeddings vettoriali
-- ══════════════════════════════════════════════════════════════

-- Abilita pgvector (disponibile su Supabase)
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Colonna embedding sulla tabella memory_items ──
ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS embedding vector(384);
  -- 384 dimensioni = gte-small / all-MiniLM-L6-v2 (leggero e veloce)

-- ── Indice HNSW per ricerca approssimata veloce ──
-- cosine distance, ottimale per text embeddings normalizzati
CREATE INDEX IF NOT EXISTS idx_memory_items_embedding
  ON memory_items
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ══════════════════════════════════════════════════════════════
-- Function: Ricerca vettoriale con filtri
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION search_memory_by_embedding(
  p_user_id UUID,
  p_embedding vector(384),
  p_level memory_level DEFAULT NULL,
  p_types memory_item_type[] DEFAULT NULL,
  p_min_confidence INTEGER DEFAULT 0,
  p_limit INTEGER DEFAULT 10,
  p_similarity_threshold FLOAT DEFAULT 0.3
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
  pinned BOOLEAN,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    mi.id, mi.level, mi.item_type, mi.title, mi.content,
    mi.confidence, mi.usefulness, mi.relevance_decay, mi.tags, mi.pinned,
    1 - (mi.embedding <=> p_embedding) AS similarity
  FROM memory_items mi
  WHERE mi.user_id = p_user_id
    AND mi.archived = false
    AND mi.embedding IS NOT NULL
    AND (p_level IS NULL OR mi.level = p_level)
    AND (p_types IS NULL OR mi.item_type = ANY(p_types))
    AND mi.confidence >= p_min_confidence
    AND 1 - (mi.embedding <=> p_embedding) >= p_similarity_threshold
  ORDER BY
    -- Scoring combinato: similarità vettoriale × relevance_decay × level_boost
    (1 - (mi.embedding <=> p_embedding))
    * mi.relevance_decay
    * CASE mi.level WHEN 'L3' THEN 1.3 WHEN 'L2' THEN 1.1 ELSE 1.0 END
    * CASE WHEN mi.pinned THEN 1.5 ELSE 1.0 END
    DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ══════════════════════════════════════════════════════════════
-- Function: Hybrid search (vector + full-text combinati)
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION hybrid_memory_search(
  p_user_id UUID,
  p_query TEXT,
  p_embedding vector(384),
  p_level memory_level DEFAULT NULL,
  p_limit INTEGER DEFAULT 10,
  p_vector_weight FLOAT DEFAULT 0.7,  -- peso ricerca vettoriale
  p_text_weight FLOAT DEFAULT 0.3     -- peso ricerca testuale
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
  pinned BOOLEAN,
  vector_score FLOAT,
  text_score FLOAT,
  combined_score FLOAT
) AS $$
BEGIN
  RETURN QUERY
  WITH vector_results AS (
    SELECT
      mi.id,
      1 - (mi.embedding <=> p_embedding) AS vscore
    FROM memory_items mi
    WHERE mi.user_id = p_user_id
      AND mi.archived = false
      AND mi.embedding IS NOT NULL
      AND (p_level IS NULL OR mi.level = p_level)
    ORDER BY mi.embedding <=> p_embedding
    LIMIT p_limit * 3  -- over-fetch per poi combinare
  ),
  text_results AS (
    SELECT
      mi.id,
      ts_rank(
        to_tsvector('italian', coalesce(mi.title, '') || ' ' || coalesce(mi.content, '')),
        plainto_tsquery('italian', p_query)
      ) AS tscore
    FROM memory_items mi
    WHERE mi.user_id = p_user_id
      AND mi.archived = false
      AND (p_level IS NULL OR mi.level = p_level)
      AND (
        to_tsvector('italian', coalesce(mi.title, '') || ' ' || coalesce(mi.content, ''))
        @@ plainto_tsquery('italian', p_query)
        OR mi.title ILIKE '%' || p_query || '%'
      )
    LIMIT p_limit * 3
  ),
  combined AS (
    SELECT
      COALESCE(vr.id, tr.id) AS item_id,
      COALESCE(vr.vscore, 0) AS vscore,
      COALESCE(tr.tscore, 0) AS tscore,
      (COALESCE(vr.vscore, 0) * p_vector_weight + COALESCE(tr.tscore, 0) * p_text_weight) AS cscore
    FROM vector_results vr
    FULL OUTER JOIN text_results tr ON vr.id = tr.id
  )
  SELECT
    mi.id, mi.level, mi.item_type, mi.title, mi.content,
    mi.confidence, mi.usefulness, mi.relevance_decay, mi.tags, mi.pinned,
    c.vscore AS vector_score,
    c.tscore AS text_score,
    c.cscore
      * mi.relevance_decay
      * CASE mi.level WHEN 'L3' THEN 1.3 WHEN 'L2' THEN 1.1 ELSE 1.0 END
      * CASE WHEN mi.pinned THEN 1.5 ELSE 1.0 END
    AS combined_score
  FROM combined c
  JOIN memory_items mi ON mi.id = c.item_id
  ORDER BY combined_score DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ══════════════════════════════════════════════════════════════
-- Function: Trova item simili (per deduplicazione / conflitti)
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION find_similar_items(
  p_item_id TEXT,
  p_threshold FLOAT DEFAULT 0.85,
  p_limit INTEGER DEFAULT 5
)
RETURNS TABLE (
  id TEXT,
  title TEXT,
  level memory_level,
  similarity FLOAT
) AS $$
DECLARE
  v_embedding vector(384);
  v_user_id UUID;
BEGIN
  SELECT embedding, user_id INTO v_embedding, v_user_id
  FROM memory_items WHERE memory_items.id = p_item_id;

  IF v_embedding IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    mi.id, mi.title, mi.level,
    1 - (mi.embedding <=> v_embedding) AS similarity
  FROM memory_items mi
  WHERE mi.user_id = v_user_id
    AND mi.id != p_item_id
    AND mi.archived = false
    AND mi.embedding IS NOT NULL
    AND 1 - (mi.embedding <=> v_embedding) >= p_threshold
  ORDER BY mi.embedding <=> v_embedding
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
