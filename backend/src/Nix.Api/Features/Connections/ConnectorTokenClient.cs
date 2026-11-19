using System.Diagnostics.CodeAnalysis;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace Nix.Features.Connections;

[SuppressMessage("Performance", "CA1812", Justification = "Created by the typed HTTP client factory.")]
internal sealed class ConnectorTokenClient(HttpClient http, IDataProtectionProvider protection, TimeProvider clock)
{
    private readonly IDataProtector _secrets = protection.CreateProtector("Nix.PetConnectors.Credential.v1");

    internal string Protect(ConnectorCredential token) =>
        _secrets.Protect(JsonSerializer.Serialize(token, ConnectorJsonContext.Default.ConnectorCredential));

    internal ConnectorCredential? Unprotect(string token)
    {
        try
        {
            return JsonSerializer.Deserialize(_secrets.Unprotect(token), ConnectorJsonContext.Default.ConnectorCredential);
        }
        catch (Exception error) when (error is CryptographicException or JsonException)
        {
            return null;
        }
    }

    internal Task<ConnectorCredential?> ExchangeAsync(ConnectorProvider provider, string code, Uri callback, string verifier, CancellationToken token)
    {
        var form = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["redirect_uri"] = callback.AbsoluteUri,
        };
        if (provider.UsePkce)
        {
            form["code_verifier"] = verifier;
        }
        return SendAsync(provider, form, previousRefresh: null, token);
    }

    internal Task<ConnectorCredential?> RefreshAsync(ConnectorProvider provider, string refresh, CancellationToken token) =>
        SendAsync(provider, new(StringComparer.Ordinal) { ["grant_type"] = "refresh_token", ["refresh_token"] = refresh }, refresh, token);

    private async Task<ConnectorCredential?> SendAsync(ConnectorProvider provider, Dictionary<string, string> form,
        string? previousRefresh, CancellationToken token)
    {
        form["client_id"] = provider.ClientId;
        form["client_secret"] = provider.ClientSecret;
        using var request = new HttpRequestMessage(HttpMethod.Post, provider.Token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Content = new FormUrlEncodedContent(form);
        try
        {
            using var response = await http.SendAsync(request, token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }
            var stream = await response.Content.ReadAsStreamAsync(token).ConfigureAwait(false);
            await using var streamDisposal = stream.ConfigureAwait(false);
            using var json = await JsonDocument.ParseAsync(stream, cancellationToken: token).ConfigureAwait(false);
            var root = json.RootElement;
            if (GetToken(root, "access_token") is not { } access)
            {
                return null;
            }
            var refresh = GetToken(root, "refresh_token") ?? previousRefresh;
            DateTimeOffset? expires = root.TryGetProperty("expires_in", out var property)
                && property.ValueKind == JsonValueKind.Number && property.TryGetInt32(out var seconds) && seconds is > 0 and <= 31_536_000
                ? clock.GetUtcNow().AddSeconds(seconds)
                : null;
            return new ConnectorCredential(access, refresh, expires);
        }
        catch (Exception error) when (error is HttpRequestException or JsonException or OperationCanceledException)
        {
            return null;
        }
    }

    private static string? GetToken(JsonElement root, string name) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var token) && token.ValueKind == JsonValueKind.String
            && token.GetString() is { Length: > 0 and <= 8192 } value && !value.Any(c => char.IsControl(c) || char.IsWhiteSpace(c))
            ? value
            : null;
}
