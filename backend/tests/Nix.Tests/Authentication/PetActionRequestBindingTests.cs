using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Nix.Authentication;

namespace Nix.Tests.Authentication;

public sealed class PetActionRequestBindingTests
{
    [Fact]
    public async Task AnActionBindingCoversTheBodyAndPreservesItForTheEndpoint()
    {
        const string target = "/api/v1/items/27a0d347-097a-45c6-a615-68cc1a7937a9";
        const string body = """{"title":"Approved name"}""";
        var binding = PetActionRequestBinding.Create("PATCH", target, body);
        var request = Request("PATCH", target, body);
        Assert.True(await PetActionRequestBinding.MatchesAsync(request, binding, TestContext.Current.CancellationToken));
        using var reader = new StreamReader(request.Body, Encoding.UTF8);
        Assert.Equal(body, await reader.ReadToEndAsync(TestContext.Current.CancellationToken));

        Assert.False(await PetActionRequestBinding.MatchesAsync(
            Request("PATCH", target, """{"title":"Different name"}"""), binding, TestContext.Current.CancellationToken));
    }

    [Theory]
    [InlineData("POST", "/api/v1/items/27a0d347-097a-45c6-a615-68cc1a7937a9?one=true")]
    [InlineData("GET", "/api/v1/items/27a0d347-097a-45c6-a615-68cc1a7937a9?one=false")]
    [InlineData("GET", "/api/v1/items/a8adcb73-531b-4e77-94b9-bec86f440602?one=true")]
    [InlineData("GET", "/internal/authz/items/27a0d347-097a-45c6-a615-68cc1a7937a9")]
    public async Task AChangedMethodTargetOrQueryDoesNotUseTheApproval(string method, string target)
    {
        var binding = PetActionRequestBinding.Create(
            "GET", "/api/v1/items/27a0d347-097a-45c6-a615-68cc1a7937a9?one=true", null);
        Assert.False(await PetActionRequestBinding.MatchesAsync(Request(method, target, ""), binding, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task AChangedItemRevisionDoesNotUseTheApproval()
    {
        const string item = "27a0d347-097a-45c6-a615-68cc1a7937a9";
        const string target = "/api/v1/items/" + item;
        const string revisions = item + ":2";
        const string body = """{"title":"Approved name"}""";
        var binding = PetActionRequestBinding.Create("PATCH", target, body, revisions);
        var request = Request("PATCH", target, body);
        request.Headers["X-Nix-Pet-Item-Revisions"] = revisions;
        Assert.True(await PetActionRequestBinding.MatchesAsync(request, binding, TestContext.Current.CancellationToken));

        request.Headers["X-Nix-Pet-Item-Revisions"] = item + ":3";
        Assert.False(await PetActionRequestBinding.MatchesAsync(request, binding, TestContext.Current.CancellationToken));
    }

    private static HttpRequest Request(string method, string target, string body)
    {
        var context = new DefaultHttpContext();
        context.Features.Get<IHttpRequestFeature>()!.RawTarget = target;
        context.Request.Method = method;
        context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(body));
        return context.Request;
    }
}
