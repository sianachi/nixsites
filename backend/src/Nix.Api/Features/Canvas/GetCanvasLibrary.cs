using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Messaging;

namespace Nix.Features.Canvas;

/// <summary>
/// Asks for the caller's own canvas library.
/// </summary>
/// <remarks>
/// Carries no parameters, for the same reason <c>GetCurrentPrincipal</c> does not: the library
/// belongs to the caller, established by the session context, and asking for anyone else's would be
/// a different question with different authorization.
/// </remarks>
public sealed record GetCanvasLibrary : IQuery<CanvasLibraryItems>;

/// <summary>Handles <see cref="GetCanvasLibrary"/>.</summary>
/// <remarks>
/// Always succeeds: a principal who has never saved a library simply has an empty one, the same way
/// an item with no properties has an empty bag rather than a missing one.
/// </remarks>
public sealed class GetCanvasLibraryHandler(
    ICanvasLibraryStore store,
    INixSessionContextAccessor session)
    : IQueryHandler<GetCanvasLibrary, CanvasLibraryItems>
{
    private readonly INixSessionContextAccessor _session = session;

    /// <summary>Reads the caller's own library.</summary>
    /// <param name="query">The query, which carries no parameters.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The library's items, empty when nothing has been saved yet.</returns>
    public async ValueTask<CanvasLibraryItems> HandleAsync(
        GetCanvasLibrary query,
        CancellationToken cancellationToken)
    {
        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var library = await store.FindAsync(context.PrincipalId, cancellationToken).ConfigureAwait(false);
        if (library is null)
        {
            return new CanvasLibraryItems(new JsonArray());
        }

        // Stored exactly as the client sent it and parsed back exactly as it will be read - Core
        // does not interpret editor-specific library fields.
        var items = JsonNode.Parse(library.LibraryItemsJson) as JsonArray ?? new JsonArray();
        return new CanvasLibraryItems(items);
    }
}

/// <summary>A principal's canvas library, as the native library items array it is.</summary>
/// <param name="Items">The library items, opaque to Core.</param>
public sealed record CanvasLibraryItems(JsonArray Items);
