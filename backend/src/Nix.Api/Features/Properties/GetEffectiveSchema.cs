using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Features.Items;
using Nix.Messaging;

namespace Nix.Features.Properties;

/// <summary>Reads the property schema in force at an item.</summary>
/// <param name="ItemId">The item.</param>
/// <remarks>
/// What the interface needs before it can render a property panel, a list view's columns, or a
/// board's grouping choices: the merged result of every ancestor's declaration, which is not
/// something a client can compute because it cannot see the ancestors.
/// </remarks>
public sealed record GetEffectiveSchema(ItemId ItemId) : IQuery<Result<EffectiveSchema>>;

/// <summary>Handles <see cref="GetEffectiveSchema"/>.</summary>
public sealed class GetEffectiveSchemaHandler(
    IItemTree tree,
    ISchemaResolver schemas,
    IPermissionResolver permissions)
    : IQueryHandler<GetEffectiveSchema, Result<EffectiveSchema>>
{
    /// <summary>Reads the effective schema.</summary>
    /// <param name="query">The item whose effective schema is wanted.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The schema, or why it could not be read.</returns>
    public async ValueTask<Result<EffectiveSchema>> HandleAsync(
        GetEffectiveSchema query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var itemId = query.ItemId;

        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<EffectiveSchema>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        var effective = await schemas.ResolveForItemAsync(itemId, cancellationToken).ConfigureAwait(false);

        // The item's own declaration is returned alongside the merged result, because an editor
        // needs to know which properties this container declares and which it merely inherits -
        // without that, saving the panel back would copy every inherited property onto the item
        // and quietly break the inheritance it was showing.
        var declared = PropertySchemaJson.Read(item.Schema);

        return Result.Success(new EffectiveSchema(effective, declared, item.Schema is not null));
    }
}

/// <summary>The schema at an item, and how much of it is the item's own.</summary>
/// <param name="Effective">Every ancestor's declaration merged, nearest winning.</param>
/// <param name="Declared">What this item declares itself.</param>
/// <param name="DeclaresSchema">Whether this item declares anything at all.</param>
public sealed record EffectiveSchema(
    PropertySchema Effective,
    PropertySchema Declared,
    bool DeclaresSchema);

/// <summary>
/// Route handler for the property schema in force at an item.
/// </summary>
/// <remarks>
/// Named apart from <see cref="GetEffectiveSchema"/> itself: the query record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapGet</c> call site.
/// </remarks>
internal static class GetEffectiveSchemaEndpoint
{
    /// <summary>Handles a request for the effective schema at an item.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The schema, or a problem describing why it could not be read.</returns>
    internal static async Task<Results<Ok<EffectiveSchemaResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .QueryAsync<GetEffectiveSchema, Result<EffectiveSchema>>(
                new GetEffectiveSchema(ItemId.From(itemId)),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<EffectiveSchemaResponse>, ProblemHttpResult>>(
            schema => TypedResults.Ok(PropertyMapping.ToResponse(schema.Effective, schema.Declared)),
            error => TypedResults.Problem(StructureEndpoints.Problem(httpContext, error)));
    }
}
