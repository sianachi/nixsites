using Nix.Abstractions.Workers;
using Nix.Workers.Queue;

namespace Nix.Workers;

/// <summary>
/// Tells the capability registry which export formats this process renders, once, with no
/// expiry: the advertisement the Go export worker used to repeat over RabbitMQ every five seconds.
/// </summary>
public sealed class ExportCapabilityAdvertiser(IWorkerCapabilityRegistry registry, InProcessJobQueue queue, TimeProvider clock) : IHostedService
{
    /// <summary>The instance id this process advertises under; a test that fakes a worker replaces the same entry.</summary>
    public const string InstanceId = "in-process";

    /// <summary>The formats and the loss each declares, as the Go worker advertised them.</summary>
    public static IReadOnlyList<ExportFormatCapability> Formats { get; } =
    [
        new("nix", "Archive", "nix", "application/vnd.nix.archive+zip", true, []),
        new("markdown", "Markdown", "md", "text/markdown; charset=utf-8", false, ["Views and interactive metadata are represented as text."]),
        new("docx", "Word", "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", false,
            ["Interactive workspace behavior is flattened into a document.", "Links outside HTTP, HTTPS, email, and Nix are flattened to visible labels."]),
        new("pdf", "PDF", "pdf", "application/pdf", false,
            ["Interactive workspace behavior is flattened into fixed pages.", "Characters not supported by the embedded PDF fonts are replaced.", "Complex layouts and unsupported formatting may be simplified."]),
    ];

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (queue.HostedFamilies.Contains(JobFamilies.Export))
        {
            registry.Replace(new WorkerCapabilityAdvertisement(InstanceId, "export", clock.GetUtcNow(), DateTimeOffset.MaxValue, Formats));
        }
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
