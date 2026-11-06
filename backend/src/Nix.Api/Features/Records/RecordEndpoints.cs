using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http.HttpResults;
using Nix.Errors;
using Nix.Features.Items;
using Nix.Http;

namespace Nix.Features.Records;

/// <summary>Finds items by the exact value of one property. Url and Text values match in their canonical form.</summary>
/// <param name="Key">The property key.</param>
/// <param name="Value">The value to match.</param>
/// <param name="ParentId">Limits the search to the direct children of this item, or null for the whole workspace.</param>
internal sealed record LookupItemsRequest(string Key, string Value, Guid? ParentId = null);

/// <summary>One lookup match. A trashed item is reported, not hidden.</summary>
internal sealed record LookupMatch(ItemResponse Item, bool Trashed);

/// <summary>The matches of a lookup, at most 500.</summary>
internal sealed record LookupItemsResponse(IReadOnlyList<LookupMatch> Matches);

/// <summary>One refused property: its key and why.</summary>
internal sealed record PropertyViolation(string Key, string Reason);

/// <summary>Creates or updates the child of the route's parent whose unique field equals <c>KeyValue</c>.</summary>
/// <param name="KeyField">A unique field declared in the parent's schema.</param>
/// <param name="KeyValue">The value identifying the record; canonicalised before use.</param>
/// <param name="Title">The title on create; on update, a changed title.</param>
/// <param name="Properties">Field values; merged into an existing record. Includes the key field.</param>
/// <param name="Type">The item type on create; defaults to note.</param>
/// <param name="IdempotencyKey">Same key and body replays the stored response; same key with a different body is a 409.</param>
/// <param name="Strict">Refuse undeclared keys and enforce required fields. On by default.</param>
internal sealed record UpsertRecordRequest(
    string KeyField,
    string KeyValue,
    string? Title = null,
    JsonObject? Properties = null,
    string? Type = null,
    string? IdempotencyKey = null,
    bool Strict = true);

/// <summary>The result of an upsert: <c>created</c>, <c>updated</c> or <c>unchanged</c>, with the persisted item.</summary>
internal sealed record UpsertRecordResponse(string Outcome, ItemResponse Item);

/// <summary>
/// One batch row. With <c>KeyField</c> and <c>KeyValue</c> it is an upsert; with <c>ItemId</c> an
/// update; with neither a create, which must carry an <c>IdempotencyKey</c>.
/// </summary>
internal sealed record BatchRecordRow(
    Guid ParentId,
    string? KeyField = null,
    string? KeyValue = null,
    Guid? ItemId = null,
    string? Title = null,
    JsonObject? Properties = null,
    string? Type = null,
    string? IdempotencyKey = null);

/// <summary>Up to 100 rows, each applied in its own savepoint.</summary>
/// <param name="Strict">Applies to every row. On by default.</param>
internal sealed record BatchRecordsRequest(IReadOnlyList<BatchRecordRow> Rows, bool Strict = true);

/// <summary>Why one batch row failed.</summary>
/// <param name="ExistingItemId">The item a conflict collided with, when there is one.</param>
internal sealed record BatchRecordError(
    string Code,
    string Message,
    IReadOnlyList<PropertyViolation>? Violations = null,
    Guid? ExistingItemId = null);

/// <summary>One row's result, in request order. <c>Status</c> is created, updated, unchanged or error.</summary>
internal sealed record BatchRecordResult(int Index, string Status, ItemResponse? Item, BatchRecordError? Error);

/// <summary>Every row's result and the counts. A 200 even when some rows failed.</summary>
internal sealed record BatchRecordsResponse(
    IReadOnlyList<BatchRecordResult> Rows,
    int Created,
    int Updated,
    int Unchanged,
    int Failed);

/// <summary>Lane 5 stubs: lookup, upsert and batch. Replace the handlers; keep the routes and types.</summary>
internal static class RecordEndpoints
{
    internal static IEndpointRouteBuilder MapRecordEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapPost(
                "/api/v1/workspaces/{workspaceId:guid}/lookup",
                (Guid workspaceId, LookupItemsRequest request, HttpContext context) => NotImplemented(context))
            .WithTags("Records")
            .WithName("LookupItemsByProperty")
            .Produces<LookupItemsResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.QueriesPolicyName);
        endpoints.MapPost(
                "/api/v1/items/{parentId:guid}/records/upsert",
                (Guid parentId, UpsertRecordRequest request, HttpContext context) => NotImplemented(context))
            .WithTags("Records")
            .WithName("UpsertRecord")
            .Produces<UpsertRecordResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        endpoints.MapPost(
                "/api/v1/workspaces/{workspaceId:guid}/records/batch",
                (Guid workspaceId, BatchRecordsRequest request, HttpContext context) => NotImplemented(context))
            .WithTags("Records")
            .WithName("BatchRecords")
            .Produces<BatchRecordsResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.BulkWritesPolicyName);
        return endpoints;
    }

    private static ProblemHttpResult NotImplemented(HttpContext context) => TypedResults.Problem(ApiProblem.Create(
        context,
        StatusCodes.Status501NotImplemented,
        "records.not_implemented",
        "Not implemented",
        "This route is not implemented yet."));
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(LookupItemsRequest))]
[JsonSerializable(typeof(LookupItemsResponse))]
[JsonSerializable(typeof(UpsertRecordRequest))]
[JsonSerializable(typeof(UpsertRecordResponse))]
[JsonSerializable(typeof(BatchRecordsRequest))]
[JsonSerializable(typeof(BatchRecordsResponse))]
internal sealed partial class RecordsJsonContext : JsonSerializerContext;
