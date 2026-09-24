CREATE TABLE IF NOT EXISTS roles (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL
);
INSERT INTO roles (name, description) VALUES
  ('user', 'Create and view own support requests'),
  ('support', 'View and update support requests within the organization'),
  ('admin', 'Support access plus user and role management within the organization')
ON CONFLICT (name) DO NOTHING;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
-- Upgrade the former fixed-role schema without changing existing assignments.
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_name_check;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT '{}';
UPDATE roles SET permissions = CASE name
  WHEN 'user' THEN ARRAY['requests:create', 'requests:read:own']
  WHEN 'support' THEN ARRAY['requests:create', 'requests:read:own', 'requests:read:all', 'requests:update']
  WHEN 'admin' THEN ARRAY['requests:create', 'requests:read:own', 'requests:read:all', 'requests:update',
    'users:read', 'users:roles:update', 'roles:read', 'sales:read', 'stock:read']
END WHERE name IN ('user', 'support', 'admin');

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
-- Empty grants deny entity data access, including for existing administrators.
ALTER TABLE users ADD COLUMN IF NOT EXISTS target_entities TEXT[] NOT NULL DEFAULT '{}'
  CHECK (target_entities <@ ARRAY['agritehnica', 'green', 'babyhub']::text[]
    AND array_position(target_entities, NULL) IS NULL);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
-- Keep an identity tombstone so Microsoft sign-in cannot undo deletion.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

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
