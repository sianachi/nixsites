using Microsoft.Extensions.Caching.Memory;
using Nix.Abstractions;

namespace Nix.Features.PublicLinks.Notes;

/// <summary>[SEC] What a public note link binds into its page and remembers about its body.</summary>
public static class PublicNoteServing
{
    /// <summary>
    /// How long a render's servable ids are remembered. The key includes the body's revision, so an
    /// edit (a reference removed) takes effect at once; the lifetime only bounds memory.
    /// </summary>
    public static readonly TimeSpan ServableIdsLifetime = TimeSpan.FromSeconds(10);

    // shortcut: per-process cache, so each replica renders once per window; share it if replicas multiply.
    private static readonly MemoryCache ServableIds = new(new MemoryCacheOptions { SizeLimit = 2048 });

    /// <summary>Remembers the ids a render allows, keyed by link and body revision, for <see cref="ServableIdsLifetime"/>.</summary>
    public static void Remember(ResolvedPublicLink link, IReadOnlyList<Guid> ids)
    {
        ArgumentNullException.ThrowIfNull(link);
        ServableIds.Set(Key(link), ids.ToHashSet(), new MemoryCacheEntryOptions { Size = 1, AbsoluteExpirationRelativeToNow = ServableIdsLifetime });
    }

    private static (Guid, long?) Key(ResolvedPublicLink link) => (link.LinkId, link.NoteHeadSeq);

    /// <summary>The ids the note currently allows, from the cache or one render; null when it has no servable body.</summary>
    public static async ValueTask<IReadOnlySet<Guid>?> ServableIdsAsync(
        IPublicNoteReader reader, ResolvedPublicLink link, CancellationToken cancellation)
    {
        ArgumentNullException.ThrowIfNull(reader);
        ArgumentNullException.ThrowIfNull(link);
        if (ServableIds.TryGetValue(Key(link), out HashSet<Guid>? cached) && cached is not null)
        {
            return cached;
        }

        var render = await reader.RenderAsync(link, cancellation).ConfigureAwait(false);
        if (render is null)
        {
            return null;
        }

        Remember(link, render.ServableFileIds);
        return render.ServableFileIds.ToHashSet();
    }

    /// <summary>
    /// Gives the renderer's own file routes the token. A bare sentinel elsewhere in a note (a planted
    /// external link) stays literal, or the page would hand the token out.
    /// </summary>
    public static string BindToken(string html, string token)
    {
        ArgumentNullException.ThrowIfNull(html);
        return html.Replace(
            "=\"/public/v1/links/__TOKEN__/files/",
            $"=\"/public/v1/links/{Uri.EscapeDataString(token)}/files/",
            StringComparison.Ordinal);
    }
}
