using Microsoft.AspNetCore.Http;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Tests.Authentication;

public sealed class WorkerExportDelegationPolicyTests
{
    private static readonly Guid RootItemId = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid OtherItemId = Guid.Parse("22222222-2222-4222-8222-222222222222");
    private static readonly Guid WorkspaceId = Guid.Parse("33333333-3333-4333-8333-333333333333");

    [Theory]
    [InlineData("GET", "/api/v1/items/22222222-2222-4222-8222-222222222222")]
    [InlineData("HEAD", "/api/v1/items/22222222-2222-4222-8222-222222222222/schema")]
    [InlineData("GET", "/api/v1/items/22222222-2222-4222-8222-222222222222/views")]
    public void Delegation_allows_only_the_item_metadata_routes_collaboration_reads(
        string method,
        string path)
    {
        var request = Request(method, path);

        Assert.True(WorkerExportDelegationPolicy.Allows(
            request,
            Token(),
            Execution()));
    }

    [Theory]
    [InlineData("POST", "/api/v1/items/22222222-2222-4222-8222-222222222222")]
    [InlineData("GET", "/api/v1/items/22222222-2222-4222-8222-222222222222/body")]
    [InlineData("GET", "/api/v1/search")]
    [InlineData("GET", "/api/v1/items/22222222-2222-4222-8222-222222222222/comments/watch")]
    [InlineData("GET", "/api/v1/items/not-a-guid")]
    public void Delegation_rejects_writes_and_unrelated_read_routes(string method, string path)
    {
        var request = Request(method, path);

        Assert.False(WorkerExportDelegationPolicy.Allows(
            request,
            Token(),
            Execution()));
    }

    [Theory]
    [InlineData("export.nix", true, true)]
    [InlineData("export.nix", false, false)]
    [InlineData("site.build", true, false)]
    [InlineData("site.build", false, false)]
    public void The_comments_route_is_delegated_only_to_an_export_that_asked_for_comments(string kind, bool includeComments, bool allowed)
    {
        var request = Request("GET", "/api/v1/items/22222222-2222-4222-8222-222222222222/comments");
        var execution = new WorkerExecutionAuthorization(
            Guid.Parse("44444444-4444-4444-8444-444444444444"), WorkspaceId,
            Guid.Parse("55555555-5555-4555-8555-555555555555"), kind, includeComments);

        Assert.Equal(allowed, WorkerExportDelegationPolicy.Allows(request, Token(), execution));
        // The first pass has no execution to ask yet and must not refuse what the second may allow.
        Assert.True(WorkerExportDelegationPolicy.Allows(request, Token(), execution: null));
    }

    [Fact]
    public void Collaboration_authorization_is_bound_to_the_export_root()
    {
        Assert.True(WorkerExportDelegationPolicy.Allows(
            Request("GET", $"/internal/authz/items/{RootItemId:D}"),
            Token(),
            Execution()));
        Assert.False(WorkerExportDelegationPolicy.Allows(
            Request("GET", $"/internal/authz/items/{OtherItemId:D}"),
            Token(),
            Execution()));
    }

    [Fact]
    public void Child_enumeration_is_bound_to_the_leased_workspace_and_a_parent()
    {
        var matching = Request(
            "GET",
            $"/api/v1/workspaces/{WorkspaceId:D}/items?parentId={RootItemId:D}&limit=200");
        var otherWorkspace = Request(
            "GET",
            $"/api/v1/workspaces/{Guid.NewGuid():D}/items?parentId={RootItemId:D}");
        var noParent = Request("GET", $"/api/v1/workspaces/{WorkspaceId:D}/items");

        Assert.True(WorkerExportDelegationPolicy.Allows(
            matching,
            Token(),
            Execution()));
        Assert.False(WorkerExportDelegationPolicy.Allows(
            otherWorkspace,
            Token(),
            Execution()));
        Assert.False(WorkerExportDelegationPolicy.Allows(
            noParent,
            Token(),
            Execution()));
    }

    [Fact]
    public void Item_scope_rejects_every_metadata_target_except_the_signed_root()
    {
        var token = Token() with { Scope = "item" };

        Assert.True(WorkerExportDelegationPolicy.Allows(
            Request("GET", $"/api/v1/items/{RootItemId:D}"),
            token,
            Execution()));
        Assert.False(WorkerExportDelegationPolicy.Allows(
            Request("GET", $"/api/v1/items/{OtherItemId:D}"),
            token,
            Execution()));
    }

    private static HttpRequest Request(string method, string target)
    {
        var uri = new Uri("https://core.nix.test" + target);
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = uri.AbsolutePath;
        context.Request.QueryString = new QueryString(uri.Query);
        return context.Request;
    }

    private static ValidatedWorkerExecutionToken Token() => new(
        TenantId.From(Guid.Parse("44444444-4444-4444-8444-444444444444")),
        PrincipalId.From(Guid.Parse("55555555-5555-4555-8555-555555555555")),
        Guid.Parse("66666666-6666-4666-8666-666666666666"),
        RootItemId,
        WorkspaceId,
        "subtree",
        "exporter:execution");

    private static WorkerExecutionAuthorization Execution() => new(
        Guid.Parse("44444444-4444-4444-8444-444444444444"),
        WorkspaceId,
        Guid.Parse("55555555-5555-4555-8555-555555555555"),
        "export.nix");
}
