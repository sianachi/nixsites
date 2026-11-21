namespace Nix.Contracts;

/// <summary>
/// One slice of a list, and an opaque cursor for the next.
/// </summary>
/// <typeparam name="TItem">The element type.</typeparam>
/// <param name="Items">The elements in this slice, in the collection's order.</param>
/// <param name="NextCursor">
/// The cursor to pass back for the following slice, or <see langword="null"/> on the last one.
/// </param>
/// <remarks>
/// <para>
/// Cursor pagination everywhere; no page numbers anywhere. Offsets are wrong for this data in two
/// ways that matter: a row inserted while a client walks the list shifts every later offset, so
/// pages silently skip and repeat items, and <c>OFFSET n</c> makes the database walk and discard
/// n rows, which gets slower the further a client reads. A cursor names a position rather than a
/// distance, so neither happens.
/// </para>
/// <para>
/// <see cref="NextCursor"/> is present and null on the last page rather than absent. Exhaustion is
/// then something the client's schema can prove, instead of something it infers from a missing
/// key - and a missing key is indistinguishable from a serialisation bug.
/// </para>
/// <para>
/// The cursor is opaque by contract. Clients pass back exactly what they were given and never
/// construct or parse one; that is what lets the encoding change without breaking anybody.
/// </para>
/// </remarks>
internal sealed record CursorPage<TItem>(IReadOnlyList<TItem> Items, string? NextCursor);

/// <summary>
/// Paging limits shared by every paginated endpoint.
/// </summary>
internal static class CursorPaging
{
    /// <summary>Slice size used when a request does not ask for one.</summary>
    public const int DefaultLimit = 50;

    /// <summary>
    /// Largest slice the server will return, whatever was asked for.
    /// </summary>
    /// <remarks>
    /// A ceiling rather than an error: a client asking for 10,000 rows gets 200 and a cursor,
    /// which is a working answer, rather than a 400 telling it to ask again more politely.
    /// </remarks>
    public const int MaximumLimit = 200;
}
