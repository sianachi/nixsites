using System.Text.Json;

namespace Nix.Integration.Tests.Harness;

internal static class HttpProblem
{
    /// <summary>Reads the stable code of a problem response; throws when the body has none.</summary>
    public static async Task<string?> CodeAsync(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        return document.RootElement.GetProperty("code").GetString();
    }
}
