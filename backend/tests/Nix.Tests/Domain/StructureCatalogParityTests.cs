using System.Text.Json.Nodes;
using Nix.Domain.Properties;
using Nix.Domain.Views;

namespace Nix.Tests.Domain;

/// <summary>
/// The pet's capability catalog (<c>packages/structure-spec/src/generated/catalog.json</c>) names
/// property types, view kinds, query operators, rollup aggregates and form vocabulary the backend
/// already owns a closed set for. These tests read the committed catalog back and assert it names
/// exactly the backend's own sets, so a set changing on one side without the other fails a build
/// instead of drifting until the pet claims - or is refused - a capability it does not have.
/// </summary>
/// <remarks>
/// The catalog is generated (<c>pnpm --filter @nix/structure-spec catalog</c>) and never hand-
/// edited; a mismatch here means either the generator's input tables
/// (<c>packages/structure-spec/src/catalog/tables.ts</c>) are stale or the backend enum grew
/// without the generator being re-run, not that this test should be adjusted to match.
/// </remarks>
public sealed class StructureCatalogParityTests
{
    private static readonly Lazy<JsonObject> Catalog = new(LoadCatalog);

    [Fact]
    public void Catalog_property_types_plus_assignee_equal_every_property_type_this_build_defines()
    {
        var catalogTypes = Names(Catalog.Value, "propertyTypes", "type");
        Assert.DoesNotContain("assignee", catalogTypes);
        catalogTypes.Add("assignee");

        var backendTypes = Enum.GetValues<PropertyType>().Select(PropertyTypes.ToText).ToHashSet(StringComparer.Ordinal);

        Assert.Equal(backendTypes, catalogTypes);
    }

    [Fact]
    public void Catalog_view_kinds_plus_drive_equal_every_view_kind_this_build_defines()
    {
        var catalogKinds = Names(Catalog.Value, "viewKinds", "kind");
        Assert.DoesNotContain("drive", catalogKinds);
        catalogKinds.Add("drive");

        var backendKinds = ViewKinds.All.Select(descriptor => descriptor.Text).ToHashSet(StringComparer.Ordinal);

        Assert.Equal(backendKinds, catalogKinds);
    }

    [Fact]
    public void Each_catalog_view_kind_requirement_matches_its_descriptor_requirement()
    {
        var viewKinds = (JsonArray)Catalog.Value["viewKinds"]!;

        foreach (var entry in viewKinds)
        {
            var kind = (string)entry!["kind"]!;
            var descriptor = ViewKinds.All.Single(candidate => candidate.Text == kind);
            var requires = entry["requires"];

            if (requires is null)
            {
                Assert.Null(descriptor.Requirement);
                continue;
            }

            Assert.NotNull(descriptor.Requirement);

            // The catalog lists the property types each requirement accepts, drawn from the web's
            // own predicates. Comparing that list with the descriptor's Accepts for every
            // PropertyType is what "the same rule" means: a shape's name ("select",
            // "date-shaped") says nothing about which types a predicate admits.
            var accepts = ((JsonArray)requires["accepts"]!)
                .Select(node => (string)node!)
                .ToHashSet(StringComparer.Ordinal);

            foreach (var type in Enum.GetValues<PropertyType>())
            {
                Assert.True(
                    accepts.Contains(PropertyTypes.ToText(type)) == descriptor.Requirement.Accepts(type),
                    $"'{kind}' and the catalog disagree about '{PropertyTypes.ToText(type)}'.");
            }
        }
    }

    [Fact]
    public void Board_and_chart_requirements_are_CanGroupBy_and_CanChartBy_for_every_property_type()
    {
        // Pins which backend predicate each kind is held to, so the catalog comparison above is
        // also a comparison with CanGroupBy and CanChartBy, the two that must widen apart.
        var board = ViewKinds.All.Single(candidate => candidate.Kind == ViewKind.Board).Requirement!;
        var chart = ViewKinds.All.Single(candidate => candidate.Kind == ViewKind.Chart).Requirement!;

        foreach (var type in Enum.GetValues<PropertyType>())
        {
            Assert.Equal(type.CanGroupBy(), board.Accepts(type));
            Assert.Equal(type.CanChartBy(), chart.Accepts(type));
        }
    }

    [Fact]
    public void Catalog_query_operators_equal_the_operators_QueryOperators_defines()
    {
        // The catalog tells the pet what a smart list may filter with, and a smart list is a query
        // view: compiled to SQL, so it is the compiled set and not the wider container-view set
        // (ADR-0054) that the two must agree on.
        var catalogOperators = Names(Catalog.Value, "queryOperators", "op");
        var backendOperators = QueryOperators.CompiledByQuery.ToHashSet(StringComparer.Ordinal);

        Assert.Equal(backendOperators, catalogOperators);
    }

    [Fact]
    public void Catalog_rollup_aggregates_equal_every_rollup_aggregate_this_build_defines()
    {
        var catalogAggregates = Names(Catalog.Value, "rollupAggregates", "value");

        var backendAggregates = Enum.GetValues<RollupAggregate>()
            .Select(RollupAggregates.ToText)
            .ToHashSet(StringComparer.Ordinal);

        Assert.Equal(backendAggregates, catalogAggregates);
    }

    [Fact]
    public void Catalog_form_block_kinds_and_condition_operators_equal_ViewDefinitionRules()
    {
        var formRules = (JsonObject)Catalog.Value["formRules"]!;

        var catalogBlockKinds = ((JsonArray)formRules["blockKinds"]!).Select(node => (string)node!).ToHashSet(StringComparer.Ordinal);
        var catalogConditionOperators = ((JsonArray)formRules["conditionOperators"]!).Select(node => (string)node!).ToHashSet(StringComparer.Ordinal);

        Assert.Equal(ViewDefinitionRules.FormBlockKinds.ToHashSet(StringComparer.Ordinal), catalogBlockKinds);
        Assert.Equal(ViewDefinitionRules.FormConditionOperators.ToHashSet(StringComparer.Ordinal), catalogConditionOperators);
    }

    private static HashSet<string> Names(JsonObject catalog, string arrayProperty, string nameProperty)
    {
        var array = (JsonArray)catalog[arrayProperty]!;
        return array.Select(entry => (string)entry![nameProperty]!).ToHashSet(StringComparer.Ordinal);
    }

    private static JsonObject LoadCatalog()
    {
        var path = CatalogPath();
        var json = File.ReadAllText(path);
        return JsonNode.Parse(json) as JsonObject
            ?? throw new InvalidOperationException($"{path} did not parse as a JSON object.");
    }

    /// <summary>
    /// The path to the generated catalog, found by walking up from the test assembly to the
    /// repository root, the same way <see cref="Harness.PublishedContract"/> locates the committed
    /// OpenAPI contract: a relative path counted in <c>..</c> segments changes with the target
    /// framework and the build configuration and nothing fails until it does.
    /// </summary>
    private static string CatalogPath()
    {
        const string rootMarker = "Nix.slnx";
        const string catalogPath = "packages/structure-spec/src/generated/catalog.json";

        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (!File.Exists(Path.Combine(directory.FullName, rootMarker)))
            {
                continue;
            }

            var catalog = Path.Combine(directory.FullName, catalogPath);
            return File.Exists(catalog)
                ? catalog
                : throw new InvalidOperationException(
                    $"Found the repository root at {directory.FullName} but no catalog at {catalog}. "
                    + "Run: pnpm --filter @nix/structure-spec catalog");
        }

        throw new InvalidOperationException($"No {rootMarker} above {AppContext.BaseDirectory}, so the repository root could not be found.");
    }
}
