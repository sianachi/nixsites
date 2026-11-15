namespace Nix.Persistence.Migrations;

/// <summary>Pending OAuth authorization codes for remote MCP sign-in, reachable only through exact functions.</summary>
public static class OAuthCodeSecuritySql
{
    /// <summary>Creates the capability-only table and its create and consume functions.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            CREATE TABLE oauth_authorization_code (
                code_hash text PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
                tenant_id uuid NOT NULL,
                principal_id uuid NOT NULL,
                client_id text NOT NULL CHECK (length(client_id) <= 2048),
                redirect_uri text NOT NULL CHECK (length(redirect_uri) <= 512),
                challenge text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
                scopes text NOT NULL CHECK (length(scopes) <= 64),
                resource text CHECK (length(resource) <= 512),
                expires_at timestamptz NOT NULL
            );
            CREATE INDEX "IX_oauth_authorization_code_expiry" ON oauth_authorization_code(expires_at);
            ALTER TABLE oauth_authorization_code ENABLE ROW LEVEL SECURITY;
            ALTER TABLE oauth_authorization_code FORCE ROW LEVEL SECURITY;
            REVOKE ALL ON oauth_authorization_code FROM PUBLIC, nix_app;

            CREATE FUNCTION nix_create_oauth_code(p_code_hash text, p_tenant_id uuid, p_principal_id uuid, p_client_id text, p_redirect_uri text,
                p_challenge text, p_scopes text, p_resource text, p_expires_at timestamptz)
            RETURNS boolean
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
            BEGIN
                IF p_code_hash !~ '^[0-9a-f]{64}$' OR p_challenge !~ '^[A-Za-z0-9_-]{43}$' THEN RETURN false; END IF;
                -- A transaction lock makes the global bound hold across concurrent Core instances.
                PERFORM pg_advisory_xact_lock(197074, 3);
                DELETE FROM oauth_authorization_code WHERE expires_at <= now();
                IF (SELECT count(*) FROM oauth_authorization_code) >= 1024 THEN RETURN false; END IF;
                -- One account cannot fill the shared table: at most 5 live codes each.
                IF (SELECT count(*) FROM oauth_authorization_code WHERE principal_id = p_principal_id) >= 5 THEN RETURN false; END IF;
                INSERT INTO oauth_authorization_code(code_hash, tenant_id, principal_id, client_id, redirect_uri, challenge, scopes, resource, expires_at)
                    VALUES (p_code_hash, p_tenant_id, p_principal_id, p_client_id, p_redirect_uri, p_challenge, p_scopes, p_resource, p_expires_at);
                RETURN true;
            END $$;

            -- The delete is the single-use gate: whichever caller removes the row owns the code, win or lose.
            CREATE FUNCTION nix_consume_oauth_code(p_code_hash text)
            RETURNS TABLE (tenant_id uuid, principal_id uuid, client_id text, redirect_uri text, challenge text, scopes text, resource text, expires_at timestamptz)
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH purged AS (
                    DELETE FROM oauth_authorization_code WHERE expires_at <= now() AND code_hash <> p_code_hash
                ), used AS (
                    DELETE FROM oauth_authorization_code c WHERE c.code_hash = p_code_hash
                    RETURNING c.tenant_id, c.principal_id, c.client_id, c.redirect_uri, c.challenge, c.scopes, c.resource, c.expires_at
                )
                SELECT u.tenant_id, u.principal_id, u.client_id, u.redirect_uri, u.challenge, u.scopes, u.resource, u.expires_at FROM used u
            $$;

            REVOKE ALL ON FUNCTION nix_create_oauth_code(text, uuid, uuid, text, text, text, text, text, timestamptz),
                nix_consume_oauth_code(text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_create_oauth_code(text, uuid, uuid, text, text, text, text, text, timestamptz),
                nix_consume_oauth_code(text) TO nix_app;
            """);
    }

    /// <summary>Drops the code table and functions.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP FUNCTION nix_create_oauth_code(text, uuid, uuid, text, text, text, text, text, timestamptz), nix_consume_oauth_code(text);
            DROP TABLE oauth_authorization_code;
            """);
    }
}
