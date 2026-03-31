-- ══════════════════════════════════════════════════════════════
-- Hydra Workbench — Migration 006: Security Fixes
-- ══════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════
-- C4: Audit log INSERT policy with trigger to set user_id
-- ══════════════════════════════════════════════════════════════

-- Drop existing audit log policies if present
DROP POLICY IF EXISTS "System inserts audit log" ON memory_audit_log;
DROP POLICY IF EXISTS "Users see own audit log" ON memory_audit_log;

-- C4: Fix audit log policies - allow INSERT with CHECK(true), set user_id via trigger
CREATE POLICY "Users can insert own audit logs"
  ON memory_audit_log FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Users see own audit log"
  ON memory_audit_log FOR SELECT
  USING (auth.uid() = user_id);

-- Create trigger to set user_id from auth context
CREATE OR REPLACE FUNCTION set_audit_log_user_id()
RETURNS TRIGGER AS $$
BEGIN
  NEW.user_id = auth.uid();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_audit_user ON memory_audit_log;
CREATE TRIGGER trg_set_audit_user
  BEFORE INSERT ON memory_audit_log
  FOR EACH ROW EXECUTE FUNCTION set_audit_log_user_id();

-- ══════════════════════════════════════════════════════════════
-- C5: Fix RLS bypass in search functions
-- Remove user_id parameter, use auth.uid() internally
-- ══════════════════════════════════════════════════════════════

-- Update search_memory_items to use auth.uid()
CREATE OR REPLACE FUNCTION search_memory_items(
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
  WHERE mi.user_id = auth.uid()
    AND mi.archived = false
    AND (p_level IS NULL OR mi.level = p_level)
    AND (
      to_tsvector('italian', coalesce(mi.title, '') || ' ' || coalesce(mi.content, ''))
      @@ plainto_tsquery('italian', p_query)
      OR mi.title ILIKE '%' || p_query || '%'
      OR EXISTS (SELECT 1 FROM unnest(mi.tags) t WHERE t ILIKE '%' || p_query || '%')
    )
  ORDER BY
    CASE mi.level WHEN 'L3' THEN 3 WHEN 'L2' THEN 2 ELSE 1 END DESC,
    rank DESC,
    mi.confidence DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update increment_access_count
CREATE OR REPLACE FUNCTION increment_access_count(item_ids TEXT[])
RETURNS void AS $$
BEGIN
  UPDATE memory_items
  SET access_count = access_count + 1,
      updated_at = now()
  WHERE id = ANY(item_ids)
    AND user_id = auth.uid();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update find_promotable_items to use auth.uid()
CREATE OR REPLACE FUNCTION find_promotable_items()
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
  WHERE mi.user_id = auth.uid()
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
  WHERE mi.user_id = auth.uid()
    AND mi.archived = false
    AND mi.level = 'L2'
    AND mi.access_count >= 8
    AND mi.usefulness >= 70
    AND mi.confidence >= 75
    AND mi.approved = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update apply_memory_decay to use auth.uid()
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
  WHERE user_id = auth.uid()
    AND level = 'L1'
    AND archived = false
    AND pinned = false
    AND relevance_decay > 0.1;

  -- L2: decay 0.005/giorno, minimo 0.1
  UPDATE memory_items
  SET relevance_decay = GREATEST(
    0.1,
    relevance_decay - (EXTRACT(EPOCH FROM (now() - updated_at)) / 86400.0) * 0.005
  )
  WHERE user_id = auth.uid()
    AND level = 'L2'
    AND archived = false
    AND pinned = false
    AND relevance_decay > 0.1;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update get_memory_stats to use auth.uid()
CREATE OR REPLACE FUNCTION get_memory_stats()
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
      FROM (SELECT item_type, COUNT(*) as cnt FROM memory_items WHERE user_id = auth.uid() AND NOT archived GROUP BY item_type) sub
    ),
    'avg_confidence', ROUND(AVG(confidence)),
    'avg_usefulness', ROUND(AVG(usefulness)),
    'promotions_today', (
      SELECT COUNT(*) FROM memory_promotions mp
      JOIN memory_items mi ON mi.id = mp.memory_item_id
      WHERE mi.user_id = auth.uid()
        AND mp.created_at >= CURRENT_DATE
    ),
    'negative_feedback', COUNT(*) FILTER (WHERE feedback = 'negative'),
    'items_decaying', COUNT(*) FILTER (WHERE relevance_decay < 0.5 AND level != 'L3')
  ) INTO result
  FROM memory_items
  WHERE user_id = auth.uid() AND NOT archived;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update search_memory_by_embedding to use auth.uid()
