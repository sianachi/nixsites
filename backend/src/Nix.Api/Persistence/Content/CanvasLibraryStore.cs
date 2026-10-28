using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Content;
using Nix.Domain.Identity;

namespace Nix.Persistence.Content;

/// <summary>
/// Canvas library reads and writes inside the request's tenant scope, over EF Core.
/// </summary>
/// <remarks>
/// Envelope CRUD over a single row keyed by principal, so LINQ expresses it perfectly well and
/// there is no hand-written statement to justify.
/// </remarks>
public sealed class CanvasLibraryStore(NixDbContext dbContext) : ICanvasLibraryStore
{
    /// <inheritdoc />
    public async ValueTask<CanvasLibrary?> FindAsync(PrincipalId principalId, CancellationToken cancellationToken) =>
        await dbContext.CanvasLibraries
            .FirstOrDefaultAsync(library => library.PrincipalId == principalId, cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async Task SaveAsync(CanvasLibrary library, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(library);

        var existing = await dbContext.CanvasLibraries
            .AsTracking()
            .FirstOrDefaultAsync(row => row.PrincipalId == library.PrincipalId, cancellationToken)
            .ConfigureAwait(false);

        if (existing is null)
        {
            dbContext.CanvasLibraries.Add(library);
        }
        else
        {
            dbContext.Entry(existing).CurrentValues.SetValues(library);
        }

        await dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }
}
