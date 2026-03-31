-- ══════════════════════════════════════════════════════════════
-- Hydra Workbench — Migration 005: KPI Snapshots + Audit Trail
-- ══════════════════════════════════════════════════════════════

-- ── KPI Snapshots ──
CREATE TABLE IF NOT EXISTS memory_kpi_snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  data        JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),

  UNIQUE(user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_kpi_snapshots_user_date
  ON memory_kpi_snapshots(user_id, date DESC);

ALTER TABLE memory_kpi_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own KPI snapshots"
  ON memory_kpi_snapshots FOR ALL
  USING (auth.uid() = user_id);

-- ── Audit Trail ──
CREATE TABLE IF NOT EXISTS memory_audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id    TEXT,
  action          TEXT NOT NULL CHECK (action IN (
    'create', 'update', 'delete', 'approve', 'promote',
    'archive', 'export', 'import', 'feedback', 'conflict_resolve',
    'seed_apply', 'encryption', 'rollback'
  )),
  target_id       TEXT NOT NULL,
  target_type     TEXT NOT NULL CHECK (target_type IN (
    'memory_item', 'seed_pack', 'conflict', 'kpi_snapshot', 'workspace'
  )),
  details         JSONB DEFAULT '{}',
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_user_date
  ON memory_audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action
  ON memory_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_target
  ON memory_audit_log(target_id);

ALTER TABLE memory_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own audit log"
  ON memory_audit_log FOR SELECT
  USING (auth.uid() = user_id);

-- Solo il sistema può inserire nel log
CREATE POLICY "System inserts audit log"
  ON memory_audit_log FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ── Workspace Members (Multi-Tenancy) ──
CREATE TABLE IF NOT EXISTS memory_workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  owner_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  settings    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_workspace_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    TEXT REFERENCES memory_workspaces(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  joined_at       TIMESTAMPTZ DEFAULT now(),

  UNIQUE(workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_user
  ON memory_workspace_members(user_id);

ALTER TABLE memory_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_workspace_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can see workspace"
  ON memory_workspaces FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memory_workspace_members
      WHERE memory_workspace_members.workspace_id = memory_workspaces.id
        AND memory_workspace_members.user_id = auth.uid()
    )
  );

CREATE POLICY "Members see their membership"
  ON memory_workspace_members FOR SELECT
  USING (auth.uid() = user_id);

-- Aggiungi workspace_id a memory_items per multi-tenancy
ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES memory_workspaces(id);

CREATE INDEX IF NOT EXISTS idx_memory_items_workspace
  ON memory_items(workspace_id) WHERE workspace_id IS NOT NULL;
