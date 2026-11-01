namespace Nix.Persistence.Migrations;

/// <summary>Durable principal-scoped replay receipts survive item deletion and purge.</summary>
public static class NativeReplaySecuritySql
{
    /// <summary>Adds bounded receipts and the tenant-and-principal RLS boundary.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
        CREATE TABLE native_replay_receipt (
            tenant_id uuid NOT NULL,
            principal_id uuid NOT NULL,
            operation_id uuid NOT NULL,
            workspace_id uuid NOT NULL,
            request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
            response text NOT NULL CHECK (jsonb_typeof(response::jsonb) = 'object' AND octet_length(response) <= 262144),
            created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, principal_id, operation_id)
        );
        ALTER TABLE native_replay_receipt ENABLE ROW LEVEL SECURITY;
        ALTER TABLE native_replay_receipt FORCE ROW LEVEL SECURITY;
        CREATE POLICY native_replay_receipt_owner ON native_replay_receipt
            USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
               AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
               AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid);
        REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON native_replay_receipt FROM nix_app;
        GRANT SELECT, INSERT ON native_replay_receipt TO nix_app;
        """);
    }

    /// <summary>Removes replay receipts.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("DROP TABLE native_replay_receipt;");
    }
}
