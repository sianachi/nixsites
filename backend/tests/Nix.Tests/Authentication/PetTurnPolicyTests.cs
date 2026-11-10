using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Tests.Harness;

namespace Nix.Tests.Authentication;

public sealed class PetTurnPolicyTests
{
    private const string Item = "/api/v1/items/22222222-2222-4222-8222-222222222222";
    private const string Workspace = "/api/v1/workspaces/33333333-3333-4333-8333-333333333333";

    [Theory]
    [InlineData("GET", Item)]
    [InlineData("GET", "/api/v1/search")]
    [InlineData("POST", "/api/v1/search/mentions")]
    public void A_read_token_reaches_read_routes(string method, string path) =>
        Assert.True(PetTurnPolicy.Allows(Request(method, path), Token(PetTurnMode.Read)));

    [Theory]
    [InlineData("PATCH", Item)]
    [InlineData("DELETE", Item)]
    [InlineData("POST", Item + "/move")]
    public void A_read_token_is_refused_writes_and_moves(string method, string path) =>
        Assert.False(PetTurnPolicy.Allows(Request(method, path), Token(PetTurnMode.Read)));

    [Fact]
    public void A_write_token_writes_but_does_not_administer()
    {
        var token = Token(PetTurnMode.Write);

        Assert.True(PetTurnPolicy.Allows(Request("PATCH", Item), token));
        Assert.False(PetTurnPolicy.Allows(Request("POST", Item + "/move"), token));
        Assert.False(PetTurnPolicy.Allows(Request("DELETE", Workspace), token));
        Assert.False(PetTurnPolicy.Allows(Request("POST", Workspace + "/members"), token));
        Assert.False(PetTurnPolicy.Allows(Request("PUT", Item + "/sharing"), token));
        Assert.False(PetTurnPolicy.Allows(Request("POST", Workspace + "/automations"), token));
    }

    [Fact]
    public void An_admin_token_moves()
    {
        Assert.True(PetTurnPolicy.Allows(Request("POST", Item + "/move"), Token(PetTurnMode.Admin)));
    }

    [Theory]
    [InlineData(PetTurnMode.Read)]
    [InlineData(PetTurnMode.Write)]
    [InlineData(PetTurnMode.Admin)]
    public void No_mode_reaches_interactive_only_or_human_only_routes(PetTurnMode mode)
    {
        var token = Token(mode);

        Assert.False(PetTurnPolicy.Allows(Request("GET", "/api/v1/me/pets/runtime/watch"), token));
        Assert.False(PetTurnPolicy.Allows(Request("POST", "/api/v1/me/pets/runtime"), token));
        Assert.False(PetTurnPolicy.Allows(Request("POST", "/api/v1/me/tokens"), token));
        Assert.False(PetTurnPolicy.Allows(Request("GET", "/api/v1/me/tokens"), token));
        Assert.False(PetTurnPolicy.Allows(Request("PUT", "/api/v1/me/pets/settings"), token));
        Assert.False(PetTurnPolicy.Allows(Request("POST", "/api/v1/sites/s/approval/approve"), token));
        Assert.False(PetTurnPolicy.Allows(Request("POST", "/api/v1/sites/s/approval/approve/"), token));
        Assert.False(PetTurnPolicy.Allows(Request("POST", "/api/v1/tenant/admins"), token));
        Assert.False(PetTurnPolicy.Allows(Request("POST", Workspace + "/password"), token));
    }

    [Fact]
    public void Every_shared_human_only_example_is_refused_to_an_admin_token()
    {
        // packages/api-client/src/fixtures/human-only.json is also replayed against HUMAN_ONLY in
        // TypeScript: an example the C# mirror misses fails here, an unlisted entry fails there.
        var root = Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(PublishedContract.Path())))!;
        var path = Path.Combine(root, "packages", "api-client", "src", "fixtures", "human-only.json");
        using var examples = JsonDocument.Parse(File.ReadAllText(path));
        var token = Token(PetTurnMode.Admin);

        Assert.NotEmpty(examples.RootElement.EnumerateArray());
        foreach (var example in examples.RootElement.EnumerateArray())
        {
            var method = example.GetProperty("method").GetString()!;
            var target = example.GetProperty("path").GetString()!;
            Assert.True(PetTurnPolicy.IsHumanOnly(Request(method, target)), $"{method} {target}");
            Assert.False(PetTurnPolicy.Allows(Request(method, target), token), $"{method} {target}");
        }
    }

    private static HttpRequest Request(string method, string path)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = path;
        return context.Request;
    }

    private static ValidatedPetTurnToken Token(PetTurnMode mode) =>
        new(TenantId.From(Guid.NewGuid()), PrincipalId.Create(), Guid.NewGuid(), mode);
}
