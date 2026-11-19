using System.Text.Json;

namespace Nix.Features.PetRuns;

internal sealed record PetCapabilityDefinition(string Id, string Mode, string? Method, string? Path, string? Executor);

/// <summary>The shared, deliberate disposition of each published Core or native editor action.</summary>
internal static class PetCapabilities
{
    private static readonly IReadOnlyDictionary<string, PetCapabilityDefinition> Definitions = Read();

    internal static PetCapabilityDefinition? Find(string id) => Definitions.GetValueOrDefault(id);

    internal static IEnumerable<string> FencedWrites => Definitions.Values
        .Where(definition => definition.Method is not null && definition.Mode != "read" && definition.Executor == "nix.action")
        .Select(definition => definition.Id);

    private static Dictionary<string, PetCapabilityDefinition> Read()
    {
        using var resource = typeof(PetCapabilities).Assembly.GetManifestResourceStream("Nix.PetCapabilities.json")
            ?? throw new InvalidOperationException("The pet capability manifest was not embedded.");
        using var document = JsonDocument.Parse(resource);
        return document.RootElement.EnumerateObject().ToDictionary(
            property => property.Name,
            property => new PetCapabilityDefinition(
                property.Name,
                property.Value.GetProperty("mode").GetString()!,
                property.Value.TryGetProperty("method", out var method) ? method.GetString() : null,
                property.Value.TryGetProperty("path", out var path) ? path.GetString() : null,
                property.Value.TryGetProperty("executor", out var executor) ? executor.GetString() : null),
            StringComparer.Ordinal);
    }
}
