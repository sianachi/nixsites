using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Nix.Features.Exports;

/// <summary>Names the note revision an export-to-file was cut from, so history pruning keeps it.</summary>
public interface IExportRevisionNamer
{
    /// <summary>Makes sure the revision carries a name, leaving an existing name alone.</summary>
    /// <param name="itemId">The note.</param>
    /// <param name="seq">The revision.</param>
    /// <param name="name">The name to give it when it has none.</param>
    /// <param name="bearer">The caller's bearer, forwarded to the collaboration service.</param>
    /// <param name="cancellationToken">Cancels the calls.</param>
    /// <returns><see langword="false"/> when the collaboration service could not be reached or refused.</returns>
    public ValueTask<bool> EnsureNamedAsync(Guid itemId, long seq, string name, string bearer, CancellationToken cancellationToken);
}

/// <summary>
/// Calls the collaboration service as the caller. Naming a version upserts, so the version list is
/// read first and a person's own name is never replaced.
/// </summary>
/// <remarks>shortcut: read-then-write, so a name given between the two calls is overwritten; make it one conditional write in collab if that ever matters.</remarks>
public sealed class ExportRevisionNamer(HttpClient http, IConfiguration configuration) : IExportRevisionNamer
{
    private static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(15);

    public async ValueTask<bool> EnsureNamedAsync(Guid itemId, long seq, string name, string bearer, CancellationToken cancellationToken)
    {
        if (!ExportEndpoints.TryCollaborationBaseUri(configuration, out var origin))
        {
            return false;
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(CallTimeout);
        var uri = new Uri(origin, $"documents/{itemId:D}/versions");
        try
        {
            using (var list = new HttpRequestMessage(HttpMethod.Get, uri))
            {
                list.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
                using var listed = await http.SendAsync(list, timeout.Token).ConfigureAwait(false);
                if (!listed.IsSuccessStatusCode)
                {
                    return false;
                }
                using var document = JsonDocument.Parse(await listed.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false));
                if (document.RootElement.TryGetProperty("versions", out var versions)
                    && versions.ValueKind == JsonValueKind.Array
                    && versions.EnumerateArray().Any(version => version.TryGetProperty("seq", out var value) && SeqEquals(value, seq)))
                {
                    return true;
                }
            }
            using var create = new HttpRequestMessage(HttpMethod.Post, uri) { Content = JsonContent.Create(new { seq, name }) };
            create.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
            using var created = await http.SendAsync(create, timeout.Token).ConfigureAwait(false);
            return created.IsSuccessStatusCode;
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException || exception is OperationCanceledException && !cancellationToken.IsCancellationRequested)
        {
            return false;
        }
    }

    private static bool SeqEquals(JsonElement value, long seq) => value.ValueKind switch
    {
        JsonValueKind.Number => value.TryGetInt64(out var number) && number == seq,
        JsonValueKind.String => long.TryParse(value.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed == seq,
        _ => false,
    };
}
