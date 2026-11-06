using System.Net.Http.Json;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Features.Exports;

namespace Nix.Features.PublicLinks.Notes;

/// <summary>
/// [SEC] Renders a note's current body for a public link by asking collaboration, which calls back
/// to Core to confirm the link and classify every file before it emits any markup.
/// </summary>
public sealed class PublicNoteReader(HttpClient http, IConfiguration configuration) : IPublicNoteReader
{
    private const long ResponseLimit = 4_000_000;

    /// <summary>Renders the note, or null when it has no servable body or collaboration cannot say.</summary>
    public async ValueTask<PublicNoteRender?> RenderAsync(ResolvedPublicLink link, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(link);
        var secret = configuration["Nix:InternalSecret"];
        if (string.IsNullOrWhiteSpace(secret) || !ExportEndpoints.TryCollaborationBaseUri(configuration, out var origin))
        {
            return null;
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(origin, $"internal/public-links/{link.LinkId:D}/render"));
        request.Headers.Add("x-nix-internal-secret", secret);
        request.Content = JsonContent.Create(
            new PublicNoteScope(link.TenantId.Value, link.ServicePrincipalId, link.WorkspaceId.Value, link.ItemId.Value),
            PublicNotesJsonContext.Default.PublicNoteScope);
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            await response.Content.LoadIntoBufferAsync(ResponseLimit, timeout.Token).ConfigureAwait(false);
            var note = await response.Content.ReadFromJsonAsync(PublicNotesJsonContext.Default.CollabPublicNote, timeout.Token).ConfigureAwait(false);
            return note is null
                ? null
                : new PublicNoteRender(
                    note.Title,
                    note.Html,
                    note.ServableFileIds,
                    [.. note.WithheldFiles.Select(file => (file.FileItemId, file.Name))]);
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException or InvalidOperationException)
        {
            return null;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }
    }
}
