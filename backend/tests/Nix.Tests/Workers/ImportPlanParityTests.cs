using System.Text;
using System.Text.Json;
using Nix.Workers.Import;

namespace Nix.Tests.Workers;

/// <summary>
/// Replays the import scenarios the Go worker planned (<c>fixtures/parity/import/*</c>, recorded by
/// <c>TestRecordParity</c> in apps/go-workers/internal/importplan): the encoded plan bytes, and so
/// the checksum Core stores, must be identical. PDF has no golden: PdfPig extracts text differently
/// from pdftotext by design, and its structure is covered in <see cref="ImportPlanTests"/>.
/// </summary>
public sealed class ImportPlanParityTests
{
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
    public async Task Encoded_plan_matches_the_go_worker(string scenario)
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var directory = Path.Combine(FixtureRoot(), scenario);
        using var meta = JsonDocument.Parse(await File.ReadAllBytesAsync(Path.Combine(directory, "meta.json"), cancellationToken));
        string Meta(string name) => meta.RootElement.GetProperty(name).GetString()!;
        var path = Directory.GetFiles(directory, "source.*").Single();
        var source = ImportFixtures.FileSource(path, Meta("format"), Meta("title"), Meta("fileName"), Meta("mediaType"));

        byte[] actual;
        string expectedPath;
        if (File.Exists(Path.Combine(directory, "template-plan.json")))
        {
            expectedPath = Path.Combine(directory, "template-plan.json");
            var template = await TemplatePlanner.ParseAsync(source, ImportFixtures.Limits, cancellationToken);
            actual = TemplatePlanner.Encode(template, ImportFixtures.Limits.MaxPlanBytes).Bytes;
            Assert.Equal(actual, TemplatePlanner.Encode(TemplatePlanner.Decode(actual, Digest(actual), ImportFixtures.Limits), ImportFixtures.Limits.MaxPlanBytes).Bytes);
        }
        else
        {
            expectedPath = Path.Combine(directory, "plan.json");
            var plan = await ImportPlanner.ParseAsync(source, ImportFixtures.Limits, cancellationToken);
            actual = ImportPlanner.Encode(plan, ImportFixtures.Limits.MaxPlanBytes).Bytes;
            Assert.Equal(actual, ImportPlanner.Encode(ImportPlanner.Decode(actual, Digest(actual), ImportFixtures.Limits), ImportFixtures.Limits.MaxPlanBytes).Bytes);
        }

        var expected = await File.ReadAllBytesAsync(expectedPath, cancellationToken);
        Assert.True(expected.AsSpan().SequenceEqual(actual), $"{scenario} differs:\n{Encoding.UTF8.GetString(expected)}\n---\n{Encoding.UTF8.GetString(actual)}");
    }

    private static string Digest(byte[] body) => Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(body));

    private static string FixtureRoot() => Path.Combine(ImportFixtures.RepoRoot(), "fixtures", "parity", "import");
}
