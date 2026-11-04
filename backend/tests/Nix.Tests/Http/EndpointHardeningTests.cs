using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Nix.Http;
using Nix.Tests.Harness;

namespace Nix.Tests.Http;

/// <summary>
/// Every route that mutates state carries the writes rate-limit policy (or the narrower policy its
/// route names below - the mention lookup is a POST that reads, and has its own), and the one route with a
/// legitimately large payload declares its own body bound - proven against the real application's
/// route table, so a new mutating endpoint registered without the policy fails here rather than
/// shipping unlimited.
/// </summary>
public sealed class EndpointHardeningTests(ContractHostFactory factory)
    : IClassFixture<ContractHostFactory>
{
    private static readonly string[] MutatingMethods = ["POST", "PUT", "PATCH", "DELETE"];

    private static readonly System.Text.Json.JsonSerializerOptions WebJson =
        new(System.Text.Json.JsonSerializerDefaults.Web);

    [Fact]
    public void Every_mutating_endpoint_requires_its_expected_rate_limit_policy()
    {
        var unlimited = MutatingEndpoints()
            .Where(endpoint => !IsInternal(endpoint))
            .Where(endpoint => endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()?.PolicyName
                != ExpectedPolicy(endpoint))
            .Select(endpoint => endpoint.DisplayName)
            .ToList();

        Assert.Empty(unlimited);
    }

    [Fact]
    public void Internal_mutations_do_not_use_the_pre_authentication_address_partition()
    {
        var addressPartitioned = MutatingEndpoints()
            .Where(IsInternal)
            .Where(endpoint => endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>() is not null)
            .Select(endpoint => endpoint.DisplayName)
            .ToList();

        Assert.Empty(addressPartitioned);
    }

    [Fact]
    public void The_canvas_library_put_declares_its_two_mebibyte_body_bound()
    {
        var endpoint = Assert.Single(
            MutatingEndpoints(),
            e => e.RoutePattern.RawText == "/api/v1/me/canvas-library");

        var declared = endpoint.Metadata.GetMetadata<RequestBodyLimitMetadata>();

        Assert.NotNull(declared);
        Assert.Equal(2 * 1024 * 1024, declared.MaxRequestBodyBytes);
    }

    [Fact]
    public void The_mention_lookup_declares_a_body_bound_its_largest_legitimate_request_fits_under()
    {
        var endpoint = Assert.Single(
            MutatingEndpoints(),
            e => e.RoutePattern.RawText == "/api/v1/search/mentions");
        var declared = endpoint.Metadata.GetMetadata<RequestBodyLimitMetadata>();
        Assert.NotNull(declared);
        Assert.Equal(48 * 1024, declared.MaxRequestBodyBytes);

        // The worst a well-behaved client can send: the longest passage with every character
        // escaped by the web serialiser ('<' becomes \u003C) and the most exclusions. It must fit,
        // and a body of twice as many exclusions must not - which is what the 413 refuses.
        static int Size(int exclusions) => System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(
            new
            {
                text = new string('<', Nix.Features.Search.FindMentionsHandler.MaximumTextLength),
                workspaceId = Guid.NewGuid(),
                excludeIds = Enumerable.Range(0, exclusions).Select(_ => Guid.NewGuid()).ToArray(),
            },
            WebJson).Length;

        Assert.True(Size(Nix.Features.Search.FindMentionsHandler.MaximumExclusions) <= declared.MaxRequestBodyBytes);
        Assert.True(Size(4 * Nix.Features.Search.FindMentionsHandler.MaximumExclusions) > declared.MaxRequestBodyBytes);
    }

    [Theory]
    [InlineData("/api/v1/workspaces/{workspaceId:guid}/query")]
    [InlineData("/api/v1/workspaces/{workspaceId:guid}/query/aggregate")]
    public void The_ad_hoc_query_declares_a_body_bound_its_largest_legitimate_request_fits_under(string route)
    {
        var endpoint = Assert.Single(MutatingEndpoints(), e => e.RoutePattern.RawText == route);
        var declared = endpoint.Metadata.GetMetadata<RequestBodyLimitMetadata>();
        Assert.NotNull(declared);

        // The worst a well-behaved client can send: the most rules at the longest value, every
        // character escaped by the web serialiser, and the longest group order.
        var value = new string('<', Nix.Domain.Views.QueryOperators.MaximumValueLength);
        var largest = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(
            new
            {
                filters = Enumerable.Range(0, Nix.Domain.Views.QueryRules.MaximumRules)
                    .Select(_ => new { property = new string('k', 128), @operator = "contains", value })
                    .ToArray(),
                groupBy = new
                {
                    property = new string('k', 128),
                    order = Enumerable.Range(0, Nix.Features.Query.WorkspaceQueryHandler.MaximumGroupOrder)
                        .Select(_ => new string('<', Nix.Domain.Views.QueryOperators.MaximumPropertyLength))
                        .ToArray(),
                },
                today = "2026-08-15",
            },
            WebJson).Length;

        Assert.True(largest <= declared.MaxRequestBodyBytes);
    }

    [Fact]
    public void No_read_endpoint_declares_a_raised_body_bound()
    {
        // A raised bound on a GET would say some read expects a body, which none does; the raise
        // exists solely for the canvas library replacement.
        var raisedReads = Routes()
            .Where(endpoint => !IsMutating(endpoint))
            .Where(endpoint => endpoint.Metadata.GetMetadata<RequestBodyLimitMetadata>() is not null)
            .Select(endpoint => endpoint.DisplayName)
            .ToList();

        Assert.Empty(raisedReads);
    }

    [Fact]
    public void The_native_reconciliation_body_bound_accepts_five_hundred_identifiers()
    {
        var endpoint = Assert.Single(MutatingEndpoints(),
            e => e.RoutePattern.RawText == "/api/v1/workspaces/{workspaceId:guid}/sync/reconcile");
        var declared = endpoint.Metadata.GetMetadata<RequestBodyLimitMetadata>();
        Assert.NotNull(declared);
        var request = new { itemIds = Enumerable.Range(0, 500).Select(_ => Guid.NewGuid()).ToArray() };
        Assert.True(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(request, WebJson).Length <= declared.MaxRequestBodyBytes);
        var oversized = new { itemIds = Enumerable.Range(0, 1_000).Select(_ => Guid.NewGuid()).ToArray() };
        Assert.True(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(oversized, WebJson).Length > declared.MaxRequestBodyBytes);
    }

    /// <summary>
    /// The policy each mutating route is expected to carry. The two unauthenticated public
    /// surfaces carry their own windows; every other mutation shares the writes policy.
    /// </summary>
    private static string ExpectedPolicy(RouteEndpoint endpoint) => endpoint.RoutePattern.RawText switch
    {
        "/public/v1/forms/{token}" => RateLimitRefusal.PublicFormsPolicyName,
        "/public/v1/auth/token" => RateLimitRefusal.TokenExchangePolicyName,

        // Every route that checks an item-lock password carries the tighter lock policy instead.
        // Relocking shares the unlock path but checks nothing, so it keeps the writes policy.
        "/api/v1/items/{itemId:guid}/lock" or "/api/v1/items/{itemId:guid}/lock/remove" =>
            RateLimitRefusal.LockPasswordPolicyName,
        "/api/v1/items/{itemId:guid}/unlock" when !IsDelete(endpoint) =>
            RateLimitRefusal.LockPasswordPolicyName,

        // A read sent as a POST: its own window, so lookups while typing never spend the writes
        // window a person's saves draw on.
        "/api/v1/search/mentions" => RateLimitRefusal.SuggestionsPolicyName,

        // The ad-hoc query and its aggregate: reads sent as POSTs, on their own window, so a
        // dashboard's tiles or an assistant's lookups never spend a person's saves.
        "/api/v1/workspaces/{workspaceId:guid}/query"
            or "/api/v1/workspaces/{workspaceId:guid}/query/aggregate"
            or "/api/v1/workspaces/{workspaceId:guid}/sync/reconcile" => RateLimitRefusal.QueriesPolicyName,
        _ => RateLimitRefusal.WritesPolicyName,
    };

    private static bool IsDelete(RouteEndpoint endpoint) =>
        endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods.Contains("DELETE") == true;

    private List<RouteEndpoint> MutatingEndpoints() =>
        [.. Routes().Where(IsMutating)];

    private List<RouteEndpoint> Routes() =>
        [.. factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()];

    private static bool IsMutating(RouteEndpoint endpoint)
    {
        var methods = endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods;
        return methods is not null && methods.Any(MutatingMethods.Contains);
    }

    private static bool IsInternal(RouteEndpoint endpoint) =>
        endpoint.RoutePattern.RawText?.StartsWith("/internal", StringComparison.Ordinal) is true;
}
