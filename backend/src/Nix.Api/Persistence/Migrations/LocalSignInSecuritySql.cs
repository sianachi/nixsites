namespace Nix.Persistence.Migrations;

/// <summary>
/// Core's own sign-in state: accounts, passkeys, authenticator secrets, one-time links and short-lived
/// challenges. Every table is capability-only, because most of the reads happen before a tenant is known
/// (the sign-in form has only an email address): the application role gets no table access and goes through
/// narrow security-definer functions, each of which derives the tenant from the principal row.
/// </summary>
public static class LocalSignInSecuritySql
{
    /// <summary>Creates the tables and their functions.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            CREATE TABLE local_account (
                principal_id uuid PRIMARY KEY,
                tenant_id uuid NOT NULL,
                email_normalized text NOT NULL CHECK (length(email_normalized) BETWEEN 3 AND 320),
                password_hash text,
                password_changed_at timestamptz,
                failed_count integer NOT NULL DEFAULT 0,
                failed_window_started_at timestamptz,
                paused_until timestamptz,
                created_at timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT local_account_email_unique UNIQUE (email_normalized),
                CONSTRAINT local_account_principal_fk FOREIGN KEY (tenant_id, principal_id)
                    REFERENCES principal (tenant_id, principal_id) ON DELETE CASCADE
            );

            CREATE TABLE local_passkey (
                id uuid PRIMARY KEY,
                principal_id uuid NOT NULL,
                tenant_id uuid NOT NULL,
                credential_id bytea NOT NULL UNIQUE,
                public_key bytea NOT NULL,
                sign_count bigint NOT NULL DEFAULT 0,
                aaguid uuid,
                transports text[] NOT NULL DEFAULT '{}',
                rp_id text NOT NULL,
                kind text NOT NULL CHECK (kind IN ('passkey', 'security_key')),
                name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
                created_at timestamptz NOT NULL DEFAULT now(),
                last_used_at timestamptz,
                CONSTRAINT local_passkey_principal_fk FOREIGN KEY (tenant_id, principal_id)
                    REFERENCES principal (tenant_id, principal_id) ON DELETE CASCADE
            );
            CREATE INDEX "IX_local_passkey_principal" ON local_passkey (principal_id);

            CREATE TABLE local_totp (
                principal_id uuid PRIMARY KEY,
                tenant_id uuid NOT NULL,
                secret text NOT NULL,
                confirmed_at timestamptz,
                last_used_step bigint,
                CONSTRAINT local_totp_principal_fk FOREIGN KEY (tenant_id, principal_id)
                    REFERENCES principal (tenant_id, principal_id) ON DELETE CASCADE
            );

            CREATE TABLE local_account_link (
                id uuid PRIMARY KEY,
                principal_id uuid NOT NULL,
                tenant_id uuid NOT NULL,
                purpose text NOT NULL CHECK (purpose IN ('setup', 'reset')),
                token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
                expires_at timestamptz NOT NULL,
                used_at timestamptz,
                created_by_principal_id uuid,
                created_at timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT local_account_link_principal_fk FOREIGN KEY (tenant_id, principal_id)
                    REFERENCES principal (tenant_id, principal_id) ON DELETE CASCADE
            );
            CREATE INDEX "IX_local_account_link_principal" ON local_account_link (principal_id);

            -- Pending sign-in steps. A row is a challenge awaiting its answer: the second step after a
            -- password, a passkey sign-in (no principal yet), or a passkey registration.
            CREATE TABLE local_second_step (
                id uuid PRIMARY KEY,
                kind text NOT NULL CHECK (kind IN ('second_step', 'passkey_sign_in', 'link_passkey', 'add_passkey')),
                principal_id uuid,
                tenant_id uuid,
                state text,
                return_to text,
                native text,
                attempts integer NOT NULL DEFAULT 0,
                created_at timestamptz NOT NULL DEFAULT now(),
                expires_at timestamptz NOT NULL,
                CONSTRAINT local_second_step_principal_fk FOREIGN KEY (tenant_id, principal_id)
                    REFERENCES principal (tenant_id, principal_id) ON DELETE CASCADE
            );
            CREATE INDEX "IX_local_second_step_expiry" ON local_second_step (expires_at);

            ALTER TABLE local_account ENABLE ROW LEVEL SECURITY;
            ALTER TABLE local_account FORCE ROW LEVEL SECURITY;
            ALTER TABLE local_passkey ENABLE ROW LEVEL SECURITY;
            ALTER TABLE local_passkey FORCE ROW LEVEL SECURITY;
            ALTER TABLE local_totp ENABLE ROW LEVEL SECURITY;
            ALTER TABLE local_totp FORCE ROW LEVEL SECURITY;
            ALTER TABLE local_account_link ENABLE ROW LEVEL SECURITY;
            ALTER TABLE local_account_link FORCE ROW LEVEL SECURITY;
            ALTER TABLE local_second_step ENABLE ROW LEVEL SECURITY;
            ALTER TABLE local_second_step FORCE ROW LEVEL SECURITY;
            REVOKE ALL ON local_account, local_passkey, local_totp, local_account_link, local_second_step
                FROM PUBLIC, nix_app;
            """);

        emit("""
            -- Accounts ---------------------------------------------------------------------------------

            CREATE FUNCTION nix_local_any_account() RETURNS boolean
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT EXISTS (SELECT 1 FROM local_account)
            $$;

            -- First-run setup has no principal yet, so it cannot read the tenant table under RLS. It may only
            -- ever see the id, and only when the install has one tenant. A new install has none (nothing
            -- else creates one in local mode), so the first call makes it. Callers check the setup code first.
            CREATE FUNCTION nix_local_setup_tenant() RETURNS uuid
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
            DECLARE
                v_count integer;
                v_tenant uuid;
            BEGIN
                PERFORM pg_advisory_xact_lock(5650331528013870197); -- one creator at a time
                SELECT count(*), (array_agg(t.tenant_id))[1] INTO v_count, v_tenant FROM tenant t;
                IF v_count = 0 THEN
                    v_tenant := gen_random_uuid();
                    INSERT INTO tenant (tenant_id, name, isolation_mode, created_at)
                    VALUES (v_tenant, 'Nix', 'shared', now());
                ELSIF v_count > 1 THEN
                    RETURN NULL;
                END IF;
                RETURN v_tenant;
            END $$;

            -- What the sign-in settings need to know about the session asking: one made by the command
            -- line's device sign-in is not a person at a browser, and its age gates passwordless changes.
            CREATE FUNCTION nix_local_session(p_session uuid)
            RETURNS TABLE (is_cli boolean, created_at timestamptz)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT EXISTS (SELECT 1 FROM cli_session_link l WHERE l.session_id = s.session_id), s.created_at
                  FROM browser_session s
                 WHERE s.session_id = p_session AND s.revoked_at IS NULL AND s.expires_at > now()
            $$;

            -- How many stored passwords are still bcrypt hashes carried over from another system, and their
            -- highest cost, so a sign-in for an unknown email can spend the same time as a real one.
            CREATE FUNCTION nix_local_hash_mix()
            RETURNS TABLE (total integer, bcrypt integer, bcrypt_cost integer)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT count(*)::integer,
                       count(*) FILTER (WHERE a.password_hash ~ '^\$2[abxy]\$\d\d\$')::integer,
                       coalesce(max(substring(a.password_hash from '^\$2[abxy]\$(\d\d)\$')::integer), 0)
                  FROM local_account a WHERE a.password_hash IS NOT NULL
            $$;

            -- Looks one account up by normalized email or by principal; at least one argument is required.
            CREATE FUNCTION nix_local_find_account(p_email text, p_principal uuid)
            RETURNS TABLE (principal_id uuid, tenant_id uuid, email text, display_name text, status text,
                           password_hash text, password_changed_at timestamptz, paused_until timestamptz,
                           totp_enabled boolean, passkey_count integer, security_key_count integer)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT a.principal_id, a.tenant_id, p.email, p.display_name, p.status,
                       a.password_hash, a.password_changed_at, a.paused_until,
                       EXISTS (SELECT 1 FROM local_totp t WHERE t.principal_id = a.principal_id AND t.confirmed_at IS NOT NULL),
                       (SELECT count(*)::integer FROM local_passkey k WHERE k.principal_id = a.principal_id AND k.kind = 'passkey'),
                       (SELECT count(*)::integer FROM local_passkey k WHERE k.principal_id = a.principal_id AND k.kind = 'security_key')
                  FROM local_account a
                  JOIN principal p ON p.tenant_id = a.tenant_id AND p.principal_id = a.principal_id
                 WHERE (p_email IS NOT NULL OR p_principal IS NOT NULL)
                   AND (p_email IS NULL OR a.email_normalized = p_email)
                   AND (p_principal IS NULL OR a.principal_id = p_principal)
                 LIMIT 1
            $$;

            -- Called in the transaction that provisioned the principal. False when the email is already taken.
            CREATE FUNCTION nix_local_create_account(p_principal uuid, p_email text, p_password_hash text)
            RETURNS boolean
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH inserted AS (
                    INSERT INTO local_account (principal_id, tenant_id, email_normalized, password_hash, password_changed_at)
                    SELECT p.principal_id, p.tenant_id, p_email, p_password_hash,
                           CASE WHEN p_password_hash IS NULL THEN NULL ELSE now() END
                      FROM principal p WHERE p.principal_id = p_principal
                    ON CONFLICT DO NOTHING
                    RETURNING 1
                )
                SELECT EXISTS (SELECT 1 FROM inserted)
            $$;

            -- p_changed false is a transparent rehash: the password and its age stay as they were.
            -- A real change also lifts any pause and clears the failure window.
            CREATE FUNCTION nix_local_set_password(p_principal uuid, p_hash text, p_changed boolean)
            RETURNS boolean
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH updated AS (
                    UPDATE local_account
                       SET password_hash = p_hash,
                           password_changed_at = CASE WHEN p_changed THEN now() ELSE password_changed_at END,
                           failed_count = CASE WHEN p_changed THEN 0 ELSE failed_count END,
                           failed_window_started_at = CASE WHEN p_changed THEN NULL ELSE failed_window_started_at END,
                           paused_until = CASE WHEN p_changed THEN NULL ELSE paused_until END
                     WHERE principal_id = p_principal
                    RETURNING 1
                )
                SELECT EXISTS (SELECT 1 FROM updated)
            $$;

            -- Ten failures inside five minutes pause the account for five minutes. Returns the end of the
            -- pause when one is now in force. The row lock makes concurrent failures count exactly.
            CREATE FUNCTION nix_local_register_failure(p_principal uuid) RETURNS timestamptz
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
            DECLARE
                v_count integer;
                v_started timestamptz;
                v_paused timestamptz;
            BEGIN
                SELECT a.failed_count, a.failed_window_started_at, a.paused_until
                  INTO v_count, v_started, v_paused
                  FROM local_account a WHERE a.principal_id = p_principal FOR UPDATE;
                IF NOT FOUND THEN RETURN NULL; END IF;
                IF v_started IS NULL OR v_started <= now() - interval '5 minutes' THEN
                    v_count := 1;
                    v_started := now();
                ELSE
                    v_count := v_count + 1;
                END IF;
                IF v_count >= 10 THEN
                    v_paused := now() + interval '5 minutes';
                    v_count := 0;
                    v_started := NULL;
                END IF;
                UPDATE local_account
                   SET failed_count = v_count, failed_window_started_at = v_started, paused_until = v_paused
                 WHERE principal_id = p_principal;
                IF v_paused > now() THEN RETURN v_paused; END IF;
                RETURN NULL;
            END $$;

            CREATE FUNCTION nix_local_clear_failures(p_principal uuid) RETURNS void
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                UPDATE local_account SET failed_count = 0, failed_window_started_at = NULL WHERE principal_id = p_principal
            $$;

            -- Revokes every standing browser session of the principal, except the one named (if any).
            CREATE FUNCTION nix_local_revoke_sessions(p_principal uuid, p_except uuid) RETURNS integer
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH revoked AS (
                    UPDATE browser_session
                       SET revoked_at = greatest(now(), created_at)
                     WHERE principal_id = p_principal AND revoked_at IS NULL AND expires_at > now()
                       AND (p_except IS NULL OR session_id <> p_except)
                    RETURNING 1
                )
                SELECT count(*)::integer FROM revoked
            $$;

            -- Passkeys ---------------------------------------------------------------------------------

            CREATE FUNCTION nix_local_find_passkey(p_credential_id bytea)
            RETURNS TABLE (id uuid, principal_id uuid, tenant_id uuid, public_key bytea, sign_count bigint,
                           rp_id text, kind text, status text, display_name text)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT k.id, k.principal_id, k.tenant_id, k.public_key, k.sign_count, k.rp_id, k.kind, p.status, p.display_name
                  FROM local_passkey k
                  JOIN principal p ON p.tenant_id = k.tenant_id AND p.principal_id = k.principal_id
                 WHERE k.credential_id = p_credential_id
                 LIMIT 1
            $$;

            CREATE FUNCTION nix_local_list_passkeys(p_principal uuid)
            RETURNS TABLE (id uuid, credential_id bytea, public_key bytea, sign_count bigint, aaguid uuid,
                           transports text[], rp_id text, kind text, name text, created_at timestamptz,
                           last_used_at timestamptz)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT k.id, k.credential_id, k.public_key, k.sign_count, k.aaguid, k.transports, k.rp_id,
                       k.kind, k.name, k.created_at, k.last_used_at
                  FROM local_passkey k WHERE k.principal_id = p_principal ORDER BY k.created_at, k.id
            $$;

            -- At most 20 credentials per person; false when full or when the credential already exists.
            CREATE FUNCTION nix_local_add_passkey(
                p_id uuid, p_principal uuid, p_credential_id bytea, p_public_key bytea, p_sign_count bigint,
                p_aaguid uuid, p_transports text[], p_rp_id text, p_kind text, p_name text)
            RETURNS boolean
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH inserted AS (
                    INSERT INTO local_passkey (id, principal_id, tenant_id, credential_id, public_key, sign_count,
                                               aaguid, transports, rp_id, kind, name)
                    SELECT p_id, p.principal_id, p.tenant_id, p_credential_id, p_public_key, p_sign_count,
                           p_aaguid, coalesce(p_transports, '{}'), p_rp_id, p_kind, p_name
                      FROM principal p
                     WHERE p.principal_id = p_principal
                       AND (SELECT count(*) FROM local_passkey k WHERE k.principal_id = p_principal) < 20
                    ON CONFLICT DO NOTHING
                    RETURNING 1
                )
                SELECT EXISTS (SELECT 1 FROM inserted)
            $$;

            CREATE FUNCTION nix_local_touch_passkey(p_id uuid, p_sign_count bigint) RETURNS void
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                UPDATE local_passkey SET sign_count = p_sign_count, last_used_at = now() WHERE id = p_id
            $$;

            CREATE FUNCTION nix_local_rename_passkey(p_principal uuid, p_id uuid, p_name text) RETURNS boolean
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH updated AS (
                    UPDATE local_passkey SET name = p_name WHERE id = p_id AND principal_id = p_principal RETURNING 1
                )
                SELECT EXISTS (SELECT 1 FROM updated)
            $$;

            CREATE FUNCTION nix_local_remove_passkey(p_principal uuid, p_id uuid) RETURNS boolean
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH removed AS (
                    DELETE FROM local_passkey WHERE id = p_id AND principal_id = p_principal RETURNING 1
                )
                SELECT EXISTS (SELECT 1 FROM removed)
            $$;

            -- Authenticator app -----------------------------------------------------------------------

            CREATE FUNCTION nix_local_get_totp(p_principal uuid)
            RETURNS TABLE (secret text, confirmed_at timestamptz, last_used_step bigint)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT t.secret, t.confirmed_at, t.last_used_step FROM local_totp t WHERE t.principal_id = p_principal
            $$;

            -- Stores a new, unconfirmed secret, replacing any earlier one.
            CREATE FUNCTION nix_local_set_totp(p_principal uuid, p_secret text) RETURNS boolean
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH upserted AS (
                    INSERT INTO local_totp (principal_id, tenant_id, secret)
                    SELECT p.principal_id, p.tenant_id, p_secret FROM principal p WHERE p.principal_id = p_principal
                    ON CONFLICT (principal_id) DO UPDATE
                        SET secret = excluded.secret, confirmed_at = NULL, last_used_step = NULL
                    RETURNING 1
                )
                SELECT EXISTS (SELECT 1 FROM upserted)
            $$;

            -- Confirms a pending secret with the step of the first accepted code, which is then spent.
            CREATE FUNCTION nix_local_confirm_totp(p_principal uuid, p_step bigint) RETURNS boolean
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH updated AS (
                    UPDATE local_totp SET confirmed_at = now(), last_used_step = p_step
                     WHERE principal_id = p_principal AND confirmed_at IS NULL
                    RETURNING 1
                )
                SELECT EXISTS (SELECT 1 FROM updated)
            $$;

            -- The compare-and-set that makes a code usable once: only a later step than the last accepted wins.
            CREATE FUNCTION nix_local_use_totp_step(p_principal uuid, p_step bigint) RETURNS boolean
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH updated AS (
                    UPDATE local_totp SET last_used_step = p_step
                     WHERE principal_id = p_principal AND confirmed_at IS NOT NULL
                       AND (last_used_step IS NULL OR last_used_step < p_step)
                    RETURNING 1
                )
                SELECT EXISTS (SELECT 1 FROM updated)
            $$;

            CREATE FUNCTION nix_local_remove_totp(p_principal uuid) RETURNS boolean
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH removed AS (DELETE FROM local_totp WHERE principal_id = p_principal RETURNING 1)
                SELECT EXISTS (SELECT 1 FROM removed)
            $$;

            -- One-time links ---------------------------------------------------------------------------

            -- A new link replaces every unused one the person had, so only the latest works.
            CREATE FUNCTION nix_local_create_link(
                p_id uuid, p_principal uuid, p_purpose text, p_hash text, p_expires_at timestamptz, p_created_by uuid)
            RETURNS boolean
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM local_account a WHERE a.principal_id = p_principal) THEN RETURN false; END IF;
                DELETE FROM local_account_link l WHERE l.principal_id = p_principal AND l.used_at IS NULL;
                INSERT INTO local_account_link (id, principal_id, tenant_id, purpose, token_hash, expires_at, created_by_principal_id)
                SELECT p_id, p.principal_id, p.tenant_id, p_purpose, p_hash, p_expires_at, p_created_by
                  FROM principal p WHERE p.principal_id = p_principal;
                RETURN true;
            END $$;

            -- Unknown, used, expired and disabled-person links all return nothing.
            CREATE FUNCTION nix_local_find_link(p_hash text)
            RETURNS TABLE (id uuid, principal_id uuid, tenant_id uuid, purpose text, email text, display_name text)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT l.id, l.principal_id, l.tenant_id, l.purpose, p.email, p.display_name
                  FROM local_account_link l
                  JOIN principal p ON p.tenant_id = l.tenant_id AND p.principal_id = l.principal_id
                 WHERE l.token_hash = p_hash AND l.used_at IS NULL AND l.expires_at > now() AND p.status = 'active'
            $$;

            -- The update is the single-use gate: whichever caller flips used_at owns the link.
            CREATE FUNCTION nix_local_consume_link(p_hash text)
            RETURNS TABLE (id uuid, principal_id uuid, tenant_id uuid, purpose text, email text, display_name text)
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH used AS (
                    UPDATE local_account_link l SET used_at = now()
                     WHERE l.token_hash = p_hash AND l.used_at IS NULL AND l.expires_at > now()
                       AND EXISTS (SELECT 1 FROM principal p
                                    WHERE p.tenant_id = l.tenant_id AND p.principal_id = l.principal_id AND p.status = 'active')
                    RETURNING l.id, l.principal_id, l.tenant_id, l.purpose
                )
                SELECT u.id, u.principal_id, u.tenant_id, u.purpose, p.email, p.display_name
                  FROM used u JOIN principal p ON p.tenant_id = u.tenant_id AND p.principal_id = u.principal_id
            $$;

            -- Pending challenges ----------------------------------------------------------------------

            -- Sweeps expired rows and bounds each kind. False when full or when the named person does not exist.
            CREATE FUNCTION nix_local_create_challenge(
                p_id uuid, p_kind text, p_principal uuid, p_state text, p_return_to text, p_native text,
                p_expires_at timestamptz)
            RETURNS boolean
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
            BEGIN
                DELETE FROM local_second_step s WHERE s.expires_at <= now();
                -- Each kind has its own bound, so a flood of anonymous passkey sign-ins cannot crowd out second steps.
                IF (SELECT count(*) FROM local_second_step s WHERE s.kind = p_kind) >= 1024 THEN RETURN false; END IF;
                IF p_principal IS NULL THEN
                    INSERT INTO local_second_step (id, kind, state, return_to, native, expires_at)
                    VALUES (p_id, p_kind, p_state, p_return_to, p_native, p_expires_at);
                ELSE
                    INSERT INTO local_second_step (id, kind, principal_id, tenant_id, state, return_to, native, expires_at)
                    SELECT p_id, p_kind, p.principal_id, p.tenant_id, p_state, p_return_to, p_native, p_expires_at
                      FROM principal p WHERE p.principal_id = p_principal;
                    IF NOT FOUND THEN RETURN false; END IF;
                END IF;
                RETURN true;
            END $$;

            -- Live means unexpired and under five wrong answers.
            CREATE FUNCTION nix_local_get_challenge(p_id uuid, p_kind text)
            RETURNS TABLE (id uuid, kind text, principal_id uuid, tenant_id uuid, state text,
                           return_to text, native text, attempts integer)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT s.id, s.kind, s.principal_id, s.tenant_id, s.state, s.return_to, s.native, s.attempts
                  FROM local_second_step s
                 WHERE s.id = p_id AND s.kind = p_kind AND s.expires_at > now() AND s.attempts < 5
            $$;

            CREATE FUNCTION nix_local_bump_challenge(p_id uuid) RETURNS integer
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH bumped AS (
                    UPDATE local_second_step SET attempts = attempts + 1 WHERE id = p_id RETURNING attempts
                )
                SELECT coalesce((SELECT max(attempts) FROM bumped), 5)
            $$;

            CREATE FUNCTION nix_local_set_challenge_state(p_id uuid, p_state text) RETURNS boolean
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH updated AS (
                    UPDATE local_second_step SET state = p_state WHERE id = p_id AND expires_at > now() RETURNING 1
                )
                SELECT EXISTS (SELECT 1 FROM updated)
            $$;

            -- The delete is the single-use gate for a challenge.
            CREATE FUNCTION nix_local_take_challenge(p_id uuid, p_kind text)
            RETURNS TABLE (id uuid, kind text, principal_id uuid, tenant_id uuid, state text,
                           return_to text, native text, attempts integer)
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH taken AS (
                    DELETE FROM local_second_step s
                     WHERE s.id = p_id AND s.kind = p_kind AND s.expires_at > now() AND s.attempts < 5
                    RETURNING s.id, s.kind, s.principal_id, s.tenant_id, s.state, s.return_to, s.native, s.attempts
                )
                SELECT t.id, t.kind, t.principal_id, t.tenant_id, t.state, t.return_to, t.native, t.attempts FROM taken t
            $$;

            -- People admin ----------------------------------------------------------------------------

            -- Every local account of one tenant, for the tenant admin's People page.
            CREATE FUNCTION nix_local_list_people(p_tenant uuid)
            RETURNS TABLE (principal_id uuid, email text, display_name text, status text, is_admin boolean,
                           has_password boolean, passkey_count integer, totp_enabled boolean, created_at timestamptz)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT a.principal_id, p.email, p.display_name, p.status,
                       EXISTS (SELECT 1 FROM tenant_role r WHERE r.tenant_id = a.tenant_id AND r.subject_type = 'principal'
                                  AND r.subject_id = a.principal_id AND r.role = 'admin'),
                       a.password_hash IS NOT NULL,
                       (SELECT count(*)::integer FROM local_passkey k WHERE k.principal_id = a.principal_id AND k.kind = 'passkey'),
                       EXISTS (SELECT 1 FROM local_totp t WHERE t.principal_id = a.principal_id AND t.confirmed_at IS NOT NULL),
                       a.created_at
                  FROM local_account a
                  JOIN principal p ON p.tenant_id = a.tenant_id AND p.principal_id = a.principal_id
                 WHERE a.tenant_id = p_tenant
                 ORDER BY a.created_at, a.principal_id
            $$;

            -- Disables (suspended) or re-enables (active) a local person of that tenant and, when disabling,
            -- revokes their browser sessions in the same statement. False when no such local person, or when the
            -- person was removed for good (deprovisioned), which an admin must not undo.
            CREATE FUNCTION nix_local_set_person_status(p_tenant uuid, p_principal uuid, p_status text)
            RETURNS boolean
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
            DECLARE v_done boolean;
            BEGIN
                IF p_status NOT IN ('active', 'suspended') THEN RETURN false; END IF;
                UPDATE principal p SET status = p_status
                 WHERE p.tenant_id = p_tenant AND p.principal_id = p_principal AND p.kind = 'user'
                   AND p.status IN ('active', 'suspended')
                   AND EXISTS (SELECT 1 FROM local_account a WHERE a.principal_id = p.principal_id);
                v_done := FOUND;
                IF v_done AND p_status = 'suspended' THEN
                    UPDATE browser_session SET revoked_at = greatest(now(), created_at)
                     WHERE principal_id = p_principal AND revoked_at IS NULL AND expires_at > now();
                END IF;
                RETURN v_done;
            END $$;

            DO $grants$
            DECLARE f record;
            BEGIN
                FOR f IN
                    SELECT p.oid::regprocedure AS signature
                      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname LIKE 'nix\_local\_%'
                LOOP
                    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.signature);
                    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO nix_app', f.signature);
                END LOOP;
            END $grants$;
            """);
    }

    /// <summary>Drops the functions and tables.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DO $drop$
            DECLARE f record;
            BEGIN
                FOR f IN
                    SELECT p.oid::regprocedure AS signature
                      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname LIKE 'nix\_local\_%'
                LOOP
                    EXECUTE format('DROP FUNCTION %s', f.signature);
                END LOOP;
            END $drop$;
            DROP TABLE local_second_step, local_account_link, local_totp, local_passkey, local_account;
            """);
    }
}
