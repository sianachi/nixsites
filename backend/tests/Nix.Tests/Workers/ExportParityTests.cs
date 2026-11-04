using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Nix.Workers.Archive;
using Nix.Workers.Export;
using UglyToad.PdfPig;

namespace Nix.Tests.Workers;

/// <summary>
/// Replays the export scenarios the Go worker rendered (<c>fixtures/parity/export/*</c>, recorded by
/// <c>TestRecordParityScenarios</c> before the Go export role was deleted): Markdown bytes, every
/// DOCX and .nix entry and the per-bundle losses must be identical; the PDF must carry the same
/// text in the same order on the same number of pages (a different writer, so bytes differ).
/// </summary>
public sealed class ExportParityTests
{
    private static readonly StreamLimits Limits = new(100L << 20, 4 << 20, 100_000);

    public static TheoryData<string> Scenarios()
    {
        var data = new TheoryData<string>();
        foreach (var directory in Directory.GetDirectories(FixtureRoot()).Order(StringComparer.Ordinal))
        {
            data.Add(Path.GetFileName(directory));
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Markdown_and_losses_match_the_go_worker(string scenario)
    {
        var directory = Path.Combine(FixtureRoot(), scenario);
        var (records, losses) = await ProjectAsync(directory);

        using var output = new MemoryStream();
        await ExportWriters.WriteAsync("markdown", ToAsync(records), output, Limits, "a4", TestContext.Current.CancellationToken);
        await DumpAsync(scenario + ".markdown", output.ToArray());

        Assert.Equal(await File.ReadAllTextAsync(Path.Combine(directory, "expected.markdown"), TestContext.Current.CancellationToken), Encoding.UTF8.GetString(output.ToArray()));
        var expectedLosses = JsonSerializer.Deserialize<string[][]>(await File.ReadAllTextAsync(Path.Combine(directory, "expected-losses.json"), TestContext.Current.CancellationToken))!;
        Assert.Equal(expectedLosses.Select(list => string.Join("\n", list)), losses.Select(list => string.Join("\n", list)));
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Docx_entries_match_the_go_worker(string scenario)
    {
        var directory = Path.Combine(FixtureRoot(), scenario);
        var (records, _) = await ProjectAsync(directory);

        using var output = new MemoryStream();
        await ExportWriters.WriteAsync("docx", ToAsync(records), output, Limits, "a4", TestContext.Current.CancellationToken);

        var expected = Entries(await File.ReadAllBytesAsync(Path.Combine(directory, "expected.docx"), TestContext.Current.CancellationToken));
        var actual = Entries(output.ToArray());
        Assert.Equal(expected.Keys, actual.Keys);
        foreach (var (name, bytes) in expected)
        {
            // A diagram raster comes from a different SVG engine; its name, use and size class are what match.
            if (scenario == "diagram" && name.StartsWith("word/media/", StringComparison.Ordinal))
            {
                Assert.True(actual[name].Length > 100);
                continue;
            }
            Assert.True(bytes.AsSpan().SequenceEqual(actual[name]), $"{name} differs:\n{Encoding.UTF8.GetString(bytes)}\n---\n{Encoding.UTF8.GetString(actual[name])}");
        }
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Pdf_text_and_page_count_match_the_go_worker(string scenario)
    {
        var directory = Path.Combine(FixtureRoot(), scenario);
        var (records, _) = await ProjectAsync(directory);

        using var output = new MemoryStream();
        await ExportWriters.WriteAsync("pdf", ToAsync(records), output, Limits, "a4", TestContext.Current.CancellationToken);
        await DumpAsync(scenario + ".pdf", output.ToArray());

        var (expectedPages, expectedText) = PdfText(await File.ReadAllBytesAsync(Path.Combine(directory, "expected.pdf"), TestContext.Current.CancellationToken));
        var (actualPages, actualText) = PdfText(output.ToArray());
        Assert.Equal(expectedPages, actualPages);
        Assert.Equal(expectedText, actualText);
    }

    [Fact]
    public async Task Nix_archive_entries_match_the_go_worker()
    {
        var directory = Path.Combine(FixtureRoot(), "rich");
        using var source = File.OpenRead(Path.Combine(directory, "stream.ndjson"));
        using var input = await BundleReader.OpenAsync(source, Limits, TestContext.Current.CancellationToken);
        var manifest = input.Manifest;
        var fileIndex = 0;
        using var output = new MemoryStream();
        await ArchiveWriter.WriteAsync(output, manifest, token => input.NextAsync(token), token =>
        {
            if (fileIndex >= manifest.Files!.Count)
            {
                return Task.FromResult<(FileVersionEntry, Stream)?>(null);
            }
            var entry = manifest.Files[fileIndex++];
            Stream content = File.OpenRead(Path.Combine(directory, "files", entry.ItemId, $"{entry.Version}.bin"));
            return Task.FromResult<(FileVersionEntry, Stream)?>((entry, content));
        }, Limits.MaxBytes, TestContext.Current.CancellationToken);

        var expected = Entries(await File.ReadAllBytesAsync(Path.Combine(directory, "expected.nix"), TestContext.Current.CancellationToken));
        var actual = Entries(output.ToArray());
        Assert.Equal(expected.Keys, actual.Keys);
        foreach (var (name, bytes) in expected)
        {
            Assert.True(bytes.AsSpan().SequenceEqual(actual[name]), $"{name} differs");
        }
    }

    private static async Task<(List<ExportRecord> Records, List<IList<string>> Losses)> ProjectAsync(string directory)
    {
        using var source = File.OpenRead(Path.Combine(directory, "stream.ndjson"));
        using var input = await BundleReader.OpenAsync(source, Limits, TestContext.Current.CancellationToken);
        var records = new List<ExportRecord>();
        var losses = new List<IList<string>>();
        ImageLoader loader = (fileId, _) => File.ReadAllBytesAsync(Path.Combine(directory, "images", fileId), TestContext.Current.CancellationToken);
        while (await input.NextAsync(TestContext.Current.CancellationToken) is { } bundle)
        {
            var projected = await Projection.ProjectAsync(bundle, Limits.MaxLine, loader, TestContext.Current.CancellationToken);
            records.Add(new ExportRecord { Id = bundle.Id, ParentId = bundle.ParentId ?? string.Empty, Title = bundle.Title, Blocks = projected.Blocks, Images = projected.Images });
            losses.Add(projected.Losses);
        }
        return (records, losses);
    }

    private static async IAsyncEnumerable<ExportRecord> ToAsync(IEnumerable<ExportRecord> records)
    {
        foreach (var record in records)
        {
            await Task.Yield();
            yield return record;
        }
    }

    /// <summary>Zip entries by name, in archive order.</summary>
    private static SortedDictionary<string, byte[]> Entries(byte[] zip)
    {
        using var archive = new ZipArchive(new MemoryStream(zip), ZipArchiveMode.Read);
        var entries = new SortedDictionary<string, byte[]>(StringComparer.Ordinal);
        foreach (var entry in archive.Entries)
        {
            using var stream = entry.Open();
            using var buffer = new MemoryStream();
            stream.CopyTo(buffer);
            entries[entry.FullName] = buffer.ToArray();
        }
        return entries;
    }

    // Words in reading order (lines top to bottom, left to right), not content-stream order: the
    // two writers emit text runs in a different order within a line, which is not a difference.
    private static (int Pages, string Text) PdfText(byte[] pdf)
    {
        using var document = PdfDocument.Open(pdf);
        var text = new StringBuilder();
        foreach (var page in document.GetPages())
        {
            var lines = page.GetWords()
                .GroupBy(word => Math.Round(word.BoundingBox.Bottom / 3))
                .OrderByDescending(line => line.Key);
            foreach (var line in lines)
            {
                foreach (var word in line.OrderBy(word => word.BoundingBox.Left))
                {
                    text.Append(word.Text).Append(' ');
                }
                text.Append('\n');
            }
            text.Append('\f');
        }
        return (document.NumberOfPages, text.ToString());
    }

    /// <summary>With NIX_PARITY_DUMP set to a directory, keeps the rendered output for a look.</summary>
    private static async Task DumpAsync(string name, byte[] bytes)
    {
        if (Environment.GetEnvironmentVariable("NIX_PARITY_DUMP") is { Length: > 0 } directory)
        {
            await File.WriteAllBytesAsync(Path.Combine(directory, name), bytes, TestContext.Current.CancellationToken);
        }
    }

    private static string FixtureRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Nix.slnx")))
        {
            directory = directory.Parent;
        }
        return Path.Combine(directory!.FullName, "fixtures", "parity", "export");
    }
}
