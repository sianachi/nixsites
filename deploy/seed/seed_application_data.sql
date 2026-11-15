-- Development application data: two tenants and everything they need to be useful.
--
-- Runs AFTER the migrator has applied the schema, which is why this is its own
-- file rather than another section of seed_database.sql - that one configures
-- the database itself and runs before any table exists.
--
--   dotnet run --project backend/src/Nix.Migrator   # schema first
--   deploy/seed/seed.sh                             # then this
--
-- Idempotent: every insert is ON CONFLICT DO NOTHING, so re-running changes
-- nothing and never fails on an existing volume.
--
-- Two tenants, not one. Every isolation test and every manual check of "can
-- Acme see Umbrella's folder" needs a second tenant to be a real question, and
-- a development database with one tenant quietly makes cross-tenant bugs
-- invisible until staging.

\set ON_ERROR_STOP on

DO $$
BEGIN
    IF to_regclass('public.tenant') IS NULL THEN
        RAISE EXCEPTION
            'the application schema is not present; run the migrator first: dotnet run --project backend/src/Nix.Migrator';
    END IF;
END
$$;

-- ── Tenants ────────────────────────────────────────────────────────────────
INSERT INTO tenant (tenant_id, name, isolation_mode, created_at) VALUES
    ('a0000000-0000-4000-8000-000000000001', 'Acme',     'shared', now()),
    ('b0000000-0000-4000-8000-000000000002', 'Umbrella', 'shared', now())
ON CONFLICT (tenant_id) DO NOTHING;

-- ── Workspaces ─────────────────────────────────────────────────────────────
INSERT INTO workspace
    (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
     storage_quota_bytes, created_at)
VALUES
    ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
     'Acme Engineering', 90, 10, 10737418240, now()),
    ('a1000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
     'Acme Operations',  90, 10, 10737418240, now()),
    ('b1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
     'Umbrella Research', 30, 5, 1073741824, now())
ON CONFLICT (workspace_id) DO NOTHING;

-- ── Principals ─────────────────────────────────────────────────────────────
-- external_subject only matters to an OIDC install; local sign-in resolves people by account.
INSERT INTO principal
    (principal_id, tenant_id, external_subject, kind, display_name, email, status, deprovisioned_at)
VALUES
    ('a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
     'acme-admin',  'user', 'Ada Admin',   'dev@nix.localhost',   'active', NULL),
    ('a2000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
     'acme-editor', 'user', 'Eli Editor',  'eli@acme.test',       'active', NULL),

    -- A deprovisioned principal, seeded on purpose: the fail-closed path is the
    -- one nobody exercises by hand, and it needs a subject to exercise it with.
    ('a2000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
     'acme-former', 'user', 'Otto Former', 'otto@acme.test',      'deprovisioned', now()),

    ('b2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
     'umbrella-admin', 'user', 'Uma Admin', 'uma@umbrella.test',  'active', NULL)
ON CONFLICT (principal_id) DO NOTHING;

-- ── Groups ─────────────────────────────────────────────────────────────────
INSERT INTO principal_group (group_id, tenant_id, name, external_id) VALUES
    ('a3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
     'Acme Engineers', 'acme-engineers'),
    ('b3000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
     'Umbrella Researchers', 'umbrella-researchers')
ON CONFLICT (group_id) DO NOTHING;

INSERT INTO group_membership (group_id, principal_id, tenant_id, source) VALUES
    ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002',
     'a0000000-0000-4000-8000-000000000001', 'directory'),
    ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001',
     'b0000000-0000-4000-8000-000000000002', 'directory')
ON CONFLICT (group_id, principal_id) DO NOTHING;

-- ── Role grants ────────────────────────────────────────────────────────────
-- The role vocabulary is defined by Nix.Core.Authorization.WorkspaceRole:
-- owner, editor, commenter, viewer, ordered by capability. Text outside that
-- set parses to nothing and grants nothing, so a typo here is a lockout rather
-- than an escalation. 'admin' on tenant_role is the tenant-wide role and is
-- separate from the workspace vocabulary.
INSERT INTO tenant_role (tenant_id, subject_type, subject_id, role, granted_by, granted_at) VALUES
    ('a0000000-0000-4000-8000-000000000001', 'principal',
     'a2000000-0000-4000-8000-000000000001', 'admin',
     'a2000000-0000-4000-8000-000000000001', now()),
    ('b0000000-0000-4000-8000-000000000002', 'principal',
     'b2000000-0000-4000-8000-000000000001', 'admin',
     'b2000000-0000-4000-8000-000000000001', now())
ON CONFLICT (tenant_id, subject_type, subject_id) DO NOTHING;

