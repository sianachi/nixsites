using System.Net.Http.Headers;

namespace Nix.Workers.Calendar;

/// <summary>
/// The origin-locked HTTP transport both provider clients share: an exact origin, no redirects
/// (the client must be built that way), bounded bodies. A Graph nextLink or deltaLink is followed
/// only when it resolves to the same origin, never to one a token could redirect us to.
/// </summary>
public sealed class CalendarTransport
{
    /// <summary>Provider event pages are bounded to 100 events; 1 MiB is ample.</summary>
    public const int MaxResponseBytes = 1 << 20;

    private readonly HttpClient _client;

    public CalendarTransport(HttpClient client, string origin)
    {
        ArgumentNullException.ThrowIfNull(client);
        this._client = client;
        Origin = CanonicalOrigin(origin);
    }

    /// <summary>The one origin this transport talks to: scheme, host and a non-default port.</summary>
    public string Origin { get; }

    /// <summary>The canonical <c>scheme://host[:port]</c> of an origin setting, or an exception for anything with a path, query, fragment or userinfo.</summary>
    public static string CanonicalOrigin(string raw)
    {
        ArgumentNullException.ThrowIfNull(raw);
        if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var parsed)
            || string.IsNullOrEmpty(parsed.Host)
            || (parsed.Scheme != Uri.UriSchemeHttps && parsed.Scheme != Uri.UriSchemeHttp)
            || !string.IsNullOrEmpty(parsed.UserInfo)
            || !string.IsNullOrEmpty(parsed.Query)
            || !string.IsNullOrEmpty(parsed.Fragment)
            || (parsed.AbsolutePath != "/" && parsed.AbsolutePath.Length != 0))
        {
            throw new ArgumentException($"calendar provider origin \"{raw}\" is invalid", nameof(raw));
        }
        return OriginOf(parsed);
    }

    /// <summary>Sends to a path under the origin, or to an absolute URL when it is on the same origin.</summary>
    public async Task<(int Status, byte[] Body)> SendAsync(HttpMethod method, string pathOrLink, IReadOnlyDictionary<string, string> headers, string? jsonBody, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(pathOrLink);
        ArgumentNullException.ThrowIfNull(headers);
        var target = pathOrLink.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || pathOrLink.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            ? pathOrLink
            : Origin + pathOrLink;
        if (!Uri.TryCreate(target, UriKind.Absolute, out var uri) || string.IsNullOrEmpty(uri.Host) || !string.IsNullOrEmpty(uri.UserInfo))
        {
            throw new CalendarProviderException("calendar provider URL is invalid");
        }
        if (!string.Equals(OriginOf(uri), Origin, StringComparison.Ordinal))
        {
            throw new CalendarProviderException($"calendar provider URL origin \"{OriginOf(uri)}\" is not the configured origin");
        }
        using var request = new HttpRequestMessage(method, uri);
        foreach (var (name, value) in headers)
        {
            if (name == "Content-Type")
            {
                continue;
            }
            request.Headers.TryAddWithoutValidation(name, value);
        }
        if (jsonBody is not null)
        {
            request.Content = new StringContent(jsonBody, System.Text.Encoding.UTF8);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        }
        HttpResponseMessage response;
        try
        {
            response = await _client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        }
        catch (HttpRequestException exception)
        {
            throw new CalendarProviderException("calendar provider request failed: " + exception.Message, exception);
        }
        using (response)
        {
            var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            await using (stream.ConfigureAwait(false))
            {
                using var buffer = new MemoryStream();
                var chunk = new byte[16 * 1024]; // byte[]: Stream.ReadAsync copies through a fixed buffer into the bounded MemoryStream
                while (true)
                {
                    var read = await stream.ReadAsync(chunk, cancellationToken).ConfigureAwait(false);
                    if (read == 0)
                    {
                        break;
                    }
                    if (buffer.Length + read > MaxResponseBytes)
                    {
                        throw new CalendarProviderException("calendar provider response exceeds its size limit");
                    }
                    await buffer.WriteAsync(chunk.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
                }
                return ((int)response.StatusCode, buffer.ToArray());
            }
        }
    }

    /// <summary>The bearer headers every provider call carries.</summary>
    public static Dictionary<string, string> BearerHeaders(string accessToken, bool json = false)
    {
        var headers = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["Authorization"] = "Bearer " + accessToken,
            ["Accept"] = "application/json",
        };
        if (json)
        {
            headers["Content-Type"] = "application/json";
        }
        return headers;
    }

    // Uri already lower-cases the scheme and a DNS host.
    private static string OriginOf(Uri uri) =>
        uri.IsDefaultPort ? $"{uri.Scheme}://{uri.Host}" : $"{uri.Scheme}://{uri.Host}:{uri.Port}";
}
