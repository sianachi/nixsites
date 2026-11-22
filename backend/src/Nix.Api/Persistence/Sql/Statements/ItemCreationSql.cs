namespace Nix.Persistence.Sql.Statements;

/// <summary>Creation receipts use their tenant/principal/key primary key and the current transaction.</summary>
public static class ItemCreationSql
{
    /// <summary>Compares canonical JSON input without retaining duplicate item content.</summary>
    public const string Find = """
        SELECT item_id, request_hash = sha256(convert_to(@request::jsonb::text, 'UTF8'))
        FROM item_creation_receipt
        WHERE tenant_id = @tenant_id AND principal_id = @principal_id AND request_key = @key
        """;

    /// <summary>Keeps the receipt after item purging so a delayed retry never duplicates its creation.</summary>
    public const string Insert = """
        INSERT INTO item_creation_receipt (tenant_id, principal_id, request_key, request_hash, item_id)
        VALUES (@tenant_id, @principal_id, @key, sha256(convert_to(@request::jsonb::text, 'UTF8')), @item_id)
        """;
}
