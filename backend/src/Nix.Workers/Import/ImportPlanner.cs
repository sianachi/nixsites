using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using Nix.Workers.Archive;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Exceptions;

namespace Nix.Workers.Import;

/// <summary>
/// Turns an uploaded source (nix, markdown, txt, docx, pdf) into a deterministic import plan, and
/// writes and verifies that plan. The port of the Go worker's importplan package; the parity
/// goldens in fixtures/parity/import pin its bytes.
/// </summary>
public static class ImportPlanner
{
    public static async Task<ImportPlan> ParseAsync(ImportSource source, ImportPlanLimits limits, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(limits);
        cancellationToken.ThrowIfCancellationRequested();
        ValidateSource(source, limits);
        try
        {
            return NormalizeFormat(source.Format) switch
            {
                "markdown" => ParseText(source, limits, markdown: true),
                "txt" => ParseText(source, limits, markdown: false),
                "pdf" => await ParsePdfAsync(source, limits, cancellationToken).ConfigureAwait(false),
                "docx" => DocxImport.Parse(source, limits, cancellationToken),
                "nix" => NixImport.Parse(source, limits, cancellationToken),
                _ => throw new ImportPlanException(ImportPlanException.FormatUnsupported, "unsupported import format: " + source.Format),
            };
        }
        catch (Exception exception) when (exception is IOException or InvalidDataException or JsonException or XmlException or ArchiveFormatException or UnauthorizedAccessException)
        {
            throw new ImportPlanException(ImportPlanException.SourceInvalid, exception.Message, exception);
        }
    }

    public static (byte[] Bytes, string Sha256Hex) Encode(ImportPlan plan, long maxBytes)
    {
        ArgumentNullException.ThrowIfNull(plan);
        if (plan.Version != ImportPlan.CurrentVersion || string.IsNullOrEmpty(plan.Format) || string.IsNullOrEmpty(plan.SourceSha256) || plan.Items.Count == 0)
        {
            throw new ImportPlanException(ImportPlanException.PlanInvalid, "import plan is incomplete");
        }
        ValidatePlanFileVersions(plan.FileVersions, plan.Items);
        var body = PlanJson.Write(plan);
        if (body.Length > maxBytes)
        {
            throw new ImportPlanException(ImportPlanException.PlanInvalid, "import plan exceeds the configured byte limit");
        }
        return (body, Convert.ToHexStringLower(SHA256.HashData(body)));
    }

    public static ImportPlan Decode(byte[] body, string expectedDigest, ImportPlanLimits limits) =>
        Decode(body.AsSpan(), expectedDigest, limits);

    public static ImportPlan Decode(ReadOnlySpan<byte> body, string expectedDigest, ImportPlanLimits limits)
    {
        ArgumentNullException.ThrowIfNull(limits);
        if (body.Length > limits.MaxPlanBytes)
        {
            throw new ImportPlanException(ImportPlanException.PlanInvalid, "import plan exceeds the configured byte limit");
        }
        if (Convert.ToHexStringLower(SHA256.HashData(body)) != expectedDigest)
        {
            throw new ImportPlanException(ImportPlanException.PlanInvalid, "import plan checksum does not match the preview");
        }
        ImportPlan plan;
        try
        {
            plan = PlanJson.Read(GoJson.Parse(body));
        }
        catch (JsonException exception)
        {
            throw new ImportPlanException(ImportPlanException.PlanInvalid, exception.Message, exception);
        }
        if (plan.Version != ImportPlan.CurrentVersion || plan.Items.Count == 0 || plan.Items.Count > limits.MaxItems)
        {
            throw new ImportPlanException(ImportPlanException.PlanInvalid, "import plan version or item count is unsupported");
        }
        ValidatePlanFileVersions(plan.FileVersions, plan.Items);
        return plan;
    }

    private static void ValidatePlanFileVersions(IList<FileVersionEntry>? files, IList<ImportItem> items)
    {
        if (files is null)
        {
            return;
        }
        try
        {
            NixArchive.ValidateFileVersions(files, [.. items.Select(item => new ManifestItem(item.SourceId, null, string.Empty, string.Empty, item.ItemType))]);
        }
        catch (ArchiveFormatException exception)
        {
            throw new ImportPlanException(ImportPlanException.PlanInvalid, exception.Message, exception);
        }
    }

