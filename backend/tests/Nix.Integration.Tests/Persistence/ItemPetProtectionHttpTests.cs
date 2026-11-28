using System.Net;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class ItemPetProtectionHttpTests(NixPostgresFixture fixture)
{
    [Fact]
    public async Task Only_a_signed_in_workspace_owner_can_change_pet_protection_and_must_supply_a_boolean()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await using var host = SiteHttpHost.Create(fixture);
        var owner = await host.InteractiveTokenAsync(TestTenants.AlphaContext);
        var token = await host.TokenAsync(TestTenants.AlphaContext);
        var item = $"/api/v1/items/{M0SchemaSeed.Alpha.ItemId:D}";
        var route = item + "/pet-protection";
        var aggregateRoute = $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/pet-protection";

        using var missing = await host.SendAsync(HttpMethod.Put, route, owner, new { });
        Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
        Assert.Equal("items.pet_protection_required", await SiteHttpHost.ProblemCodeAsync(missing));

        using var mark = await host.SendAsync(HttpMethod.Put, route, owner, new { withholdFromPets = true });
        Assert.Equal(HttpStatusCode.OK, mark.StatusCode);
        using var marked = await SiteHttpHost.JsonAsync(mark);
        Assert.True(marked.RootElement.GetProperty("settings").GetProperty("withholdFromPets").GetBoolean());

        using var ownerSummary = await host.SendAsync(HttpMethod.Get, aggregateRoute, owner);
        Assert.Equal(HttpStatusCode.OK, ownerSummary.StatusCode);
        using var summary = await SiteHttpHost.JsonAsync(ownerSummary);
        Assert.True(summary.RootElement.GetProperty("hasProtectedItems").GetBoolean());

        using var agentClear = await host.SendAsync(HttpMethod.Put, route, token, new { withholdFromPets = false });
        Assert.Equal(HttpStatusCode.Forbidden, agentClear.StatusCode);
        using var agentSummary = await host.SendAsync(HttpMethod.Get, aggregateRoute, token);
        Assert.Equal(HttpStatusCode.NotFound, agentSummary.StatusCode);

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                UPDATE workspace_member SET role = 'editor'
                WHERE workspace_id = '{M0SchemaSeed.Alpha.WorkspaceId:D}' AND subject_id = '{M0SchemaSeed.Alpha.PrincipalId:D}'
                """);
        }

        using var editorClear = await host.SendAsync(HttpMethod.Put, route, owner, new { withholdFromPets = false });
        Assert.Equal(HttpStatusCode.NotFound, editorClear.StatusCode);
        using var editorSummary = await host.SendAsync(HttpMethod.Get, aggregateRoute, owner);
        Assert.Equal(HttpStatusCode.NotFound, editorSummary.StatusCode);
        using var current = await host.SendAsync(HttpMethod.Get, item, owner);
        Assert.Equal(HttpStatusCode.OK, current.StatusCode);
        using var stored = await SiteHttpHost.JsonAsync(current);
        Assert.True(stored.RootElement.GetProperty("settings").GetProperty("withholdFromPets").GetBoolean());
    }

    [Fact]
    public async Task A_marked_item_disappears_from_the_pet_turns_core_and_collaboration_reads()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await using var host = SiteHttpHost.Create(fixture);
        var owner = await host.InteractiveTokenAsync(TestTenants.AlphaContext);
        var pet = host.PetTurnToken(TestTenants.AlphaContext);
        var itemId = M0SchemaSeed.Alpha.ItemId;
        var item = $"/api/v1/items/{itemId:D}";
        var authz = $"/internal/authz/items/{itemId:D}";
        const string search = "/api/v1/search?q=petprotectioncanary";
        var petPicker = search + $"&petWorkspaceId={M0SchemaSeed.Alpha.WorkspaceId:D}";

        using var renamed = await host.SendAsync(HttpMethod.Patch, item, owner, new { title = "petprotectioncanary" });
        Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
        using var before = await host.SendAsync(HttpMethod.Get, item, pet);
        using var beforeCollab = await host.InternalBearerAsync(HttpMethod.Get, authz, pet);
        Assert.Equal(HttpStatusCode.OK, before.StatusCode);
        Assert.Equal(HttpStatusCode.OK, beforeCollab.StatusCode);

        using var mark = await host.SendAsync(HttpMethod.Put, item + "/pet-protection", owner, new { withholdFromPets = true });
        Assert.Equal(HttpStatusCode.OK, mark.StatusCode);

        using var marked = await host.SendAsync(HttpMethod.Get, item, pet);
        using var markedCollab = await host.InternalBearerAsync(HttpMethod.Get, authz, pet);
        Assert.Equal(HttpStatusCode.NotFound, marked.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, markedCollab.StatusCode);

        using var human = await host.SendAsync(HttpMethod.Get, item, owner);
        using var humanCollab = await host.InternalBearerAsync(HttpMethod.Get, authz, owner);
        Assert.Equal(HttpStatusCode.OK, human.StatusCode);
        Assert.Equal(HttpStatusCode.OK, humanCollab.StatusCode);

        using var humanSearch = await host.SendAsync(HttpMethod.Get, search, owner);
        using var humanHits = await SiteHttpHost.JsonAsync(humanSearch);
        Assert.Equal(itemId, Assert.Single(humanHits.RootElement.GetProperty("results").EnumerateArray()).GetProperty("id").GetGuid());

        using var petSearch = await host.SendAsync(HttpMethod.Get, search, pet);
        using var petHits = await SiteHttpHost.JsonAsync(petSearch);
        Assert.Empty(petHits.RootElement.GetProperty("results").EnumerateArray());

        using var pickerSearch = await host.SendAsync(HttpMethod.Get, petPicker, owner);
        using var pickerHits = await SiteHttpHost.JsonAsync(pickerSearch);
        Assert.Empty(pickerHits.RootElement.GetProperty("results").EnumerateArray());
    }
}
