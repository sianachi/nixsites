using System.Security.Cryptography;

namespace Nix.Workers.Transfer;

/// <summary>A capability-URL transfer was refused or failed; the message names the operation, never the URL.</summary>
public sealed class ObjectTransferException : Exception
{
    public ObjectTransferException(string message)
        : base(message)
    {
    }

    public ObjectTransferException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    public ObjectTransferException()
    {
    }

    /// <summary>The destination already holds an object (create-only upload).</summary>
    public bool AlreadyExists { get; init; }

    /// <summary>The capability target does not exist.</summary>
    public bool NotFound { get; init; }

    /// <summary>The source is larger than the caller allowed.</summary>
    public bool TooLarge { get; init; }
}

/// <summary>A download in progress: a bounded body and the digest of everything read from it.</summary>
public sealed class ObjectDownload(Stream body, IncrementalHash digest) : IAsyncDisposable
{
    public Stream Body { get; } = body;

    /// <summary>The SHA-256 of the bytes read so far, lower-case hex.</summary>
    public string DigestHex() => Convert.ToHexStringLower(digest.GetCurrentHash());

    public async ValueTask DisposeAsync()
    {
        await Body.DisposeAsync().ConfigureAwait(false);
        digest.Dispose();
    }
}

/// <summary>
/// Moves bytes through short-lived capability URLs the way the Go <c>objecttransfer</c> client
/// did: an exact origin allowlist (loopback when empty), no redirects, bounded bodies, create-only
/// uploads with a storage checksum, and a digest kept on every download.
/// </summary>
public sealed class ObjectTransfer
{
    private static readonly string[] LoopbackHosts = ["localhost", "127.0.0.1", "::1", "[::1]"];
    private readonly HttpClient client;
    private readonly HashSet<string> allowedOrigins;

    /// <param name="client">A client with redirects disabled.</param>
    /// <param name="origins">The exact origins capability URLs may name; empty allows loopback only.</param>
    public ObjectTransfer(HttpClient client, IEnumerable<string> origins)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(origins);
        this.client = client;
        allowedOrigins = new HashSet<string>(StringComparer.Ordinal);
        foreach (var origin in origins)
        {
            if (TryCanonicalOrigin(origin, out var canonical))
            {
                allowedOrigins.Add(canonical);
            }
        }
    }

    public Task<ObjectDownload> DownloadAsync(Uri url, long maxBytes, CancellationToken cancellationToken) =>
        DownloadAsync(url, maxBytes, null, null, cancellationToken);

    /// <summary>A download that carries a forwarded bearer and the internal secret (the collab export bundle).</summary>
    public async Task<ObjectDownload> DownloadAsync(Uri url, long maxBytes, string? bearerToken, string? internalSecret, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(url);
        if (maxBytes <= 0)
        {
            throw new ArgumentException("download byte limit must be positive", nameof(maxBytes));
        }
        if (bearerToken is not null && (string.IsNullOrWhiteSpace(bearerToken) || string.IsNullOrWhiteSpace(internalSecret) || (bearerToken + internalSecret).IndexOfAny(['\r', '\n']) >= 0))
        {
            throw new ObjectTransferException("authorized download credentials are invalid");
        }
        Validate(url);
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        if (bearerToken is not null)
        {
            request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + bearerToken);
            request.Headers.TryAddWithoutValidation("X-Nix-Internal-Secret", internalSecret);
        }
        HttpResponseMessage response;
        try
        {
            response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        }
        catch (HttpRequestException exception)
        {
            throw new ObjectTransferException("source download failed", exception);
        }
        if (!response.IsSuccessStatusCode)
        {
            var status = (int)response.StatusCode;
            response.Dispose();
            throw new ObjectTransferException($"source download returned {status}") { NotFound = status == 404 };
        }
        if (response.Content.Headers.ContentLength is > 0 and var length && length > maxBytes)
        {
            response.Dispose();
            throw new ObjectTransferException("source object exceeds the configured byte limit") { TooLarge = true };
        }
#pragma warning disable CA2000 // Justification: the download owns the digest and the stream and disposes both.
        var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var body = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        return new ObjectDownload(new BoundedDigestStream(body, response, digest, maxBytes), digest);
