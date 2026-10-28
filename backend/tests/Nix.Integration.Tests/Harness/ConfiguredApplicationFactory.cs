using Microsoft.AspNetCore.Mvc.Testing;

namespace Nix.Integration.Tests.Harness;

/// <summary>The real application host with the given configuration settings applied.</summary>
/// <param name="settings">Configuration keys and values, applied as host settings.</param>
internal sealed class ConfiguredApplicationFactory(Dictionary<string, string?> settings) : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        foreach (var (key, value) in settings)
        {
            builder.UseSetting(key, value);
        }
    }
}
