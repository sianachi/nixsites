using System.Globalization;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Nix.Features.Exports;
using Nix.Workers.Archive;
using Nix.Workers.Export;
using Nix.Workers.Render;
using Nix.Workers.Transfer;

namespace Nix.Workers;

/// <summary>
/// The <c>export.*</c> jobs: fetch the bundle stream Collab prepares, write the requested format
/// to a spool file while hashing it, upload it create-only through Core's capability, and report
/// the bounded result. A port of the Go <c>exportjob</c> handler.
/// </summary>
public sealed class ExportJobHandler(
    WorkerLoopbackClient core,
    ObjectTransfer collab,
    ObjectTransfer objects,
    IConfiguration configuration,
    IOptions<WorkerOptions> options) : IWorkerJobHandler
{
    private const int MaximumResultReportEntries = 16;
    private const int MaximumResultReportBytes = 500;
    private const int SmallResponseLimit = 64 << 10;

    public IReadOnlyList<string> Kinds { get; } = ["export.nix", "export.markdown", "export.docx", "export.pdf"];

    private StreamLimits Limits => new(options.Value.MaxInputBytes, options.Value.MaxLineBytes, options.Value.MaxRecords);

    public async Task<string?> HandleAsync(WorkerExecution job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        ExportJobPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(job.Job.Payload, ExportsJsonContext.Default.ExportJobPayload);
        }
        catch (JsonException)
        {
            payload = null;
        }
        if (payload is null || !ValidPayload(payload))
        {
            throw WorkerJobException.Fail("export_payload_invalid", "the durable export request is invalid");
        }
        var format = payload.Format;
        if (job.Job.Kind != "export." + format)
        {
            throw WorkerJobException.Fail("export_kind_mismatch", "job kind does not match export format");
        }
        var secret = configuration["Nix:InternalSecret"];
        if (string.IsNullOrWhiteSpace(secret))
        {
            throw WorkerJobException.Fail("export_configuration_invalid", "the exporter is not configured");
        }
        var jobId = job.Job.Id.ToString("D");
        var basePath = $"/internal/worker-executions/exports/{jobId}";

        WorkerExportSourceResponse source;
        try
        {
            source = await core.GetJsonAsync(job, basePath, ExportsJsonContext.Default.WorkerExportSourceResponse, SmallResponseLimit, cancellationToken).ConfigureAwait(false)
                ?? throw new WorkerLoopbackException(200, basePath, "empty source");
        }
        catch (Exception exception) when (IsTransient(exception, cancellationToken))
        {
            throw WorkerJobException.Retry("export_source_unavailable", exception.Message);
        }
        if (source.ExportId != job.Job.Id || source.Format != format || string.IsNullOrEmpty(source.BearerToken) || source.DelegationExpiresAt <= DateTimeOffset.UtcNow)
        {
            throw WorkerJobException.Fail("export_source_invalid", "the source capability does not match the export job");
        }

        var limits = Limits;
        // The owner-only spool directory the sweeper cleans, so a crash mid-export leaves nothing readable for good.
        var spool = WorkSpool.Create(options.Value.SpoolDirectory, "nix-export-");
        var file = new FileStream(spool, FileMode.Open, FileAccess.ReadWrite, FileShare.None, 64 * 1024, FileOptions.DeleteOnClose | FileOptions.Asynchronous);
        await using (file.ConfigureAwait(false))
        {
            using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            using var hashing = new HashingStream(file, digest);
            Manifest manifest;
            var projectionLoss = new List<string>();
            ObjectDownload download;
            try
            {
                download = await collab.DownloadAsync(source.SourceUrl, limits.MaxBytes, source.BearerToken, secret, cancellationToken).ConfigureAwait(false);
            }
            catch (ObjectTransferException exception)
            {
                throw WorkerJobException.Retry("export_source_unavailable", exception.Message);
            }
            await using (download.ConfigureAwait(false))
            {
                BundleReader input;
                try
                {
                    input = await BundleReader.OpenAsync(download.Body, limits, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception exception) when (exception is ArchiveFormatException or StreamLimitException or ObjectTransferException)
                {
                    throw WorkerJobException.Fail("export_bundle_invalid", exception.Message);
                }
                manifest = input.Manifest;
                try
                {
                    if (format == "nix")
                    {
                        var (files, urls) = await FileVersionsAsync(job, basePath, manifest, cancellationToken).ConfigureAwait(false);
                        manifest.FormatVersion = NixArchive.FileFormatVersion;
                        manifest.Files = files;
                        manifest.Raw = null;
                        var fileIndex = 0;
                        await ArchiveWriter.WriteAsync(hashing, manifest, token => input.NextAsync(token), async token =>
                        {
                            if (fileIndex >= files.Count)
                            {
                                return null;
                            }
                            var entry = files[fileIndex];
                            var url = urls[fileIndex];
                            fileIndex++;
                            var capability = await objects.DownloadAsync(url, Math.Max(entry.ByteLength, 1), token).ConfigureAwait(false);
                            return (entry, (Stream)new OwnedStream(capability));
                        }, limits.MaxBytes, cancellationToken).ConfigureAwait(false);
                    }
                    else
                    {
                        await ExportWriters.WriteAsync(format, Records(input, format, limits.MaxLine, projectionLoss, ImageLoader(job, basePath), cancellationToken), hashing, limits, payload.PageSize, cancellationToken).ConfigureAwait(false);
                    }
                }
                catch (WorkerJobException)
                {
                    throw;
                }
                catch (ObjectTransferException exception)
                {
                    throw WorkerJobException.Retry("export_source_unavailable", exception.Message);
                }
                catch (Exception exception) when (exception is ArchiveFormatException or StreamLimitException or FormatException or InvalidDataException or JsonException)
                {
                    throw WorkerJobException.Fail(exception is ArchiveFormatException ? "export_bundle_invalid" : "export_write_failed", exception.Message);
                }
            }
            await file.FlushAsync(cancellationToken).ConfigureAwait(false);
            var size = file.Length;
            var checksum = Convert.ToHexStringLower(digest.GetHashAndReset());

            WorkerExportDestinationResponse destination;
            try
            {
                destination = await core.GetJsonAsync(job, $"{basePath}/destination?byteLength={size.ToString(CultureInfo.InvariantCulture)}&sha256={checksum}", ExportsJsonContext.Default.WorkerExportDestinationResponse, SmallResponseLimit, cancellationToken).ConfigureAwait(false)
                    ?? throw new WorkerLoopbackException(200, basePath, "empty destination");
            }
            catch (Exception exception) when (IsTransient(exception, cancellationToken))
            {
                throw WorkerJobException.Retry("export_destination_unavailable", exception.Message);
            }
            if (destination.ExportId != job.Job.Id || destination.AttemptId == Guid.Empty || destination.Format != format || string.IsNullOrEmpty(destination.ObjectKey) || destination.CapabilityExpiresAt <= DateTimeOffset.UtcNow)
            {
                throw WorkerJobException.Fail("export_destination_invalid", "the destination capability does not match the export job");
            }
            file.Position = 0;
            try
            {
                await objects.UploadCreateOnlyAsync(destination.UploadUrl, ExportWriters.ContentType(format), file, size, checksum, cancellationToken).ConfigureAwait(false);
            }
            catch (ObjectTransferException exception) when (exception.AlreadyExists)
            {
                await VerifyExistingAsync(destination.ReadUrl, size, checksum, cancellationToken).ConfigureAwait(false);
            }
            catch (ObjectTransferException exception)
            {
                await DeleteBestEffortAsync(destination.DeleteUrl).ConfigureAwait(false);
                throw WorkerJobException.Retry("export_upload_failed", exception.Message);
            }
            return JsonSerializer.Serialize(
                new WorkerExportResult(destination.AttemptId, format, destination.ObjectKey, manifest.Items.Count, manifest.Omitted.Count, size, checksum,
                    LossMessages(format, manifest, projectionLoss), OmissionMessages(manifest)),
                ExportsJsonContext.Default.WorkerExportResult);
        }
    }

    private async Task<(List<FileVersionEntry> Entries, List<Uri> Urls)> FileVersionsAsync(WorkerExecution job, string basePath, Manifest manifest, CancellationToken cancellationToken)
    {
        var entries = new List<FileVersionEntry>();
        var urls = new List<Uri>();
        foreach (var item in manifest.Items)
        {
            if (item.Type != "file")
            {
                continue;
            }
            WorkerExportFileHistoryResponse? history;
            try
            {
                history = await core.GetJsonAsync(job, $"{basePath}/files/{item.Id}/versions", ExportsJsonContext.Default.WorkerExportFileHistoryResponse, 1 << 20, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (IsTransient(exception, cancellationToken))
            {
                throw WorkerJobException.Retry("export_file_history_unavailable", exception.Message);
            }
            if (history is null || history.ItemId.ToString("D") != item.Id || history.Versions.Count == 0 || history.Versions.Count > NixArchive.MaxFileVersionsPerItem)
            {
                throw WorkerJobException.Fail("export_file_history_invalid", "the file history does not match the export bundle");
            }
            var currentCount = 0;
            for (var index = 0; index < history.Versions.Count; index++)
            {
                var version = history.Versions[index];
                var sha256 = version.Sha256 is { Length: 64 } hex && hex.All(char.IsAsciiHexDigit) ? Convert.ToHexStringLower(Convert.FromHexString(hex)) : string.Empty;
                if (version.Version != index + 1 || version.ByteLength < 0 || version.ByteLength > 100L << 20
                    || !NixArchive.SafeSha256(sha256) || string.IsNullOrWhiteSpace(version.FileName)
                    || string.IsNullOrWhiteSpace(version.MediaType) || version.ExpiresAt <= DateTimeOffset.UtcNow)
                {
                    throw WorkerJobException.Fail("export_file_history_invalid", "a file version capability is invalid");
                }
                if (version.Current)
                {
                    currentCount++;
                }
                entries.Add(new FileVersionEntry(item.Id, version.Version, version.Current, version.FileName, version.MediaType, version.ByteLength, sha256, version.Previewable, version.PixelWidth, version.PixelHeight));
                urls.Add(version.DownloadUrl);
            }
            if (currentCount != 1 || !history.Versions[^1].Current)
            {
                throw WorkerJobException.Fail("export_file_history_invalid", "the file history does not identify exactly one current version");
            }
        }
        return (entries, urls);
    }

    private async Task VerifyExistingAsync(Uri readUrl, long size, string expectedSha256, CancellationToken cancellationToken)
    {
        ObjectDownload download;
        try
        {
            download = await objects.DownloadAsync(readUrl, size, cancellationToken).ConfigureAwait(false);
        }
        catch (ObjectTransferException exception)
        {
            throw WorkerJobException.Retry("export_result_verification_unavailable", exception.Message);
        }
        await using (download.ConfigureAwait(false))
        {
            long read = 0;
            var buffer = new byte[64 * 1024]; // byte[]: drain buffer; the digest is kept by the download
            try
            {
                while (true)
                {
                    var count = await download.Body.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                    if (count == 0)
                    {
                        break;
                    }
                    read += count;
                }
            }
            catch (ObjectTransferException exception)
            {
                throw WorkerJobException.Fail("export_result_conflict", "existing export result does not match this execution: " + exception.Message);
            }
            if (read != size || !string.Equals(download.DigestHex(), expectedSha256, StringComparison.OrdinalIgnoreCase))
            {
                throw WorkerJobException.Fail("export_result_conflict", "existing export result does not match this execution");
            }
        }
    }

    private async Task DeleteBestEffortAsync(Uri deleteUrl)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try
        {
            await objects.DeleteAsync(deleteUrl, timeout.Token).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is ObjectTransferException or OperationCanceledException)
        {
            // Best effort: the orphan is reaped by retention.
        }
    }

    private static async IAsyncEnumerable<ExportRecord> Records(BundleReader input, string format, int maximumBodyBytes, List<string> losses, ImageLoader loader, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        while (await input.NextAsync(cancellationToken).ConfigureAwait(false) is { } bundle)
        {
            var projected = await Projection.ProjectAsync(bundle, maximumBodyBytes, loader, cancellationToken).ConfigureAwait(false);
            foreach (var loss in projected.Losses)
            {
                AppendUnique(losses, loss);
            }
            var images = 0;
            var details = false;
            var pageBreaks = false;
            RenderTree.Walk(projected.Blocks, block =>
            {
                switch (block.Kind)
                {
                    case "image":
                        images++;
                        break;
                    case "details":
                        details = true;
                        break;
                    case "pageBreak":
                        pageBreaks = true;
                        break;
                    default:
                        break;
                }
            });
            if (format != "markdown" && images > projected.Images.Count)
            {
                AppendUnique(losses, "Images are linked or described rather than embedded in the converted document.");
            }
            if (format != "markdown" && details)
            {
                AppendUnique(losses, "Collapsible sections were expanded into always-visible document content.");
            }
            if (format == "markdown" && projected.Images.Count > 0)
            {
                AppendUnique(losses, "Embedded images use data URLs, which some Markdown readers do not display; saved image widths are not preserved.");
            }
            if (format == "markdown" && pageBreaks)
            {
                AppendUnique(losses, "Explicit page breaks are represented by markers in Markdown; page layout is not preserved.");
            }
            if (TextRules.ProjectTitle(bundle.Title).Lost)
            {
                AppendUnique(losses, "Title control characters or line breaks were removed in the converted document.");
            }
            if (format == "pdf")
            {
                var substituted = ExportWriters.PdfTextRequiresSubstitution(bundle.Title);
                RenderTree.Walk(projected.Blocks, block => substituted = substituted || ExportWriters.PdfTextRequiresSubstitution(RenderTree.Plain(block.Runs) + block.Text));
                if (substituted)
                {
                    AppendUnique(losses, "Characters not supported by the embedded PDF font were replaced in the PDF output.");
                }
            }
            yield return new ExportRecord { Id = bundle.Id, ParentId = bundle.ParentId ?? string.Empty, Title = bundle.Title, Blocks = projected.Blocks, Images = projected.Images };
        }
    }

    private ImageLoader ImageLoader(WorkerExecution job, string basePath)
    {
        var remaining = 64L << 20;
        var requests = 0;
        return async (fileId, cancellationToken) =>
        {
            if (!Guid.TryParseExact(fileId, "D", out var id))
            {
                throw new InvalidDataException("invalid image identifier");
            }
            requests++;
            if (requests > 256 || remaining <= 0)
            {
                throw new StreamLimitException();
            }
            var capability = await core.GetJsonAsync(job, $"{basePath}/images/{id:D}", ExportsJsonContext.Default.ExportDownloadCapabilityResponse, SmallResponseLimit, cancellationToken).ConfigureAwait(false)
                ?? throw new InvalidDataException("image capability missing");
            if (capability.ByteLength <= 0 || capability.ByteLength > Math.Min(10L << 20, remaining) || capability.ExpiresAt <= DateTimeOffset.UtcNow)
            {
                throw new StreamLimitException();
            }
            remaining -= capability.ByteLength;
            var download = await objects.DownloadAsync(capability.Url, capability.ByteLength, cancellationToken).ConfigureAwait(false);
            await using (download.ConfigureAwait(false))
            {
                // Forced bounded allocation: document encoders require a complete validated raster.
                using var buffer = new MemoryStream();
                await download.Body.CopyToAsync(buffer, cancellationToken).ConfigureAwait(false);
                if (buffer.Length != capability.ByteLength)
                {
                    throw new InvalidDataException("image length mismatch");
                }
                if (!string.Equals(download.DigestHex(), capability.Sha256, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("source checksum does not match");
                }
                return buffer.ToArray();
            }
        };
    }

    private static bool IsTransient(Exception exception, CancellationToken cancellationToken) =>
        exception is HttpRequestException or WorkerLoopbackException or TaskCanceledException && !cancellationToken.IsCancellationRequested;

    private static void AppendUnique(List<string> values, string value)
    {
        if (!values.Contains(value, StringComparer.Ordinal))
        {
            values.Add(value);
        }
    }

    private static bool ValidPayload(ExportJobPayload payload)
    {
        if (payload.ItemId == Guid.Empty || payload.WorkspaceId == Guid.Empty || payload.Scope is not ("item" or "subtree") || (payload.Title?.Length ?? 0) > 500 || payload.DeclaredLoss is null || payload.DeclaredLoss.Count > 32)
        {
            return false;
        }
        var extension = payload.Format switch
        {
            "nix" => "nix",
            "markdown" => "md",
            "docx" => "docx",
            "pdf" => "pdf",
            _ => null,
        };
        if (extension is null || payload.Extension != extension || payload.MediaType != ExportWriters.ContentType(payload.Format))
        {
            return false;
        }
        return payload.DeclaredLoss.All(entry => !string.IsNullOrWhiteSpace(entry) && entry.Length <= 500 && entry.IndexOfAny(['\r', '\n']) < 0);
    }

    public static IReadOnlyList<string> LossMessages(string format, Manifest manifest, IReadOnlyList<string> projectionLoss)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(projectionLoss);
        var result = new List<string>();
        foreach (var entry in manifest.Loss)
        {
            AppendUnique(result, ReportEntry(entry.Kind, entry.Detail));
        }
        foreach (var entry in projectionLoss)
        {
            AppendUnique(result, entry);
        }
        if (ExportWriters.FormatLoss(format) is { Length: > 0 } formatLoss)
        {
            AppendUnique(result, formatLoss);
        }
        return BoundedReport(result, "loss entries");
    }

    public static IReadOnlyList<string> OmissionMessages(Manifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        return BoundedReport(manifest.Omitted.Select(entry => ReportEntry(entry.Reason, entry.Detail)).ToList(), "omissions");
    }

    private static string ReportEntry(string kind, string detail) =>
        Nix.Workers.Calendar.CalendarWire.TruncateUtf8((kind ?? string.Empty).Trim() + ": " + (detail ?? string.Empty).Trim(), MaximumResultReportBytes).Trim();

    private static List<string> BoundedReport(List<string> entries, string name)
    {
        if (entries.Count <= MaximumResultReportEntries)
        {
            return entries;
        }
        var result = entries.Take(MaximumResultReportEntries - 1).ToList();
        result.Add($"{(entries.Count - result.Count).ToString(CultureInfo.InvariantCulture)} additional {name} were omitted from this bounded status summary.");
        return result;
    }

    /// <summary>Writes through to the spool while feeding the digest.</summary>
    private sealed class HashingStream(Stream inner, IncrementalHash digest) : Stream
    {
        public override bool CanRead => false;

        public override bool CanSeek => false;

        public override bool CanWrite => true;

        public override long Length => inner.Length;

        public override long Position { get => inner.Position; set => throw new NotSupportedException(); }

        public override void Flush() => inner.Flush();

        public override Task FlushAsync(CancellationToken cancellationToken) => inner.FlushAsync(cancellationToken);

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count)
        {
            digest.AppendData(buffer, offset, count);
            inner.Write(buffer, offset, count);
        }

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            digest.AppendData(buffer);
            inner.Write(buffer);
        }

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            digest.AppendData(buffer.Span);
            await inner.WriteAsync(buffer, cancellationToken).ConfigureAwait(false);
        }
    }

    /// <summary>Disposes the download with its body when the archive writer closes the file stream.</summary>
    private sealed class OwnedStream(ObjectDownload download) : Stream
    {
        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count) => download.Body.Read(buffer, offset, count);

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => download.Body.ReadAsync(buffer, cancellationToken);

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override async ValueTask DisposeAsync()
        {
            await download.DisposeAsync().ConfigureAwait(false);
            await base.DisposeAsync().ConfigureAwait(false);
        }
    }
}
