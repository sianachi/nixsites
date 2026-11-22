using Nix.Persistence.Sql;
using Npgsql;

namespace Nix.Persistence.ObjectStorage;

/// <summary>One expired operation discovered without bypassing RLS in application code.</summary>
public sealed record AbandonedObjectOperation(
    string OwnerKind,
    Guid OwnerId,
    Guid TenantId,
    Guid WorkspaceId,
    Guid ActorId,
    DateTimeOffset ExpiresAt);

/// <summary>Calls the exact security-definer discovery function for abandoned object owners.</summary>
public sealed class AbandonedObjectOperationStore(NpgsqlDataSource dataSource)
{
    private const string FindSql = "SELECT * FROM nix_find_abandoned_object_operations(@limit)";

    private readonly PooledSql _db = new(dataSource);

    public async ValueTask<IReadOnlyList<AbandonedObjectOperation>> FindAsync(
        int limit,
        CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        return await _db.RowsAsync(
            FindSql,
            static reader => new AbandonedObjectOperation(
                reader.GetString(0),
                reader.GetGuid(1),
                reader.GetGuid(2),
                reader.GetGuid(3),
                reader.GetGuid(4),
                reader.GetFieldValue<DateTimeOffset>(5)),
            cancellationToken,
            NixParameter.Integer("limit", limit)).ConfigureAwait(false);
    }
}
