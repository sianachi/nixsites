namespace Nix.Workers.Push;

/// <summary>
/// Sends already-encrypted Web Push messages to the push services browsers subscribe through.
/// An endpoint is attacker-chosen input, so this client only talks to a short allowlist of known
/// push-service origins: HTTPS only, no redirects, a bounded timeout, a bounded response read.
/// </summary>
public sealed class PushTransport : IDisposable
{
    /// <summary>The exact push-service hosts Nix subscribes to; <c>*.notify.windows.com</c> is matched by suffix.</summary>
    public static readonly IReadOnlySet<string> AllowedHosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "fcm.googleapis.com",
        "updates.push.services.mozilla.com",
        "web.push.apple.com",
    };

    private const string NotifyWindowsSuffix = ".notify.windows.com";
    private const int MaxResponseBodyBytes = 4 * 1024;
    private readonly HttpClient _httpClient;

    public PushTransport(TimeSpan timeout)
        : this(CreateClient(timeout))
    {
    }

    /// <summary>For tests: a client whose handler is a fake push service. Redirects must already be disabled on it.</summary>
    public PushTransport(HttpClient httpClient)
    {
        ArgumentNullException.ThrowIfNull(httpClient);
        this._httpClient = httpClient;
    }

    /// <summary>Whether <paramref name="endpoint"/> is an HTTPS URL on an allowed push-service host, with no userinfo or fragment.</summary>
    public static bool IsAllowedEndpoint(string endpoint)
    {
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var parsed)
            || parsed.Scheme != Uri.UriSchemeHttps
            || string.IsNullOrEmpty(parsed.Host)
            || !string.IsNullOrEmpty(parsed.UserInfo)
            || !string.IsNullOrEmpty(parsed.Fragment))
        {
            return false;
        }
        var host = parsed.Host;
        return AllowedHosts.Contains(host)
            || (host.EndsWith(NotifyWindowsSuffix, StringComparison.OrdinalIgnoreCase) && host.Length > NotifyWindowsSuffix.Length);
    }

    /// <summary>
    /// POSTs <paramref name="body"/> to <paramref name="endpoint"/> and returns the push service's
    /// status code. The response body is discarded after a bounded read; nothing acts on it.
    /// </summary>
    /// <exception cref="ArgumentException">The endpoint is not an allowed push-service URL.</exception>
    public async Task<int> SendAsync(string endpoint, IReadOnlyDictionary<string, string> headers, byte[] body, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(headers);
        ArgumentNullException.ThrowIfNull(body);
        if (!IsAllowedEndpoint(endpoint))
        {
            throw new ArgumentException("push endpoint origin is not allowed", nameof(endpoint));
        }
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(endpoint));
        request.Content = new ByteArrayContent(body);
        foreach (var (name, value) in headers)
        {
            if (!request.Headers.TryAddWithoutValidation(name, value))
            {
                request.Content.Headers.TryAddWithoutValidation(name, value);
            }
        }
        using var response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        await using (stream.ConfigureAwait(false))
        {
            var discard = new byte[MaxResponseBodyBytes]; // byte[]: Stream.ReadAsync drains into a small fixed buffer
            var remaining = MaxResponseBodyBytes;
            while (remaining > 0)
            {
                var read = await stream.ReadAsync(discard.AsMemory(0, remaining), cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    break;
                }
                remaining -= read;
            }
        }
        return (int)response.StatusCode;
    }

    public void Dispose() => _httpClient.Dispose();

#pragma warning disable CA2000 // Justification: the client owns the handler (disposeHandler: true) and is disposed with this transport.
    private static HttpClient CreateClient(TimeSpan timeout) => new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        AutomaticDecompression = System.Net.DecompressionMethods.None,
        ConnectTimeout = timeout,
        PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30),
    }, disposeHandler: true)
    { Timeout = timeout };
#pragma warning restore CA2000
}
