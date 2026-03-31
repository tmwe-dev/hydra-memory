-- ══════════════════════════════════════════════════════════════
-- Hydra Workbench — Migration 004: L3 Versioning
-- Storia delle modifiche per item di conoscenza permanente
-- ══════════════════════════════════════════════════════════════

-- ── Tabella versioni L3 ──
CREATE TABLE IF NOT EXISTS memory_item_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_item_id  TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  confidence      INTEGER,
  usefulness      INTEGER,
  tags            TEXT[] DEFAULT '{}',
  change_reason   TEXT,            -- perché è cambiato
  changed_by      TEXT DEFAULT 'system',  -- 'user', 'system', 'ai', 'promotion'
  snapshot        JSONB,           -- snapshot completo dell'item al momento della versione
  created_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE(memory_item_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_memory_versions_item
  ON memory_item_versions(memory_item_id, version_number DESC);

-- RLS
ALTER TABLE memory_item_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own item versions"
  ON memory_item_versions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM memory_items
      WHERE memory_items.id = memory_item_versions.memory_item_id
        AND memory_items.user_id = auth.uid()
    )
  );

-- ══════════════════════════════════════════════════════════════
-- Trigger: auto-version su update di item L3
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
    -- Calcola prossimo numero versione
    SELECT COALESCE(MAX(version_number), 0) + 1
    INTO v_version_number
    FROM memory_item_versions
    WHERE memory_item_id = NEW.id;

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

DROP TRIGGER IF EXISTS trg_auto_version_l3 ON memory_items;
CREATE TRIGGER trg_auto_version_l3
  AFTER UPDATE ON memory_items
  FOR EACH ROW EXECUTE FUNCTION auto_version_l3_items();

-- ══════════════════════════════════════════════════════════════
-- Function: Recupera storia versioni di un item
-- ══════════════════════════════════════════════════════════════

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
  WHERE mv.memory_item_id = p_item_id
  ORDER BY mv.version_number DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ══════════════════════════════════════════════════════════════
-- Function: Rollback a una versione precedente
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION rollback_item_to_version(
  p_item_id TEXT,
  p_version_number INTEGER
)
RETURNS BOOLEAN AS $$
DECLARE
  v_record memory_item_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_record
  FROM memory_item_versions
  WHERE memory_item_id = p_item_id AND version_number = p_version_number;

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
  WHERE id = p_item_id AND level = 'L3';

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