    private static ImportPlan ParseText(ImportSource source, ImportPlanLimits limits, bool markdown)
    {
        var body = ReadFileBounded(source.Path, limits.MaxBodyBytes).AsSpan();
        if (body.StartsWith("﻿"u8))
        {
            body = body[3..];
        }
        if (BinaryLookingText(body) || !System.Text.Unicode.Utf8.IsValid(body))
        {
            throw new ImportPlanException("text input is not valid UTF-8 or appears to be binary");
        }
        var normalized = Encoding.UTF8.GetString(body).Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
        var items = new List<ImportItem>
        {
            NoteItem("root", null, 0, source.Title, new ImportBody { Encoding = markdown ? "markdown" : "plain_text", Text = normalized }),
        };
        if (!markdown)
        {
            items.Add(OriginalItem(source, "text/plain", 0));
        }
        return new ImportPlan
        {
            Version = ImportPlan.CurrentVersion,
            Format = markdown ? "markdown" : "txt",
            Title = source.Title,
            SourceSha256 = source.Sha256,
            Items = items,
        };
    }

    internal static bool BinaryLookingText(ReadOnlySpan<byte> body)
    {
        foreach (var value in body)
        {
            if (value == 0x7f || (value < 0x20 && value != '\t' && value != '\n' && value != '\r'))
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// PDF text through PdfPig, in process: a different extractor from the Go worker's
    /// <c>pdftotext -layout</c>, so line breaks and spacing differ (accepted; words, page order and
    /// the page-break markers match). shortcut: no address-space cap as prlimit gave pdftotext, only the
    /// decoded-stream budget of <see cref="BoundedPdfFilters"/>; the time limit abandons the extraction
    /// between pages, so a hostile page can still pin a thread.
    /// </summary>
    private static async Task<ImportPlan> ParsePdfAsync(ImportSource source, ImportPlanLimits limits, CancellationToken cancellationToken)
    {
        if (!ReadFilePrefix(source.Path, 8).AsSpan().StartsWith("%PDF-"u8))
        {
            throw new ImportPlanException("PDF input does not start with a PDF signature");
        }
        var timeout = TimeSpan.FromSeconds(limits.PdfTimeoutSecs > 0 ? limits.PdfTimeoutSecs : 30);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        string output;
        try
        {
            output = await Task.Run(() => ExtractPdfText(source.Path, limits.MaxBodyBytes, deadline.Token), deadline.Token)
                .WaitAsync(deadline.Token)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ImportPlanException("PDF extraction exceeded its time limit");
        }
        catch (PdfDocumentEncryptedException exception)
        {
            throw new ImportPlanException(ImportPlanException.PdfEncrypted, "encrypted PDF files are not supported", exception);
        }
        catch (Exception exception) when (exception is not ImportPlanException and not OperationCanceledException)
        {
            throw new ImportPlanException("PDF extraction failed: " + exception.Message, exception);
        }
        var text = output.Replace("\f", "\n\n[Page break]\n\n", StringComparison.Ordinal).Trim();
        // Go tested the trimmed text, which pdftotext's per-page form feed always left non-empty; a PDF without a word is what it meant.
        if (string.IsNullOrWhiteSpace(output.Replace("\f", string.Empty, StringComparison.Ordinal)))
        {
            throw new ImportPlanException(ImportPlanException.OcrUnavailable, "PDF contains no extractable text; OCR is not available");
        }
        return new ImportPlan
        {
            Version = ImportPlan.CurrentVersion,
            Format = "pdf",
            Title = source.Title,
            SourceSha256 = source.Sha256,
            Items =
            [
                NoteItem("root", null, 0, source.Title, new ImportBody { Encoding = "plain_text", Text = text }),
                OriginalItem(source, "application/pdf", 0),
            ],
            Loss = ["PDF fonts, vector graphics, images, and exact page layout are not preserved."],
        };
    }

    /// <summary>Each page's words in reading order, one line per baseline, the page ended by a form feed as pdftotext ends it.</summary>
    private static string ExtractPdfText(string path, long maxBytes, CancellationToken cancellationToken)
    {
        // Decoded streams (content, fonts, object streams) may total 16 times the text budget.
        using var document = PdfDocument.Open(path, new ParsingOptions { FilterProvider = new BoundedPdfFilters(16 * maxBytes) });
        var output = new StringBuilder();
        long bytes = 0;
        foreach (var page in document.GetPages())
        {
            cancellationToken.ThrowIfCancellationRequested();
            var start = output.Length;
            foreach (var line in page.GetWords().GroupBy(word => Math.Round(word.BoundingBox.Bottom)).OrderByDescending(line => line.Key))
            {
                output.AppendJoin(' ', line.OrderBy(word => word.BoundingBox.Left).Select(word => word.Text)).Append('\n');
            }
            output.Append('\f');
            bytes += Encoding.UTF8.GetByteCount(output.ToString(start, output.Length - start));
            if (bytes > maxBytes)
            {
                throw new ImportPlanException("input exceeds the configured byte limit");
            }
        }
        return output.ToString();
    }

    internal static ImportItem NoteItem(string sourceId, string? parent, int order, string title, ImportBody body) => new()
    {
        SourceId = sourceId,
        ParentSourceId = parent,
        Order = order,
        Title = title,
        ItemType = "note",
        FinalLifecycleState = "active",
        Body = body,
    };

    internal static ImportItem OriginalItem(ImportSource source, string mediaType, int order) => new()
    {
        SourceId = "original",
        ParentSourceId = "root",
        Order = order,
        Title = source.FileName,
        ItemType = "file",
        FinalLifecycleState = "active",
        File = new ImportFile
        {
            SourceKind = "source",
            FileName = source.FileName,
            MediaType = mediaType,
            ByteLength = source.Bytes,
            Sha256 = source.Sha256,
        },
    };

    internal static void ValidateSource(ImportSource source, ImportPlanLimits limits)
    {
        if (string.IsNullOrEmpty(source.Path) || string.IsNullOrEmpty(source.Title) || string.IsNullOrEmpty(source.FileName) || string.IsNullOrEmpty(source.Sha256))
        {
            throw new ImportPlanException("source path, title, file name, and checksum are required");
        }
        if (source.Bytes < 0 || source.Bytes > limits.MaxSourceBytes || limits.MaxItems <= 0 || limits.MaxBodyBytes <= 0 || limits.MaxEntryBytes <= 0 || limits.MaxPlanBytes <= 0)
        {
            throw new ImportPlanException("source or import limits are invalid");
        }
    }

    internal static string NormalizeFormat(string value) => value.Trim().ToUpperInvariant() switch
    {
        "MD" or "MARKDOWN" => "markdown",
        "TEXT" or "TXT" => "txt",
        "PDF" => "pdf",
        "DOCX" => "docx",
        "NIX" => "nix",
        _ => string.Empty,
    };

    private static byte[] ReadFileBounded(string path, long maxBytes)
    {
        using var file = File.OpenRead(path);
        return ReadBounded(file, maxBytes);
    }

    private static byte[] ReadFilePrefix(string path, int count)
    {
        using var file = File.OpenRead(path);
        var prefix = new byte[count]; // byte[]: the few signature bytes
        return prefix[..file.ReadAtLeast(prefix, count, throwOnEndOfStream: false)];
    }

    /// <summary>Reads at most <paramref name="maxBytes"/>, failing when the source holds more.</summary>
    internal static byte[] ReadBounded(Stream source, long maxBytes)
    {
        using var output = new MemoryStream();
        var buffer = new byte[64 * 1024]; // byte[]: streaming copy buffer
        int read;
        while ((read = source.Read(buffer)) > 0)
        {
            if (output.Length + read > maxBytes)
            {
                throw new ImportPlanException("input exceeds the configured byte limit");
            }
            output.Write(buffer, 0, read);
        }
        return output.ToArray();
    }
}
