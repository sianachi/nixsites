namespace Nix.Persistence.Migrations;

/// <summary>Durable single-use native sign-in handoff codes, reachable only through exact functions.</summary>
public static class NativeHandoffSecuritySql
{
    /// <summary>Creates the capability-only table and its create and consume functions.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            CREATE TABLE native_login_handoff (
                code_hash text PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
                principal_id uuid NOT NULL,
                challenge text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
                payload text NOT NULL CHECK (length(payload) <= 2048),
                expires_at timestamptz NOT NULL
            );
            CREATE INDEX "IX_native_login_handoff_expiry" ON native_login_handoff(expires_at);
            ALTER TABLE native_login_handoff ENABLE ROW LEVEL SECURITY;
            ALTER TABLE native_login_handoff FORCE ROW LEVEL SECURITY;
            REVOKE ALL ON native_login_handoff FROM PUBLIC, nix_app;

            CREATE FUNCTION nix_create_native_handoff(p_code_hash text, p_principal_id uuid, p_challenge text, p_payload text, p_expires_at timestamptz)
            RETURNS boolean
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
            BEGIN
                IF p_code_hash !~ '^[0-9a-f]{64}$' OR p_challenge !~ '^[A-Za-z0-9_-]{43}$' THEN RETURN false; END IF;
                -- A transaction lock makes the global bound hold across concurrent Core instances.
                PERFORM pg_advisory_xact_lock(197074, 2);
                DELETE FROM native_login_handoff WHERE expires_at <= now();
                IF (SELECT count(*) FROM native_login_handoff) >= 1024 THEN RETURN false; END IF;
                -- One account cannot fill the shared table: at most 3 live handoffs each.
                IF (SELECT count(*) FROM native_login_handoff WHERE principal_id = p_principal_id) >= 3 THEN RETURN false; END IF;
                INSERT INTO native_login_handoff(code_hash, principal_id, challenge, payload, expires_at)
                    VALUES (p_code_hash, p_principal_id, p_challenge, p_payload, p_expires_at);
                RETURN true;
            END $$;

            -- The delete is the single-use gate: whichever caller removes the row owns the code, win or lose.
            -- Other expired rows go too, so an unredeemed session token never outlives its window.
            CREATE FUNCTION nix_consume_native_handoff(p_code_hash text)
            RETURNS TABLE (challenge text, payload text, expires_at timestamptz)
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                WITH purged AS (
                    DELETE FROM native_login_handoff WHERE expires_at <= now() AND code_hash <> p_code_hash
                ), used AS (
                    DELETE FROM native_login_handoff h WHERE h.code_hash = p_code_hash
                    RETURNING h.challenge, h.payload, h.expires_at
                )
                SELECT u.challenge, u.payload, u.expires_at FROM used u
            $$;

            REVOKE ALL ON FUNCTION nix_create_native_handoff(text, uuid, text, text, timestamptz),
                nix_consume_native_handoff(text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_create_native_handoff(text, uuid, text, text, timestamptz),
                nix_consume_native_handoff(text) TO nix_app;
            """);
    }

    /// <summary>Drops the handoff table and functions.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP FUNCTION nix_create_native_handoff(text, uuid, text, text, timestamptz), nix_consume_native_handoff(text);
            DROP TABLE native_login_handoff;
            """);
    }
}
