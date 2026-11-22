using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Items;
using Npgsql;
using Nix.Persistence.Sql;

namespace Nix.Persistence.Habits;

/// <summary>Uses the request transaction so concurrent retries cannot create duplicate daily items.</summary>
public sealed class HabitLock(NixDbContext database) : IHabitLock
{
    /// <inheritdoc />
    public async ValueTask AcquireAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(database);
        if (database.Database.CurrentTransaction is null)
        {
            throw new InvalidOperationException("Habit writes require an active Core transaction.");
        }
        await database.Database.ExecuteSqlRawAsync(
            "SELECT pg_advisory_xact_lock(hashtextextended(@identity, 0));",
            [NixParameter.Text("identity", $"habit:{itemId.Value:D}")],
            cancellationToken).ConfigureAwait(false);
    }
}
