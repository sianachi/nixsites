using System.Security.Cryptography;
using Nix.Workers.Import;
using Nix.Workers.Transfer;

namespace Nix.Workers;

/// <summary>Helpers the import-family handlers share: Core failure classification, spool downloads, identity checks.</summary>
internal static class ImportSupport
{
    /// <summary>The page size every file-transfer plan is read with.</summary>
    public const int PlanPageLimit = 100;

    /// <summary>The Go <c>broker.IsCanonicalUUID</c>: lower-case, hyphenated, not the nil UUID.</summary>
    public static bool IsCanonicalUuid(string? value) =>
        value is { Length: 36 } && Guid.TryParseExact(value, "D", out var parsed) && parsed != Guid.Empty && value == parsed.ToString("D");

    public static bool IsSha256Hex(string? value) => value is { Length: 64 } && value.All(Uri.IsHexDigit);

    /// <summary>
    /// How the Go handlers read a Core refusal: a 409 means the lease was lost (the result will
    /// be fenced anyway) or a domain conflict, both retried; any other 4xx is a permanent
    /// failure; 5xx and transport faults are retried. <paramref name="retryTooManyRequests"/>
    /// treats 429 as transient (the template file copier did).
    /// </summary>
    public static WorkerJobException ApiFailure(string code, Exception exception, bool retryTooManyRequests = false)
    {
        if (exception is WorkerJobException typed)
        {
            return typed;
        }
        if (exception is WorkerLoopbackException { Status: var status } && status < 500 && status != 409 && !(retryTooManyRequests && status == 429))
        {
            return WorkerJobException.Fail(code, exception.Message);
        }
        return WorkerJobException.Retry(code, exception.Message);
    }

    /// <summary>Whether a failure should be reported as is: a retryable fault or a lost lease.</summary>
    public static bool RetryableOrLeaseLost(Exception exception) =>
        exception is WorkerJobException { Retryable: true } or WorkerLoopbackException { Status: 409 };

    /// <summary>A capability download spooled to disk, with its size and digest.</summary>
    public sealed record LocalObject(string Path, long Size, string Sha256) : IDisposable
    {
        public void Dispose()
        {
            try
            {
                File.Delete(Path);
            }
            catch (IOException)
            {
                // The sweep removes what a busy file left behind.
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    /// <summary>Downloads a capability URL into a spool file bounded to <paramref name="maximum"/> bytes.</summary>
    public static async Task<LocalObject> DownloadAsync(ObjectTransfer transfer, Uri url, long maximum, string? spoolRoot, string prefix, CancellationToken cancellationToken)
    {
        var download = await transfer.DownloadAsync(url, maximum, cancellationToken).ConfigureAwait(false);
        await using (download.ConfigureAwait(false))
        {
            var path = WorkSpool.Create(spoolRoot, prefix);
            try
            {
                long written;
                var file = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.None, 64 * 1024, FileOptions.Asynchronous);
                await using (file.ConfigureAwait(false))
                {
                    await download.Body.CopyToAsync(file, cancellationToken).ConfigureAwait(false);
                    written = file.Length;
                }
                return new LocalObject(path, written, download.DigestHex());
            }
            catch
            {
                File.Delete(path);
                throw;
            }
        }
    }

    /// <summary>Reads a capability target fully and checks its length and digest; <c>NotFound</c> surfaces as such.</summary>
    public static async Task VerifyObjectAsync(ObjectTransfer transfer, Uri url, long expectedLength, string expectedDigest, CancellationToken cancellationToken)
    {
        var download = await transfer.DownloadAsync(url, Math.Max(expectedLength, 1), cancellationToken).ConfigureAwait(false);
        await using (download.ConfigureAwait(false))
        {
            var count = await DrainAsync(download.Body, cancellationToken).ConfigureAwait(false);
            if (count != expectedLength || !string.Equals(download.DigestHex(), expectedDigest, StringComparison.OrdinalIgnoreCase))
            {
                throw new ObjectTransferException("the immutable destination contains different bytes") { Conflict = true };
            }
        }
    }

    /// <summary>The key a file version is matched on between a plan and Core's transfer mappings.</summary>
    public static string VersionKey(string itemId, int version) => itemId + "/" + version.ToString(System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>
    /// Publishes one archive file version create-only: skips the upload when the destination
    /// already verifies, treats "already exists" as a verify, and checks the streamed digest.
    /// <paramref name="verify"/> applies the caller's failure mapping.
    /// </summary>
    public static async Task CopyArchiveVersionAsync(
        ObjectTransfer objects,
        NixArchiveFiles archive,
        string sourceItemId,
        int targetVersion,
        long byteLength,
        string mediaType,
        string sha256,
        Uri uploadUrl,
        Func<CancellationToken, Task> verify,
        string mismatchMessage,
        CancellationToken cancellationToken)
    {
        try
        {
            await verify(cancellationToken).ConfigureAwait(false);
            return;
        }
        catch (ObjectTransferException exception) when (exception.NotFound)
        {
        }
        var content = archive.OpenVersion(sourceItemId, targetVersion, byteLength);
        await using (content.ConfigureAwait(false))
        {
            using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            using var hashing = new HashingReadStream(content, digest);
            try
            {
                await objects.UploadCreateOnlyAsync(uploadUrl, mediaType, hashing, byteLength, sha256, cancellationToken).ConfigureAwait(false);
            }
            catch (ObjectTransferException exception) when (exception.AlreadyExists)
            {
                await verify(cancellationToken).ConfigureAwait(false);
                return;
            }
            if (!string.Equals(Convert.ToHexStringLower(digest.GetCurrentHash()), sha256, StringComparison.OrdinalIgnoreCase))
            {
                throw new ObjectTransferException(mismatchMessage) { Conflict = true };
            }
        }
        await verify(cancellationToken).ConfigureAwait(false);
    }

    public static async Task<long> DrainAsync(Stream stream, CancellationToken cancellationToken)
    {
        var buffer = new byte[64 * 1024]; // byte[]: a reusable read buffer for discarding a bounded body
        long total = 0;
        int read;
        while ((read = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) > 0)
        {
            total += read;
        }
        return total;
    }
}
