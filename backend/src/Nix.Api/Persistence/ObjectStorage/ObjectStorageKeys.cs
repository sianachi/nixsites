using System.Security.Cryptography;
using System.Text;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Sites;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.ObjectStorage;

/// <summary>Stable private-object names; upload staging and immutable versions never share a key.</summary>
public static class ObjectStorageKeys
{
    private const string FileVersionPrefix = "files/versions/";
    private const string FileThumbnailPrefix = "files/thumbnails/";

    public static string FileUpload(TenantId tenantId, FileUploadId uploadId) =>
        $"files/uploads/{tenantId}/{uploadId}";

    public static string FileVersion(TenantId tenantId, FileVersionId versionId) =>
        $"files/versions/{tenantId}/{versionId}";

    public static string FileVersion(TenantId tenantId, FileUploadId uploadId) =>
        $"files/versions/{tenantId}/{uploadId}";

    /// <summary>
    /// The key of the JPEG thumbnail derived from one file version's object, which is the only place
    /// that rule exists in Core.
    /// </summary>
    /// <remarks>
    /// The worker never derives or sees this key: Core signs the upload capability for it, so the
    /// two sides cannot disagree. The key is a function of the version key alone, lives under its own
    /// prefix and ends in <c>.jpg</c>, so it cannot equal any user-visible object key (all of which
    /// are server-assigned) and a file's thumbnail is found, and deleted, from the file's own key.
    /// </remarks>
    public static string FileThumbnail(string versionObjectKey)
    {
        ArgumentNullException.ThrowIfNull(versionObjectKey);
        if (!versionObjectKey.StartsWith(FileVersionPrefix, StringComparison.Ordinal))
        {
            throw new ArgumentException("A thumbnail is derived only from a file version key.", nameof(versionObjectKey));
        }

        return string.Concat(FileThumbnailPrefix, versionObjectKey.AsSpan(FileVersionPrefix.Length), ".jpg");
    }

    /// <summary>
    /// Derives the thumbnail key when <paramref name="objectKey"/> is a file version key, and says
    /// no for any other key. For bulk cleanup, which sees every kind of key.
    /// </summary>
    public static bool TryFileThumbnail(string objectKey, out string thumbnailKey)
    {
        ArgumentNullException.ThrowIfNull(objectKey);
        if (objectKey.StartsWith(FileVersionPrefix, StringComparison.Ordinal))
        {
            thumbnailKey = FileThumbnail(objectKey);
            return true;
        }

        thumbnailKey = string.Empty;
        return false;
    }

    /// <summary>The thumbnail key for the file version a completed upload will publish.</summary>
    public static string FileThumbnail(TenantId tenantId, FileUploadId uploadId) =>
        FileThumbnail(FileVersion(tenantId, uploadId));

    public static string ImportPlan(TenantId tenantId, DocumentImportId importId) =>
        $"imports/plans/{tenantId}/{importId}.json";

    public static Guid ExportAttempt(Guid exportId, string executionId)
    {
        if (exportId == Guid.Empty
            || string.IsNullOrWhiteSpace(executionId)
            || executionId.Length > 128
            || executionId.Any(char.IsControl))
        {
            throw new ArgumentException("The export execution identity is invalid.");
        }

        Span<byte> source = stackalloc byte[16 + (128 * 4)];
        if (!exportId.TryWriteBytes(source[..16]))
        {
            throw new InvalidOperationException("The export identity could not be encoded.");
        }
        var written = Encoding.UTF8.GetBytes(executionId, source[16..]);
        Span<byte> digest = stackalloc byte[SHA256.HashSizeInBytes];
        SHA256.HashData(source[..(16 + written)], digest);
        return new Guid(digest[..16]);
    }

    public static string ExportResult(
        TenantId tenantId,
        Guid exportId,
        Guid attemptId,
        string extension)
    {
        if (exportId == Guid.Empty
            || attemptId == Guid.Empty
            || string.IsNullOrWhiteSpace(extension)
            || extension.Length > 16
            || extension.Any(character => !char.IsAsciiDigit(character)
                && character is not (>= 'a' and <= 'z')))
        {
            throw new ArgumentException("The export object identity is invalid.");
        }

        return $"exports/results/{tenantId}/{exportId:D}/{attemptId:D}.{extension}";
    }

    /// <summary>The prefix every object of one build lives under, in the sites bucket.</summary>
    public static string SiteBuildPrefix(Guid siteId, Guid buildId)
    {
        RequireIdentity(siteId, buildId);
        return $"sites/{siteId:D}/builds/{buildId:D}/";
    }

    /// <summary>The prefix the content-addressed images of one site live under, shared by its builds.</summary>
    public static string SiteAssetsPrefix(Guid siteId)
    {
        RequireIdentity(siteId, siteId);
        return $"sites/{siteId:D}/assets/";
    }

    /// <summary>
    /// The key of one file of a build. The path is the worker's, so it is validated here and not
    /// trusted: relative, at most eight segments, each beginning with a letter, digit or underscore.
    /// </summary>
    public static string SiteBuild(Guid siteId, Guid buildId, string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        var segments = path.Split('/');
        if (path.Length > 400 || segments.Length > 8 || !segments.All(IsSiteSegment))
        {
            throw new ArgumentException("The site file path is invalid.", nameof(path));
        }

        return SiteBuildPrefix(siteId, buildId) + path;
    }

    /// <summary>The key of one content-addressed image of a site.</summary>
    public static string SiteAsset(Guid siteId, string sha256, string extension)
    {
        ArgumentNullException.ThrowIfNull(sha256);
        ArgumentNullException.ThrowIfNull(extension);
        if (!SiteRules.IsSha256(sha256) || extension is not ("png" or "jpg" or "webp" or "svg" or "pdf" or "txt" or "csv" or "mp4" or "webm"))
        {
            throw new ArgumentException("The site asset identity is invalid.");
        }

        return $"{SiteAssetsPrefix(siteId)}{sha256}.{extension}";
    }

    /// <summary>The key of the host manifest that maps one hostname to a build.</summary>
    public static string SiteHost(string hostname)
    {
        if (!SiteRules.IsHostname(hostname))
        {
            throw new ArgumentException("The site hostname is invalid.", nameof(hostname));
        }

        return SiteRules.HostKey(hostname);
    }

    private static void RequireIdentity(Guid first, Guid second)
    {
        if (first == Guid.Empty || second == Guid.Empty)
        {
            throw new ArgumentException("The site object identity is invalid.");
        }
    }

    private static bool IsSiteSegment(string segment) =>
        segment.Length is > 0 and <= 100
        && (char.IsAsciiLetterOrDigit(segment[0]) || segment[0] == '_')
        && segment.All(character => char.IsAsciiLetterOrDigit(character) || character is '_' or '.' or '~' or '-');

    public static bool BelongsTo(TenantId tenantId, string key)
    {
        if (string.IsNullOrWhiteSpace(key) || key.Length > 1024)
        {
            return false;
        }
        var tenant = tenantId.ToString();
        return key.StartsWith($"files/uploads/{tenant}/", StringComparison.Ordinal)
            || key.StartsWith($"files/versions/{tenant}/", StringComparison.Ordinal)
            || key.StartsWith($"files/thumbnails/{tenant}/", StringComparison.Ordinal)
            || key.StartsWith($"imports/plans/{tenant}/", StringComparison.Ordinal)
            || key.StartsWith($"exports/results/{tenant}/", StringComparison.Ordinal);
    }
}