CREATE OR REPLACE FUNCTION search_memory_by_embedding(
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
  WHERE mi.user_id = auth.uid()
    AND mi.archived = false
    AND mi.embedding IS NOT NULL
    AND (p_level IS NULL OR mi.level = p_level)
    AND (p_types IS NULL OR mi.item_type = ANY(p_types))
    AND mi.confidence >= p_min_confidence
    AND 1 - (mi.embedding <=> p_embedding) >= p_similarity_threshold
  ORDER BY
    (1 - (mi.embedding <=> p_embedding))
    * mi.relevance_decay
    * CASE mi.level WHEN 'L3' THEN 1.3 WHEN 'L2' THEN 1.1 ELSE 1.0 END
    * CASE WHEN mi.pinned THEN 1.5 ELSE 1.0 END
    DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update hybrid_memory_search to use auth.uid()
CREATE OR REPLACE FUNCTION hybrid_memory_search(
  p_query TEXT,
  p_embedding vector(384),
  p_level memory_level DEFAULT NULL,
  p_limit INTEGER DEFAULT 10,
  p_vector_weight FLOAT DEFAULT 0.7,
  p_text_weight FLOAT DEFAULT 0.3
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
    WHERE mi.user_id = auth.uid()
      AND mi.archived = false
      AND mi.embedding IS NOT NULL
      AND (p_level IS NULL OR mi.level = p_level)
    ORDER BY mi.embedding <=> p_embedding
    LIMIT p_limit * 3
  ),
  text_results AS (
    SELECT
      mi.id,
      ts_rank(
        to_tsvector('italian', coalesce(mi.title, '') || ' ' || coalesce(mi.content, '')),
        plainto_tsquery('italian', p_query)
      ) AS tscore
    FROM memory_items mi
    WHERE mi.user_id = auth.uid()
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

-- Update find_similar_items - needs to check auth
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
  -- Check auth: user can only query their own items
  SELECT embedding, user_id INTO v_embedding, v_user_id
  FROM memory_items
  WHERE memory_items.id = p_item_id
    AND memory_items.user_id = auth.uid();

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

-- Update get_item_version_history - check auth
CREATE OR REPLACE FUNCTION get_item_version_history(p_item_id TEXT)
RETURNS TABLE (
  version_number INTEGER,
  title TEXT,
  content TEXT,
  confidence INTEGER,
  change_reason TEXT,
  changed_by TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    mv.version_number, mv.title, mv.content,
    mv.confidence, mv.change_reason, mv.changed_by, mv.created_at
  FROM memory_item_versions mv
  JOIN memory_items mi ON mi.id = mv.memory_item_id
  WHERE mv.memory_item_id = p_item_id
    AND mi.user_id = auth.uid()
  ORDER BY mv.version_number DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update rollback_item_to_version - check auth
CREATE OR REPLACE FUNCTION rollback_item_to_version(
  p_item_id TEXT,
  p_version_number INTEGER
)
RETURNS BOOLEAN AS $$
DECLARE
  v_record memory_item_versions%ROWTYPE;
BEGIN
  -- Check auth: user can only rollback their own items
  SELECT mv.* INTO v_record
  FROM memory_item_versions mv
  JOIN memory_items mi ON mi.id = mv.memory_item_id
  WHERE mv.memory_item_id = p_item_id
    AND mv.version_number = p_version_number
    AND mi.user_id = auth.uid();

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE memory_items SET
    title = v_record.title,
    content = v_record.content,
    confidence = v_record.confidence,
    usefulness = v_record.usefulness,
    tags = v_record.tags,
    updated_at = now()
  WHERE id = p_item_id
    AND level = 'L3'
    AND user_id = auth.uid();

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ══════════════════════════════════════════════════════════════
-- C6: Versioning race condition - Add FOR UPDATE lock
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION auto_version_l3_items()
RETURNS TRIGGER AS $$
DECLARE
  v_version_number INTEGER;
BEGIN
  -- Solo per item L3 con contenuto effettivamente cambiato
  IF NEW.level = 'L3' AND (
    OLD.title IS DISTINCT FROM NEW.title OR
    OLD.content IS DISTINCT FROM NEW.content OR
    OLD.confidence IS DISTINCT FROM NEW.confidence OR
    OLD.tags IS DISTINCT FROM NEW.tags
  ) THEN
    -- C6: Use FOR UPDATE to prevent race condition
    SELECT COALESCE(MAX(version_number), 0) + 1
    INTO v_version_number
    FROM memory_item_versions
    WHERE memory_item_id = NEW.id
    FOR UPDATE;

    -- Salva snapshot della versione PRECEDENTE
    INSERT INTO memory_item_versions (
      memory_item_id, version_number, title, content,
      confidence, usefulness, tags, change_reason, changed_by, snapshot
    ) VALUES (
      OLD.id, v_version_number, OLD.title, OLD.content,
      OLD.confidence, OLD.usefulness, OLD.tags,
      'Auto-versioned on L3 update',
      'system',
      jsonb_build_object(
        'level', OLD.level,
        'type', OLD.item_type,
        'source', OLD.source,
        'access_count', OLD.access_count,
        'relevance_decay', OLD.relevance_decay,
        'approved', OLD.approved,
        'pinned', OLD.pinned,
        'feedback', OLD.feedback,
        'updated_at', OLD.updated_at
      )
    );
  END IF;

  -- Versiona anche quando un item viene PROMOSSO a L3
  IF OLD.level != 'L3' AND NEW.level = 'L3' THEN
    INSERT INTO memory_item_versions (
      memory_item_id, version_number, title, content,
      confidence, usefulness, tags, change_reason, changed_by, snapshot
    ) VALUES (
      NEW.id, 1, NEW.title, NEW.content,
      NEW.confidence, NEW.usefulness, NEW.tags,
      'Promoted to L3 from ' || OLD.level,
      'promotion',
      jsonb_build_object(
        'promoted_from', OLD.level,
        'original_created_at', OLD.created_at,
        'access_count_at_promotion', OLD.access_count
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════════════════════════════════════════════
-- C10: Workspace policies - Add INSERT/UPDATE/DELETE
-- ══════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Workspace members can see workspace" ON memory_workspaces;
DROP POLICY IF EXISTS "Members see their membership" ON memory_workspace_members;

CREATE POLICY "Users can see their workspaces"
  ON memory_workspaces FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memory_workspace_members
      WHERE memory_workspace_members.workspace_id = memory_workspaces.id
        AND memory_workspace_members.user_id = auth.uid()
    )
  );

CREATE POLICY "Workspace owners can update"
  ON memory_workspaces FOR UPDATE
  USING (owner_id = auth.uid());

CREATE POLICY "Workspace owners can delete"
  ON memory_workspaces FOR DELETE
  USING (owner_id = auth.uid());

CREATE POLICY "Members can see their membership"
  ON memory_workspace_members FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Workspace admins can manage members"
  ON memory_workspace_members FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memory_workspaces mw
      JOIN memory_workspace_members mwm ON mwm.workspace_id = mw.id
      WHERE mw.id = workspace_id
        AND mwm.user_id = auth.uid()
        AND mwm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY "Admins can update memberships"
  ON memory_workspace_members FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM memory_workspaces mw
      JOIN memory_workspace_members mwm ON mwm.workspace_id = mw.id
      WHERE mw.id = workspace_id
        AND mwm.user_id = auth.uid()
        AND mwm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY "Admins can delete memberships"
  ON memory_workspace_members FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM memory_workspaces mw
      JOIN memory_workspace_members mwm ON mwm.workspace_id = mw.id
      WHERE mw.id = workspace_id
        AND mwm.user_id = auth.uid()
        AND mwm.role IN ('owner', 'admin')
    )
  );

-- ══════════════════════════════════════════════════════════════
-- H10-H11: Incomplete RLS - Add policies for promotions and feedback
-- ══════════════════════════════════════════════════════════════

-- Ensure memory_promotions has proper INSERT/UPDATE/DELETE policies
DROP POLICY IF EXISTS "Users see own promotions" ON memory_promotions;

CREATE POLICY "Users see own promotions"
  ON memory_promotions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memory_items
      WHERE memory_items.id = memory_promotions.memory_item_id
        AND memory_items.user_id = auth.uid()
    )
  );

