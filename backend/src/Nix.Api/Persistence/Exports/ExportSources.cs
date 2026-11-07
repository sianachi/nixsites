using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Items;

namespace Nix.Persistence.Exports;

/// <summary>The rows an export reads before and after its worker runs.</summary>
public sealed class ExportSources(NixDbContext database) : IExportSources
{
    /// <inheritdoc />
    public async ValueTask<long?> HeadSeqAsync(ItemId itemId, CancellationToken cancellationToken) =>
        await database.ContentDocs.AsNoTracking()
            .Where(document => document.ItemId == itemId)
            .Select(document => (long?)document.HeadSeq)
            .SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);

    // The upload is found by the idempotency key its destination call opened it with; the stored
    // result cannot carry its id (the database fixes that shape). A retry that produced different
    // bytes opens a second upload, and the newest is the one that counts.
    /// <inheritdoc />
    public async ValueTask<Guid?> FindExportUploadAsync(Guid exportId, CancellationToken cancellationToken)
    {
        var prefix = $"export-file:{exportId:D}:";
        return (await database.FileUploads.AsNoTracking()
            .Where(upload => upload.IdempotencyKey.StartsWith(prefix))
            .OrderByDescending(upload => upload.CreatedAt)
            .Select(upload => upload.Id)
            .FirstOrDefaultAsync(cancellationToken).ConfigureAwait(false))
            is { } id && id != default ? id.Value : null;
    }
}
