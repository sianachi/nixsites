using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Nix.Http;

namespace Nix.Persistence.ObjectStorage;

/// <summary>Issues bounded path-style AWS Signature Version 4 object capabilities.</summary>
/// <remarks>
/// Core signs locations but never opens them. Clients and workers transfer bytes directly to the
/// private object store, keeping request memory and file contents outside the authorization tier.
/// </remarks>
public sealed class S3CapabilitySigner
{
    private const int MaximumKeyLength = 1024;
    private static readonly TimeSpan CleanupClockSkewGrace = TimeSpan.FromMinutes(1);
    private readonly ObjectStorageOptions _options;
    private readonly TimeProvider _clock;

    /// <summary>Initializes and validates the signer. An entirely empty configuration disables it.</summary>
    public S3CapabilitySigner(ObjectStorageOptions options, TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(clock);
        Validate(options);
        _options = options;
        _clock = clock;
    }

    /// <summary>Whether an object store was configured for this host.</summary>
    public bool IsConfigured => _options.Endpoint is not null;

    /// <summary>
    /// Returns the earliest safe time to delete a staging object after an operation becomes
    /// terminal. Waiting through the entire capability lifetime prevents an already-issued PUT
    /// from recreating the object after cleanup; the grace covers bounded clock skew at the store.
    /// </summary>
    public DateTimeOffset GetCleanupNotBefore() =>
        _clock.GetUtcNow().AddSeconds(_options.CapabilitySeconds).Add(CleanupClockSkewGrace);

    /// <summary>Signs an upload capability.</summary>
    public ObjectCapability Put(string key) => Sign("PUT", key);

