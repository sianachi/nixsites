using System.Diagnostics.CodeAnalysis;
using System.Net.Http.Json;
using System.Text.Json;

namespace Nix.Features.Connections;

[SuppressMessage("Performance", "CA1812", Justification = "Created by the typed HTTP client factory.")]
internal sealed class ConnectorWorkerClient(HttpClient http, IConfiguration configuration)
{
    internal async Task<ConnectorWorkerResponse?> SendAsync(ConnectorWorkerRequest request, CancellationToken token)
    {
        var secret = configuration["Nix:InternalSecret"];
        if (string.IsNullOrWhiteSpace(secret)
            || !Uri.TryCreate(configuration["Nix:Pets:WorkerUrl"], UriKind.Absolute, out var origin)
            || origin.Scheme is not ("http" or "https") || origin.AbsolutePath != "/"
            || origin.UserInfo.Length + origin.Query.Length + origin.Fragment.Length != 0)
        {
            return null;
        }

        using var outgoing = new HttpRequestMessage(HttpMethod.Post, new Uri(origin, "/v1/sani/registered-mcp"));
        outgoing.Headers.Add("X-Nix-Internal-Secret", secret);
        outgoing.Content = JsonContent.Create(request, ConnectorJsonContext.Default.ConnectorWorkerRequest);
        try
        {
            using var response = await http.SendAsync(outgoing, token).ConfigureAwait(false);
            return response.IsSuccessStatusCode
                ? await response.Content.ReadFromJsonAsync(ConnectorJsonContext.Default.ConnectorWorkerResponse, token).ConfigureAwait(false)
                : null;
        }
        catch (Exception error) when (error is HttpRequestException or JsonException or OperationCanceledException)
        {
            return null;
        }
    }
}
