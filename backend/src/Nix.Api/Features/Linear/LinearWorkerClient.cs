using System.Diagnostics.CodeAnalysis;
using System.Net.Http.Json;
using System.Text.Json;

namespace Nix.Features.Linear;

[SuppressMessage("Performance", "CA1812", Justification = "Created by the typed HTTP client factory.")]
internal sealed class LinearWorkerClient(HttpClient http, IConfiguration configuration)
{
    internal async Task<LinearWorkerResponse?> ExecuteAsync(LinearWorkerRequest request, CancellationToken cancellationToken)
    {
        var address = configuration["Nix:Pets:WorkerUrl"];
        var secret = configuration["Nix:InternalSecret"];
        if (string.IsNullOrWhiteSpace(secret) || !Uri.TryCreate(address, UriKind.Absolute, out var origin)
            || origin.Scheme is not ("http" or "https") || origin.AbsolutePath != "/"
            || origin.UserInfo.Length != 0 || origin.Query.Length != 0 || origin.Fragment.Length != 0)
        {
            return null;
        }

        using var outgoing = new HttpRequestMessage(HttpMethod.Post, new Uri(origin, "/v1/sani/linear"));
        outgoing.Headers.Add("X-Nix-Internal-Secret", secret);
        outgoing.Content = JsonContent.Create(request, LinearJsonContext.Default.LinearWorkerRequest);
        try
        {
            // The private protocol is finite and the named HttpClient bounds its response buffer.
            using var response = await http.SendAsync(outgoing, cancellationToken).ConfigureAwait(false);
            return response.IsSuccessStatusCode
                ? await response.Content.ReadFromJsonAsync(
                    LinearJsonContext.Default.LinearWorkerResponse, cancellationToken).ConfigureAwait(false)
                : null;
        }
        catch (Exception error) when (error is HttpRequestException or JsonException or OperationCanceledException)
        {
            return null;
        }
    }
}