#pragma warning restore CA2000
    }

    /// <summary>A create-only PUT (<c>If-None-Match: *</c>) carrying the SHA-256 both as the Nix header and the storage checksum.</summary>
    public async Task UploadCreateOnlyAsync(Uri url, string contentType, Stream body, long size, string sha256Hex, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(url);
        ArgumentNullException.ThrowIfNull(body);
        ArgumentNullException.ThrowIfNull(sha256Hex);
        if (size < 0)
        {
            throw new ArgumentException("upload size must be known", nameof(size));
        }
        Validate(url);
        byte[] checksum;
        try
        {
            checksum = Convert.FromHexString(sha256Hex);
        }
        catch (FormatException)
        {
            throw new ObjectTransferException("destination checksum is invalid");
        }
        if (checksum.Length != 32)
        {
            throw new ObjectTransferException("destination checksum is invalid");
        }
        using var request = new HttpRequestMessage(HttpMethod.Put, url);
        request.Content = new StreamContent(body);
        request.Content.Headers.ContentLength = size;
        request.Content.Headers.TryAddWithoutValidation("Content-Type", contentType);
        request.Headers.TryAddWithoutValidation("If-None-Match", "*");
        request.Headers.TryAddWithoutValidation("X-Nix-Content-SHA256", Convert.ToHexStringLower(checksum));
        request.Headers.TryAddWithoutValidation("X-Amz-Checksum-Sha256", Convert.ToBase64String(checksum));
        HttpResponseMessage response;
        try
        {
            response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
        }
        catch (HttpRequestException exception)
        {
            throw new ObjectTransferException("destination upload failed", exception);
        }
        using (response)
        {
            var status = (int)response.StatusCode;
            if (status is 409 or 412)
            {
                throw new ObjectTransferException("destination object already exists") { AlreadyExists = true };
            }
            if (!response.IsSuccessStatusCode)
            {
                throw new ObjectTransferException($"destination upload returned {status}");
            }
        }
    }

    public async Task DeleteAsync(Uri url, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(url);
        Validate(url);
        using var request = new HttpRequestMessage(HttpMethod.Delete, url);
        HttpResponseMessage response;
        try
        {
            response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
        }
        catch (HttpRequestException exception)
        {
            throw new ObjectTransferException("object deletion failed", exception);
        }
        using (response)
        {
            if (!response.IsSuccessStatusCode && (int)response.StatusCode != 404)
            {
                throw new ObjectTransferException($"object deletion returned {(int)response.StatusCode}");
            }
        }
    }

    public void Validate(Uri url)
    {
        ArgumentNullException.ThrowIfNull(url);
        if (!url.IsAbsoluteUri || string.IsNullOrEmpty(url.Host) || (url.Scheme != Uri.UriSchemeHttps && url.Scheme != Uri.UriSchemeHttp) || !string.IsNullOrEmpty(url.UserInfo))
        {
            throw new ObjectTransferException("object capability URL is invalid");
        }
        if (!string.IsNullOrEmpty(url.Fragment))
        {
            throw new ObjectTransferException("object capability URL must not contain a fragment");
        }
        var origin = OriginOf(url);
        if (allowedOrigins.Count == 0)
        {
            if (!IsLoopback(url.Host))
            {
                throw new ObjectTransferException("object capability origin is not allowed");
            }
            return;
        }
        if (!allowedOrigins.Contains(origin))
        {
            throw new ObjectTransferException("object capability origin is not allowed");
        }
    }

    public static bool TryCanonicalOrigin(string raw, out string origin)
    {
        origin = string.Empty;
        if (!Uri.TryCreate(raw?.Trim(), UriKind.Absolute, out var parsed) || string.IsNullOrEmpty(parsed.Host)
            || (parsed.Scheme != Uri.UriSchemeHttps && parsed.Scheme != Uri.UriSchemeHttp) || !string.IsNullOrEmpty(parsed.UserInfo)
            || !string.IsNullOrEmpty(parsed.Query) || !string.IsNullOrEmpty(parsed.Fragment) || (parsed.AbsolutePath != "/" && parsed.AbsolutePath.Length != 0))
        {
            return false;
        }
        origin = OriginOf(parsed);
        return true;
    }

    private static string OriginOf(Uri uri) => uri.IsDefaultPort ? $"{uri.Scheme}://{uri.Host}" : $"{uri.Scheme}://{uri.Host}:{uri.Port}";

    private static bool IsLoopback(string host)
    {
        host = host.TrimEnd('.');
        return LoopbackHosts.Any(candidate => string.Equals(host, candidate, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Reads at most the allowed bytes, hashing them, and fails once more arrive.</summary>
    private sealed class BoundedDigestStream(Stream inner, HttpResponseMessage response, IncrementalHash digest, long maximum) : Stream
    {
        private long remaining = maximum;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            var read = await inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read > remaining)
            {
                remaining = 0;
                throw new ObjectTransferException("source object exceeds the configured byte limit") { TooLarge = true };
            }
            remaining -= read;
            digest.AppendData(buffer.Span[..read]);
            return read;
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                inner.Dispose();
                response.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
