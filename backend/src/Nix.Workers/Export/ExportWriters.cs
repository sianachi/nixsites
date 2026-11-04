using System.Text;
using Nix.Workers.Archive;
using Nix.Workers.Render;

namespace Nix.Workers.Export;

/// <summary>The converted-document formats and the one entry point that writes them.</summary>
public static class ExportWriters
{
    public static string ContentType(string format) => format switch
    {
        "markdown" => "text/markdown; charset=utf-8",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pdf" => "application/pdf",
        _ => "application/vnd.nix.archive+zip",
    };

    /// <summary>Writes records as <paramref name="format"/> (markdown, docx or pdf) within <paramref name="limits"/>.</summary>
    public static Task WriteAsync(string format, IAsyncEnumerable<ExportRecord> records, Stream output, StreamLimits limits, string pageSize, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(format);
        ArgumentNullException.ThrowIfNull(limits);
        if (limits.MaxBytes <= 0 || limits.MaxLine <= 0 || limits.MaxRecords <= 0)
        {
            throw new ArgumentException("export writer configuration is invalid", nameof(limits));
        }
        return format.ToUpperInvariant() switch
        {
            "MARKDOWN" or "MD" => WriteMarkdownAsync(output, records, limits, cancellationToken),
            "DOCX" => DocxWriter.WriteAsync(output, records, limits, cancellationToken),
            "PDF" => PdfWriter.WriteAsync(output, records, limits, pageSize, cancellationToken),
            _ => throw new ArgumentException($"unsupported streaming export format: {format}", nameof(format)),
        };
    }

    private static async Task WriteMarkdownAsync(Stream output, IAsyncEnumerable<ExportRecord> records, StreamLimits limits, CancellationToken cancellationToken)
    {
        using var limited = new LimitedStream(output, limits.MaxBytes);
        var count = 0;
        await foreach (var record in records.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            count++;
            if (count > limits.MaxRecords)
            {
                throw new StreamLimitException();
            }
            if (string.IsNullOrEmpty(record.Title))
            {
                throw new ArchiveFormatException("export record title is required");
            }
            var (title, _) = TextRules.ProjectTitle(record.Title);
            var text = "# " + EscapeTitle(title) + "\n\n" + EmbedImages(record, MarkdownRenderer.Render(record.Blocks)) + "\n\n";
            await limited.WriteAsync(Encoding.UTF8.GetBytes(text), cancellationToken).ConfigureAwait(false);
        }
    }

    // Embeds each loaded raster as a data URL where the tree pointed at it.
    private static string EmbedImages(ExportRecord record, string markdown)
    {
        foreach (var raster in record.Images)
        {
            markdown = markdown.Replace(raster.Source, "data:image/" + raster.Format + ";base64," + Convert.ToBase64String(raster.Data), StringComparison.Ordinal);
        }
        return markdown;
    }

    private static string EscapeTitle(string title)
    {
        var output = new StringBuilder(title.Length);
        foreach (var rune in title.EnumerateRunes())
        {
            if (rune.Value <= char.MaxValue && "\\`*_[]<|~#".Contains((char)rune.Value, StringComparison.Ordinal))
            {
                output.Append('\\');
            }
            output.Append(rune.ToString());
        }
        return output.ToString();
    }

    /// <summary>Which runs of a block need PDF glyph substitution, for the loss report.</summary>
    public static bool PdfTextRequiresSubstitution(string value) => PdfWriter.PdfText(value) != TextRules.Sanitize(value);

    /// <summary>The losses a format adds on its own, over what the projection and the manifest reported.</summary>
    public static string FormatLoss(string format) => format switch
    {
        "markdown" => "Workspace hierarchy and lifecycle metadata are not preserved as editable Nix structure in Markdown. Views and properties are static text.",
        "docx" or "pdf" => "Workspace hierarchy and lifecycle metadata are not preserved as editable Nix structure in the converted document. Views and properties are static text.",
        _ => string.Empty,
    };
}