    /// <summary>
    /// Signs an upload whose HTTP body must have the declared byte length and be stored as
    /// <c>application/octet-stream</c>, so an uploader cannot choose the object's served type.
    /// </summary>
    public ObjectCapability PutSized(string key, long byteLength)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(byteLength);
        return Sign(
            "PUT",
            key,
            requestHeaders: new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["content-length"] = byteLength.ToString(CultureInfo.InvariantCulture),
                ["content-type"] = "application/octet-stream",
            });
    }

    /// <summary>Signs a create-only upload for an immutable published object.</summary>
    public ObjectCapability PutImmutable(string key, long byteLength)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(byteLength);
        return Sign(
            "PUT",
            key,
            requestHeaders: new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["content-length"] = byteLength.ToString(CultureInfo.InvariantCulture),
                ["if-none-match"] = "*",
            });
    }

    /// <summary>Signs an immutable upload whose bytes object storage verifies by SHA-256.</summary>
    public ObjectCapability PutImmutableVerified(string key, long byteLength, string sha256) =>
        SignVerifiedPut(key, byteLength, sha256, createOnly: true);

    /// <summary>
    /// Signs an upload whose bytes object storage verifies by SHA-256 and that may replace an
    /// existing object, for the few mutable keys (a site's host manifest) whose content Core
    /// decides byte for byte.
    /// </summary>
    public ObjectCapability PutVerified(string key, long byteLength, string sha256) =>
        SignVerifiedPut(key, byteLength, sha256, createOnly: false);

    /// <summary>Signs a read capability.</summary>
    public ObjectCapability Get(string key) => Sign("GET", key, null);

    /// <summary>Signs an authorized browser download or bounded inline image preview.</summary>
    public ObjectCapability GetForBrowser(
        string key,
        string fileName,
        string mediaType,
        bool inline)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(fileName);
        ArgumentException.ThrowIfNullOrWhiteSpace(mediaType);
        var disposition = inline ? "inline" : "attachment";
        var asciiName = new string(fileName.Select(character =>
            character is >= (char)0x20 and <= (char)0x7e && character is not '"' and not '\\'
                ? character
                : '_').ToArray());
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["response-content-disposition"] = $"{disposition}; filename=\"{asciiName}\"; filename*=UTF-8''{Encode(fileName)}",
            ["response-content-type"] = inline ? mediaType : "application/octet-stream",
            ["response-cache-control"] = "private, max-age=300",
        };
        return Sign("GET", key, parameters);
    }

    /// <summary>Signs a cleanup capability.</summary>
    public ObjectCapability Delete(string key) => Sign("DELETE", key, null);

    private ObjectCapability SignVerifiedPut(string key, long byteLength, string sha256, bool createOnly)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(byteLength);
        if (sha256 is not { Length: 64 } || sha256.Any(character => !char.IsAsciiHexDigit(character)))
        {
            throw new ArgumentException("The object checksum must be a SHA-256 hex digest.", nameof(sha256));
        }
        var headers = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["content-length"] = byteLength.ToString(CultureInfo.InvariantCulture),
            ["x-amz-checksum-sha256"] = Convert.ToBase64String(Convert.FromHexString(sha256)),
        };
        if (createOnly)
        {
            headers["if-none-match"] = "*";
        }
        return Sign("PUT", key, requestHeaders: headers);
    }

    private ObjectCapability Sign(
        string method,
        string key,
        IReadOnlyDictionary<string, string>? responseParameters = null,
        IReadOnlyDictionary<string, string>? requestHeaders = null)
    {
        if (_options.Endpoint is null)
        {
            throw new InvalidOperationException("Private object storage is not configured.");
        }

        ValidateKey(key);
        var now = _clock.GetUtcNow().ToUniversalTime();
        var timestamp = now.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture);
        var day = timestamp[..8];
        var scope = $"{day}/{_options.Region}/s3/aws4_request";
        var canonicalPath = CanonicalPath(_options.Endpoint, _options.Bucket, key);
        var publicOrigin = _options.PublicOrigin ?? _options.Endpoint;
        var headers = new SortedDictionary<string, string>(StringComparer.Ordinal)
        {
            ["host"] = publicOrigin.Authority,
        };
        if (requestHeaders is not null)
        {
            foreach (var pair in requestHeaders)
            {
                var name = pair.Key;
                if (name == "host"
                    || name.Any(character => character is >= 'A' and <= 'Z')
                    || pair.Value.Contains('\n', StringComparison.Ordinal))
                {
                    throw new ArgumentException("A signed object header is invalid.", nameof(requestHeaders));
                }
                headers.Add(name, pair.Value.Trim());
            }
        }
        var signedHeaders = string.Join(';', headers.Keys);
        var parameters = new SortedDictionary<string, string>(StringComparer.Ordinal)
        {
            ["X-Amz-Algorithm"] = "AWS4-HMAC-SHA256",
            ["X-Amz-Credential"] = $"{_options.AccessKey}/{scope}",
            ["X-Amz-Date"] = timestamp,
            ["X-Amz-Expires"] = _options.CapabilitySeconds.ToString(CultureInfo.InvariantCulture),
            ["X-Amz-SignedHeaders"] = signedHeaders,
        };
        if (responseParameters is not null)
        {
            foreach (var pair in responseParameters)
            {
                parameters.Add(pair.Key, pair.Value);
            }
        }
        var canonicalQuery = CanonicalQuery(parameters);
        var canonicalHeaders = string.Concat(headers.Select(pair => $"{pair.Key}:{pair.Value}\n"));
        var canonicalRequest = string.Join(
            '\n',
            method,
            canonicalPath,
            canonicalQuery,
            canonicalHeaders,
            signedHeaders,
            "UNSIGNED-PAYLOAD");
        var canonicalDigest = SHA256.HashData(Encoding.UTF8.GetBytes(canonicalRequest)); // byte[]: required by the cryptographic hash API.
        var stringToSign = string.Join(
            '\n',
            "AWS4-HMAC-SHA256",
            timestamp,
            scope,
            Convert.ToHexStringLower(canonicalDigest));

        var initialKey = Encoding.UTF8.GetBytes("AWS4" + _options.SecretKey); // byte[]: required by the cryptographic HMAC API.
        var dateKey = HMACSHA256.HashData(initialKey, Encoding.UTF8.GetBytes(day)); // byte[]: bounded signing inputs for the cryptographic API.
        var regionKey = HMACSHA256.HashData(dateKey, Encoding.UTF8.GetBytes(_options.Region)); // byte[]: bounded signing inputs for the cryptographic API.
        var serviceKey = HMACSHA256.HashData(regionKey, "s3"u8); // byte[]: cryptographic digest passed to the next HMAC round.
        var signingKey = HMACSHA256.HashData(serviceKey, "aws4_request"u8); // byte[]: cryptographic digest passed to the final HMAC round.
        var signature = HMACSHA256.HashData(signingKey, Encoding.UTF8.GetBytes(stringToSign)); // byte[]: required by the cryptographic HMAC API.
        parameters["X-Amz-Signature"] = Convert.ToHexStringLower(signature);

        var baseUri = publicOrigin.GetLeftPart(UriPartial.Authority).TrimEnd('/');
        var endpointPath = _options.Endpoint.AbsolutePath.TrimEnd('/');
        var url = $"{baseUri}{endpointPath}{canonicalPath[(endpointPath.Length == 0 ? 0 : endpointPath.Length)..]}?{CanonicalQuery(parameters)}";
        return new ObjectCapability(new Uri(url, UriKind.Absolute), now.AddSeconds(_options.CapabilitySeconds));
    }

    private static string CanonicalPath(Uri endpoint, string bucket, string key)
    {
        var parts = new List<string>();
        foreach (var segment in endpoint.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            parts.Add(Encode(Uri.UnescapeDataString(segment)));
        }
        parts.Add(Encode(bucket));
        foreach (var segment in key.Split('/'))
        {
            parts.Add(Encode(segment));
        }
        return "/" + string.Join('/', parts);
    }

    private static string CanonicalQuery(IEnumerable<KeyValuePair<string, string>> parameters) =>
        string.Join('&', parameters.Select(pair => $"{Encode(pair.Key)}={Encode(pair.Value)}"));

    private static string Encode(string value) => Uri.EscapeDataString(value)
        .Replace("%7E", "~", StringComparison.OrdinalIgnoreCase);

    private static void Validate(ObjectStorageOptions options)
    {
        var any = options.Endpoint is not null
            || options.PublicOrigin is not null
            || !string.IsNullOrWhiteSpace(options.Region)
            || !string.IsNullOrWhiteSpace(options.Bucket)
            || !string.IsNullOrWhiteSpace(options.AccessKey)
            || !string.IsNullOrWhiteSpace(options.SecretKey);
        if (!any)
        {
            return;
        }
        if (options.Endpoint is null
            || string.IsNullOrWhiteSpace(options.Region)
            || string.IsNullOrWhiteSpace(options.Bucket)
            || string.IsNullOrWhiteSpace(options.AccessKey)
            || string.IsNullOrWhiteSpace(options.SecretKey))
        {
            throw new InvalidOperationException("Nix:ObjectStorage must be configured completely or omitted.");
        }
        if (!options.Endpoint.IsAbsoluteUri
            || options.Endpoint.Scheme is not ("http" or "https")
            || !string.IsNullOrEmpty(options.Endpoint.Query)
            || !string.IsNullOrEmpty(options.Endpoint.Fragment)
            || !string.IsNullOrEmpty(options.Endpoint.UserInfo))
        {
            throw new InvalidOperationException("Nix:ObjectStorage:Endpoint must be an absolute HTTP endpoint without credentials, query, or fragment.");
        }
        if (options.Endpoint.Scheme == "http" && !options.Endpoint.IsLocal())
        {
            throw new InvalidOperationException("Nix:ObjectStorage:Endpoint must use HTTPS outside loopback development.");
        }
        if (options.PublicOrigin is not null)
        {
            if (!options.PublicOrigin.IsAbsoluteUri
                || options.PublicOrigin.OriginalString.Length > 2048
                || options.PublicOrigin.OriginalString != options.PublicOrigin.OriginalString.Trim()
                || options.PublicOrigin.Scheme is not ("http" or "https")
                || !string.IsNullOrEmpty(options.PublicOrigin.UserInfo)
                || !string.IsNullOrEmpty(options.PublicOrigin.Query)
                || !string.IsNullOrEmpty(options.PublicOrigin.Fragment)
                || options.PublicOrigin.AbsolutePath != "/")
            {
                throw new InvalidOperationException("Nix:ObjectStorage:PublicOrigin must be an absolute HTTP origin without credentials, path, query, or fragment.");
            }
            if (options.PublicOrigin.Scheme == "http" && !options.PublicOrigin.IsLocal())
            {
                throw new InvalidOperationException("Nix:ObjectStorage:PublicOrigin must use HTTPS outside loopback development.");
            }
        }
        if (options.Region.Length > 64
            || options.Bucket.Length is < 3 or > 63
            || options.Bucket.Any(character => !(char.IsAsciiLetterOrDigit(character) || character is '-' or '.'))
            || options.AccessKey.Length > 128
            || options.SecretKey.Length > 256
            || options.CapabilitySeconds is < 1 or > 900)
        {
            throw new InvalidOperationException("Nix:ObjectStorage contains a value outside its supported bounds.");
        }
    }

    private static void ValidateKey(string key)
    {
        if (string.IsNullOrWhiteSpace(key)
            || key.Length > MaximumKeyLength
            || key[0] == '/'
            || key[^1] == '/'
            || key.Contains('\\', StringComparison.Ordinal)
            || key.Any(char.IsControl)
            || key.Split('/').Any(segment => segment.Length == 0 || segment is "." or ".."))
        {
            throw new ArgumentException("The object key is unsafe.", nameof(key));
        }
    }
}

/// <summary>A short-lived, method-bound URL for one private object.</summary>
public sealed record ObjectCapability(Uri Url, DateTimeOffset ExpiresAt);
