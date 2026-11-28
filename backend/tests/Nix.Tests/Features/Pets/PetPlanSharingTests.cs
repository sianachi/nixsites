using System.Reflection;
using Nix.Features.Pets;

namespace Nix.Tests.Features.Pets;

public sealed class PetPlanSharingTests
{
    private static readonly Assembly Core = typeof(PetWorkerClient).Assembly;

    [Fact]
    public void Canonical_scope_is_order_independent_but_bound_to_every_source_workspace_and_pet()
    {
        var workspace = Guid.NewGuid();
        var pet = Guid.NewGuid();
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        var digest = Scope(workspace, pet, "selected", [first, second]);
        Assert.Equal(digest, Scope(workspace, pet, "selected", [second, first, first]));
        Assert.NotEqual(digest, Scope(workspace, pet, "selected", [first]));
        Assert.NotEqual(digest, Scope(Guid.NewGuid(), pet, "selected", [first, second]));
        Assert.NotEqual(digest, Scope(workspace, Guid.NewGuid(), "selected", [first, second]));
        Assert.NotEqual(digest, Scope(workspace, pet, "subtree", [first, second]));
        Assert.NotEqual(digest, Scope(workspace, pet, "selected", [first, second], [Guid.NewGuid()]));
        var readOnlyWorkspace = Guid.NewGuid();
        Assert.Equal(Scope(workspace, pet, "selected", [first], [readOnlyWorkspace]),
            Scope(workspace, pet, "selected", [first], [readOnlyWorkspace, readOnlyWorkspace]));
    }

    [Fact]
    public void Every_recipient_component_changes_the_revision_without_key_material()
    {
        var baseline = Recipient("openrouter", "https://openrouter.ai/api/v1", "router", "epoch-one");
        Assert.NotEqual(baseline, Recipient("openai", "https://openrouter.ai/api/v1", "router", "epoch-one"));
        Assert.NotEqual(baseline, Recipient("openrouter", "https://other.test", "router", "epoch-one"));
        Assert.NotEqual(baseline, Recipient("openrouter", "https://openrouter.ai/api/v1", "direct", "epoch-one"));
        Assert.NotEqual(baseline, Recipient("openrouter", "https://openrouter.ai/api/v1", "router", "epoch-two"));
        Assert.Matches("^[0-9a-f]{64}$", baseline);
    }

    [Theory]
    [InlineData("pet_plans")]
    [InlineData("pet_plan_decide")]
    [InlineData("pet_plan_decision_context")]
    [InlineData("pet_sharing_decide")]
    [InlineData("nix.pet_plan_decide")]
    [InlineData("mcp__nix__pet_plans")]
    public void Operator_decisions_cannot_be_registered_as_companion_remote_tools(string tool)
    {
        var policy = Core.GetType("Nix.Features.PetRuns.PetPlanOperatorToolPolicy", throwOnError: true)!;
        var method = policy.GetMethod("IsDecisionTool", BindingFlags.Static | BindingFlags.NonPublic)!;
        Assert.Equal(true, method.Invoke(null, [tool]));
        Assert.Equal(false, method.Invoke(null, ["third_party_search"]));
        Assert.Equal(false, method.Invoke(null, ["pet_planet_search"]));
    }

    [Fact]
    public void Owner_text_pinning_needs_only_a_saved_key_not_a_browser_session()
    {
        var service = Core.GetType("Nix.Features.PetRuns.PetPlanSharingService", throwOnError: true)!;
        var parameters = service.GetConstructors().Single().GetParameters().Select(value => value.ParameterType.Name);
        Assert.DoesNotContain("BrowserAccess", parameters);
        Assert.DoesNotContain("IHttpContextAccessor", parameters);
    }

    private static string Scope(Guid workspace, Guid pet, string kind, Guid[] sources, Guid[]? readOnlyWorkspaces = null)
    {
        var scopeType = Core.GetType("Nix.Features.PetRuns.PetPlanSourceScope", throwOnError: true)!;
        var scope = Activator.CreateInstance(scopeType, [kind, sources, readOnlyWorkspaces]);
        return Invoke("ScopeDigest", [workspace, pet, scope]);
    }

    private static string Recipient(string provider, string destination, string routing, string epoch)
    {
        var type = Core.GetType("Nix.Features.PetRuns.PetPlanRecipientDescriptor", throwOnError: true)!;
        return Invoke("RecipientRevision", [Activator.CreateInstance(type, [provider, destination, routing, epoch])]);
    }

    private static string Invoke(string methodName, object?[] arguments)
    {
        var service = Core.GetType("Nix.Features.PetRuns.PetPlanSharingService", throwOnError: true)!;
        var method = service.GetMethod(methodName, BindingFlags.Static | BindingFlags.NonPublic)!;
        return Assert.IsType<string>(method.Invoke(null, arguments));
    }
}
