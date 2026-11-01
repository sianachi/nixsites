using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Nix.Features.Health;

namespace Nix.Tests.Features.Health;

public sealed class ServiceVersionsTests
{
    private static ServiceVersions Create() => new(
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["NIX_RELEASE_VERSION"] = "0.5.0",
            ["NIX_RELEASE_COMMIT"] = "e0fa7e43",
        }).Build(),
        TimeProvider.System);

    private static HttpRequest Request(string service, string version = "0.5.0", string commit = "e0fa7e43")
    {
        var context = new DefaultHttpContext();
        context.Request.Headers[ServiceVersions.ServiceHeader] = service;
        context.Request.Headers[ServiceVersions.VersionHeader] = version;
        context.Request.Headers[ServiceVersions.CommitHeader] = commit;
        return context.Request;
    }

    [Fact]
    public void Core_reports_its_own_release_first_then_the_others_by_name()
    {
        var versions = Create();
        versions.Record(Request("worker:import"));
        versions.Record(Request("collab", commit: "older"));

        var services = versions.Snapshot().Services;

        Assert.Equal(["api", "collab", "worker:import"], services.Select(entry => entry.Service));
        Assert.Equal("0.5.0", services[0].Version);
        Assert.Equal("older", services[1].Commit);
    }

    [Fact]
    public void A_later_report_replaces_the_earlier_one()
    {
        var versions = Create();
        versions.Record(Request("collab", commit: "older"));
        versions.Record(Request("collab", commit: "newer"));

        Assert.Equal("newer", Assert.Single(versions.Snapshot().Services, entry => entry.Service == "collab").Commit);
    }

    [Theory]
    [InlineData("", "0.5.0", "abc")]
    [InlineData("Collab", "0.5.0", "abc")]
    [InlineData("collab<script>", "0.5.0", "abc")]
    [InlineData("collab", "0.5.0 beta", "abc")]
    [InlineData("collab", "0.5.0", "abc;rm")]
    public void Malformed_reports_are_ignored(string service, string version, string commit)
    {
        var versions = Create();
        versions.Record(Request(service, version, commit));

        Assert.Equal("api", Assert.Single(versions.Snapshot().Services).Service);
    }

    [Fact]
    public void The_number_of_services_is_bounded()
    {
        var versions = Create();
        for (var index = 0; index < 100; index++)
        {
            versions.Record(Request($"worker:role{index}"));
        }

        Assert.Equal(33, versions.Snapshot().Services.Count);
    }
}
