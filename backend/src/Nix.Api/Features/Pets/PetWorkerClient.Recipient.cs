using System.Diagnostics.CodeAnalysis;
using System.Net.Http.Json;
using Nix.Abstractions;
using Nix.Features.PetRuns;

namespace Nix.Features.Pets;

[SuppressMessage("Performance", "CA1812", Justification = "Created by the typed HTTP client factory.")]
internal sealed class PetRecipientMetadataClient(HttpClient http, IConfiguration configuration, INixSessionContextAccessor session)
{
    internal async Task<string?> ConnectionRevisionAsync(string provider, CancellationToken cancellationToken)
    {
        var caller = session.Current;
        var secret = configuration["Nix:InternalSecret"];
        if (caller is null || string.IsNullOrWhiteSpace(secret)
            || !Uri.TryCreate(configuration["Nix:Pets:WorkerUrl"], UriKind.Absolute, out var origin)
            || origin.Scheme is not ("http" or "https") || origin.UserInfo.Length != 0
            || origin.AbsolutePath != "/" || origin.Query.Length != 0 || origin.Fragment.Length != 0)
        {
            return null;
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(origin, "/v1/companion"));
        request.Headers.Add("X-Nix-Internal-Secret", secret);
        request.Content = JsonContent.Create(new PetRecipientMetadataRequest("recipient_metadata", caller.Value.TenantId.Value.ToString(),
            caller.Value.PrincipalId.Value.ToString(), provider), PetPlanSharingJson.Default.PetRecipientMetadataRequest);
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength is > 2048)
            {
                return null;
            }

            await response.Content.LoadIntoBufferAsync(2048, timeout.Token).ConfigureAwait(false);
            var metadata = await response.Content.ReadFromJsonAsync(PetPlanSharingJson.Default.PetRecipientMetadataResponse, timeout.Token).ConfigureAwait(false);
            return metadata?.Provider == provider && metadata.ConnectionRevision is { Length: >= 16 and <= 128 } revision
                && revision.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_') ? revision : null;
        }
        catch (Exception error) when (error is HttpRequestException or System.Text.Json.JsonException
            || error is OperationCanceledException && !cancellationToken.IsCancellationRequested)
        { return null; }
    }
}
