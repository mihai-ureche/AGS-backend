CREATE TABLE IF NOT EXISTS support_requests (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  owner_id UUID NOT NULL,
  owner_name TEXT,
  owner_email TEXT,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 10000),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS support_requests_owner_idx
  ON support_requests (tenant_id, owner_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_requests_tenant_idx
  ON support_requests (tenant_id, created_at DESC, id DESC);
