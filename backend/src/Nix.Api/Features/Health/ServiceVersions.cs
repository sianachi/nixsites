using System.Collections.Concurrent;
using System.Text.RegularExpressions;

namespace Nix.Features.Health;

/// <summary>
/// The release each service runs, for Settings &gt; About: Core's own from its environment, and the
/// rest as they last reported it on Core's internal routes (collab, the workers, the sites worker).
/// </summary>
/// <remarks>
/// Held in memory: a report is refreshed on the service's next internal call, so a restart of Core
/// empties the list only until the others call again. Reports are accepted only behind the internal
/// secret, and both the names and the number of entries are bounded.
/// </remarks>
public sealed partial class ServiceVersions(IConfiguration configuration, TimeProvider clock)
{
    /// <summary>Header naming the reporting service, e.g. <c>collab</c> or <c>worker:import</c>.</summary>
    public const string ServiceHeader = "x-nix-service";

    /// <summary>Header carrying the reporting service's release version.</summary>
    public const string VersionHeader = "x-nix-release-version";

    /// <summary>Header carrying the image tag the reporting service was deployed from.</summary>
    public const string CommitHeader = "x-nix-release-commit";

    private const int MaxServices = 32;

    private readonly ConcurrentDictionary<string, ServiceVersionResponse> _reported = new(StringComparer.Ordinal);

    /// <summary>Core's own release, from the deployment's environment.</summary>
    public ServiceVersionResponse Core => new(
        "api",
        configuration["NIX_RELEASE_VERSION"] ?? string.Empty,
        configuration["NIX_RELEASE_COMMIT"] ?? string.Empty,
        clock.GetUtcNow());

    /// <summary>Records what an internal caller reports about itself, if it reports anything valid.</summary>
    public void Record(HttpRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        var service = request.Headers[ServiceHeader].ToString();
        if (service.Length == 0 || !ServicePattern().IsMatch(service))
        {
            return;
        }

        var version = request.Headers[VersionHeader].ToString();
        var commit = request.Headers[CommitHeader].ToString();
        if (!ReleasePattern().IsMatch(version) || !ReleasePattern().IsMatch(commit))
        {
            return;
        }

        if (!_reported.ContainsKey(service) && _reported.Count >= MaxServices)
        {
            return;
        }

        _reported[service] = new ServiceVersionResponse(service, version, commit, clock.GetUtcNow());
    }

    /// <summary>Core first, then every reporting service by name.</summary>
    public SystemVersionsResponse Snapshot() =>
        new([Core, .. _reported.Values.OrderBy(entry => entry.Service, StringComparer.Ordinal)]);

    [GeneratedRegex("^[a-z][a-z0-9:,_-]{0,63}$")]
    private static partial Regex ServicePattern();

    [GeneratedRegex("^[0-9A-Za-z._+-]{0,128}$")]
    private static partial Regex ReleasePattern();
}

/// <summary>The release one service runs.</summary>
/// <param name="Service">The service: <c>api</c>, <c>collab</c>, <c>sites-worker</c> or <c>worker:&lt;roles&gt;</c>.</param>
/// <param name="Version">Its release version, empty when the deployment did not set one.</param>
/// <param name="Commit">The image tag it was deployed from, normally the release commit.</param>
/// <param name="ReportedAt">When Core last heard it, or now for Core itself.</param>
public sealed record ServiceVersionResponse(string Service, string Version, string Commit, DateTimeOffset ReportedAt);

/// <summary>The services Core knows the release of.</summary>
/// <param name="Services">Core first, then the others by name.</param>
public sealed record SystemVersionsResponse(IReadOnlyList<ServiceVersionResponse> Services);
