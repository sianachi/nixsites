namespace Nix.Persistence.Sql.Statements;

/// <summary>Exact receipt and item-revision point reads, using the composite primary keys.</summary>
internal static class NativeReplaySql
{
    internal const string LockOperation = "SELECT pg_advisory_xact_lock(hashtextextended(@identity, 0));";

    internal const string FindReceipt = """
        SELECT workspace_id, request_fingerprint, response::text
        FROM native_replay_receipt
        WHERE tenant_id = @tenant_id AND principal_id = @principal_id AND operation_id = @operation_id;
        """;

    internal const string LockItem = """
        SELECT id FROM item
        WHERE tenant_id = @tenant_id AND workspace_id = @workspace_id AND id = @item_id
        FOR UPDATE;
        """;

    internal const string ItemRevision = """
        SELECT COALESCE((SELECT seq FROM workspace_sync_item_revision
            WHERE tenant_id = @tenant_id AND workspace_id = @workspace_id AND item_id = @item_id), 0);
        """;

    internal const string SaveReceipt = """
        INSERT INTO native_replay_receipt
            (tenant_id, principal_id, operation_id, workspace_id, request_fingerprint, response)
        VALUES (@tenant_id, @principal_id, @operation_id, @workspace_id, @fingerprint, @response);
        """;
}