INSERT INTO workspace_member
    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
VALUES
    ('a1000000-0000-4000-8000-000000000001', 'principal',
     'a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
     'owner',  'a2000000-0000-4000-8000-000000000001', now()),
    ('a1000000-0000-4000-8000-000000000001', 'group',
     'a3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
     'editor', 'a2000000-0000-4000-8000-000000000001', now()),
    ('b1000000-0000-4000-8000-000000000001', 'principal',
     'b2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
     'owner',  'b2000000-0000-4000-8000-000000000001', now())
ON CONFLICT (workspace_id, subject_type, subject_id) DO NOTHING;

-- The seeded administrator is the protected owner. A partial or hand-edited seed is repaired
-- before personal ownership is stamped below; an already-correct row is left untouched.
INSERT INTO workspace_member
    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
SELECT
    'a1000000-0000-4000-8000-000000000001'::uuid,
    'principal',
    'a2000000-0000-4000-8000-000000000001'::uuid,
    'a0000000-0000-4000-8000-000000000001'::uuid,
    'owner',
    'a2000000-0000-4000-8000-000000000001'::uuid,
    now()
WHERE EXISTS (
    SELECT 1 FROM workspace
     WHERE workspace_id = 'a1000000-0000-4000-8000-000000000001'::uuid
       AND tenant_id = 'a0000000-0000-4000-8000-000000000001'::uuid)
  AND EXISTS (
    SELECT 1 FROM principal
     WHERE principal_id = 'a2000000-0000-4000-8000-000000000001'::uuid
       AND tenant_id = 'a0000000-0000-4000-8000-000000000001'::uuid)
ON CONFLICT (workspace_id, subject_type, subject_id) DO UPDATE
SET role = 'owner',
    granted_by = EXCLUDED.granted_by,
    granted_at = EXCLUDED.granted_at
WHERE workspace_member.role <> 'owner';

-- The populated administrator workspace is the administrator's personal workspace. This runs
-- after both the principal and protected owner membership exist, satisfying both FKs.
UPDATE workspace
SET personal_owner_principal_id = 'a2000000-0000-4000-8000-000000000001'::uuid
WHERE workspace_id = 'a1000000-0000-4000-8000-000000000001'::uuid
  AND tenant_id = 'a0000000-0000-4000-8000-000000000001'::uuid;

-- ── Development sign-in ────────────────────────────────────────────────────
-- Core runs in local mode in development, so people sign in with an account. The administrator is
-- dev@nix.localhost; the password below is public and for development only, which is why this lives in
-- the dev seed and nowhere a production database is ever seeded. Every other active person in these
-- tenants gets the same password, so a database whose people were created through the old dev
-- identity provider keeps its data and its sign-ins. Existing accounts are never touched.
UPDATE principal
SET email = 'dev@nix.localhost', email_normalized = 'dev@nix.localhost', email_verified = true
WHERE principal_id = 'a2000000-0000-4000-8000-000000000001' AND email IS DISTINCT FROM 'dev@nix.localhost';

-- Password: nix-dev-password (Argon2id, the parameters PasswordHasher writes).
INSERT INTO local_account (principal_id, tenant_id, email_normalized, password_hash, password_changed_at)
SELECT principal_id, tenant_id, lower(btrim(email)),
       '$argon2id$v=19$m=19456,t=2,p=1$bml4LWRldi1zZWVkLXNhbHQ$8ji2dxLsDOwPSNKRKLMbA0LsSzcsVCOV3dg0ObRFV3A', now()
FROM principal
WHERE kind = 'user' AND status = 'active' AND email IS NOT NULL
  AND tenant_id IN ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002')
ON CONFLICT DO NOTHING;

-- One pending row per tenant keeps manual development and RLS probes honest without implying
-- delivery. The `.invalid` domain is reserved and cannot receive mail.
INSERT INTO workspace_invitation
    (invitation_id, tenant_id, workspace_id, email_normalized, role,
     invited_by_principal_id, status, invited_at)
VALUES
    ('a5000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
     'a1000000-0000-4000-8000-000000000001', 'pending-acme@example.invalid', 'viewer',
     'a2000000-0000-4000-8000-000000000001', 'pending', now()),
    ('b5000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
     'b1000000-0000-4000-8000-000000000001', 'pending-umbrella@example.invalid', 'viewer',
     'b2000000-0000-4000-8000-000000000001', 'pending', now())
ON CONFLICT (invitation_id) DO NOTHING;

DO $$
BEGIN
    RAISE NOTICE 'application data seeded: 2 tenants, 3 workspaces, 3 principals';
END
$$;
