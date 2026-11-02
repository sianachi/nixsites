using System.Text.Json.Nodes;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Integration.Tests.ViewCompute;

/// <summary>
/// The golden fixtures of <c>packages/view-compute/fixtures/&lt;slice&gt;/*.json</c>, replayed through
/// Core's own handlers so the offline TypeScript port and Core cannot drift. The format is described
/// in <c>packages/view-compute/src/fixture.test-helper.ts</c>: items named by <c>key</c>, ids written
/// <c>{key}</c>, the workspace <c>{workspace}</c> (the seeded Alpha workspace here).
/// </summary>
internal static class ViewComputeFixtures
{
    /// <summary>Every fixture of one slice, sorted by file name.</summary>
    public static IReadOnlyList<ViewComputeFixture> Load(string slice) =>
        throw new NotImplementedException("Lane A7 implements the fixture runner.");

    /// <summary>
    /// Creates the fixture's items in order (type, title, parent, properties, then schema, views and
    /// recurrence where given) under the given workspace, and returns the minted ids by key.
    /// </summary>
    public static Task<FixtureIds> SeedAsync(
        NixDispatcher dispatcher, WorkspaceId workspace, ViewComputeFixture fixture, CancellationToken cancellationToken) =>
        throw new NotImplementedException("Lane A7 implements the fixture runner.");

    /// <summary>Replaces <c>{key}</c> and <c>{workspace}</c> with the seeded ids (request paths and bodies).</summary>
    public static string ToIds(string text, FixtureIds ids) =>
        throw new NotImplementedException("Lane A7 implements the fixture runner.");

    /// <summary>Writes seeded ids back as <c>{key}</c>, for comparison with <see cref="ViewComputeFixture.Expected"/>.</summary>
    public static JsonNode? ToKeys(JsonNode? answer, FixtureIds ids) =>
        throw new NotImplementedException("Lane A7 implements the fixture runner.");
}

// shortcut: CA1812 off until the runner (lane A7) builds these; remove the pragma with it.
#pragma warning disable CA1812
/// <param name="Expected">Core's answer: <c>{ "status": 200, "body": … }</c> or <c>{ "status", "code", "detail" }</c>.</param>
internal sealed record ViewComputeFixture(
    string Name,
    DateTimeOffset Now,
    JsonArray Items,
    JsonObject Request,
    JsonObject Expected);

/// <summary>The ids Core minted for one seeded fixture.</summary>
internal sealed record FixtureIds(WorkspaceId Workspace, IReadOnlyDictionary<string, ItemId> ByKey);
#pragma warning restore CA1812