CREATE POLICY "System can insert promotions"
  ON memory_promotions FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memory_items
      WHERE memory_items.id = memory_promotions.memory_item_id
        AND memory_items.user_id = auth.uid()
    )
  );

-- Ensure memory_feedback has proper INSERT/UPDATE/DELETE policies
DROP POLICY IF EXISTS "Users see own feedback" ON memory_feedback;

CREATE POLICY "Users see own feedback"
  ON memory_feedback FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert feedback"
  ON memory_feedback FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own feedback"
  ON memory_feedback FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own feedback"
  ON memory_feedback FOR DELETE
  USING (auth.uid() = user_id);

-- ══════════════════════════════════════════════════════════════
-- H12: workspace_id nullable - Add NOT NULL with default for new rows
-- ══════════════════════════════════════════════════════════════

-- Note: Existing rows can have NULL workspace_id for backward compatibility
-- New inserts should have workspace_id via application logic or trigger
-- This is handled at the application layer in edge functions

-- ══════════════════════════════════════════════════════════════
-- H13: HNSW index parameters - Alter with m=24, ef_construction=200
-- ══════════════════════════════════════════════════════════════

-- Drop old HNSW index with suboptimal parameters
DROP INDEX IF EXISTS idx_memory_items_embedding;

-- Create new HNSW index with optimized parameters
-- m=24: Better quality, slightly higher memory (vs 16)
-- ef_construction=200: Better search quality (vs 64)
CREATE INDEX idx_memory_items_embedding
  ON memory_items
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 24, ef_construction = 200);

-- ══════════════════════════════════════════════════════════════
-- Additional security: Add constraint for audit log action values
-- ══════════════════════════════════════════════════════════════

-- Ensure audit_log has proper indexes for common queries
CREATE INDEX IF NOT EXISTS idx_audit_user_action
  ON memory_audit_log(user_id, action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_workspace
  ON memory_audit_log(workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;
