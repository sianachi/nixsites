using Nix.Abstractions.Workers;
using Nix.Workers;

namespace Nix.Tests.Persistence;

public sealed class WorkerCapabilityRegistryTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse(
        "2026-09-01T12:00:00Z",
        System.Globalization.CultureInfo.InvariantCulture);

    [Fact]
    public void Identical_live_replicas_advertise_one_format()
    {
        var registry = new WorkerCapabilityRegistry();
        registry.Replace(Advertisement("export-a", Now, Format("pdf", "pdf")));
        registry.Replace(Advertisement("export-b", Now.AddSeconds(1), Format("pdf", "pdf")));

        var format = Assert.Single(registry.ExportFormats(Now.AddSeconds(2)));

        Assert.Equal("pdf", format.Format);
    }

    [Fact]
    public void Conflicting_live_contracts_fail_closed_until_one_expires()
    {
        var registry = new WorkerCapabilityRegistry();
        registry.Replace(Advertisement("export-a", Now, Format("pdf", "pdf"), TimeSpan.FromSeconds(20)));
        registry.Replace(Advertisement("export-b", Now, Format("pdf", "portable"), TimeSpan.FromMinutes(2)));

        Assert.Empty(registry.ExportFormats(Now.AddSeconds(10)));
        Assert.Equal("portable", Assert.Single(registry.ExportFormats(Now.AddSeconds(21))).Extension);
    }

    [Fact]
    public void A_format_missing_from_one_live_queue_consumer_is_not_advertised()
    {
        var registry = new WorkerCapabilityRegistry();
        registry.Replace(new WorkerCapabilityAdvertisement(
            "export-a",
            "export",
            Now,
            Now.AddMinutes(2),
            [Format("pdf", "pdf"), Format("docx", "docx")]));
        registry.Replace(Advertisement("export-b", Now, Format("pdf", "pdf")));

        var format = Assert.Single(registry.ExportFormats(Now.AddSeconds(1)));

        Assert.Equal("pdf", format.Format);
    }

    [Fact]
    public void A_late_older_heartbeat_cannot_roll_back_an_instance()
    {
        var registry = new WorkerCapabilityRegistry();
        registry.Replace(Advertisement("export-a", Now.AddSeconds(10), Format("docx", "docx")));
        registry.Replace(Advertisement("export-a", Now, Format("pdf", "pdf")));

        var format = Assert.Single(registry.ExportFormats(Now.AddSeconds(11)));

        Assert.Equal("docx", format.Format);
    }

    [Fact]
    public void Expired_and_non_export_advertisements_are_not_available()
    {
        var registry = new WorkerCapabilityRegistry();
        registry.Replace(Advertisement("expired", Now, Format("pdf", "pdf"), TimeSpan.FromSeconds(1)));
        registry.Replace(new WorkerCapabilityAdvertisement(
            "import-a",
            "import",
            Now,
            Now.AddMinutes(2),
            [Format("docx", "docx")]));

        Assert.Empty(registry.ExportFormats(Now.AddSeconds(2)));
    }

    private static WorkerCapabilityAdvertisement Advertisement(
        string instanceId,
        DateTimeOffset occurredAt,
        ExportFormatCapability format,
        TimeSpan? lifetime = null) => new(
            instanceId,
            "export",
            occurredAt,
            occurredAt.Add(lifetime ?? TimeSpan.FromMinutes(2)),
            [format]);

    private static ExportFormatCapability Format(string format, string extension) => new(
        format,
        format.ToUpperInvariant(),
        extension,
        "application/" + format,
        Lossless: false,
        DeclaredLoss: ["Rich behavior is flattened."]);
}
