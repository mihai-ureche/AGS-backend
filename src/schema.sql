CREATE TABLE IF NOT EXISTS roles (
  name TEXT PRIMARY KEY CHECK (name IN ('user', 'support', 'admin')),
  description TEXT NOT NULL
);
INSERT INTO roles (name, description) VALUES
  ('user', 'Create and view own support requests'),
  ('support', 'View and update support requests within the organization'),
  ('admin', 'Support access plus user and role management within the organization')
ON CONFLICT (name) DO NOTHING;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  microsoft_user_id UUID NOT NULL,
  display_name TEXT,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, microsoft_user_id)
);
-- Access goes through the authenticated backend, not the Supabase public Data API.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- Also upgrades installations whose users table predates database roles.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user' REFERENCES roles(name);

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
