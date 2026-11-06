using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Features.Items;
using Nix.Features.Views;
using Nix.Http;

namespace Nix.Features.Properties;

/// <summary>
/// Route registration for what gives an item structure: its schema, its property values, and the
/// views its container offers.
/// </summary>
/// <remarks>
/// <para>
/// One feature group rather than three, because the three are one idea: a schema declares what a
/// property means, a property value is an instance of it, and a view is a way of arranging items
/// by those values. Splitting them would put three route files in front of one concept.
/// </para>
/// <para>
/// Every failure code here is namespaced by feature so two features can never collide, and the
/// frontend switches on the literal rather than on message text.
/// </para>
/// </remarks>
internal static class StructureEndpoints
{
    /// <summary>Registers the structure routes.</summary>
    /// <param name="endpoints">The route builder.</param>
    /// <returns>The route builder, for chaining.</returns>
    internal static IEndpointRouteBuilder MapStructureEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var items = endpoints.MapGroup("/api/v1/items").WithTags("Structure");

        endpoints.MapPost(
                "/api/v1/workspaces/{workspaceId:guid}/structured-items",
                StructuredItemSetupEndpoints.Create)
            .WithTags("Structure")
            .WithName("CreateStructuredItem")
            .Produces<StructuredItemResponse>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapPost("/{itemId:guid}/view-setups", StructuredItemSetupEndpoints.Append)
            .WithName("AppendViewSetup")
            .Produces<StructuredItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapPut("/{itemId:guid}/view-setups/{viewId}", StructuredItemSetupEndpoints.Replace)
            .WithName("ReplaceViewSetup")
            .Produces<StructuredItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapGet("/{itemId:guid}/schema", GetEffectiveSchemaEndpoint.Handle)
            .WithName("GetEffectiveSchema")
            .WithSummary("The property schema in force at an item")
            .WithDescription(
                "Returns the merged result of every ancestor's declaration, nearest winning, "
                + "alongside the subset this item declares itself. Both are needed: an editor "
                + "shown only the merged result would save inherited properties back onto the "
                + "item and silently turn inheritance into a copy.")
            .Produces<EffectiveSchemaResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        items.MapPut("/{itemId:guid}/schema", SetItemSchemaEndpoint.Handle)
            .WithName("SetItemSchema")
            .WithSummary("Declare the property schema for an item's subtree")
            .WithDescription(
                "Replaces what this item declares. Ancestors are unaffected, and so are the "
                + "property values already stored beneath it: a property removed from a schema "
                + "stops being validated and stops being displayed, and returns intact if the "
                + "schema does. Fails with 'schema.invalid' when the document cannot be stored.")
            .Produces<EffectiveSchemaResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapPatch("/{itemId:guid}/properties", SetItemPropertiesEndpoint.Handle)
            .WithName("SetItemProperties")
            .WithSummary("Write property values onto an item")
            .WithDescription(
                "Merges the supplied properties into the item's bag: a member set to null clears "
                + "that property, and anything not mentioned is left alone. This is what a board "
                + "drag and a calendar drag both perform - the change is to the item, so it is "
                + "visible in every view. Fails with 'properties.invalid' when a value does not "
                + "fit the schema in force.")
            .Produces<ItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapGet("/{itemId:guid}/views", GetContainerViewsEndpoint.Handle)
            .WithName("GetContainerViews")
            .WithSummary("The views a container offers")
            .WithDescription(
                "Returns the views in switcher order, plus the identifiers of any whose "
                + "configured property no longer exists or no longer fits. A board grouping by a "
                + "deleted property would otherwise render as an empty board, which is "
                + "indistinguishable from an item with nothing in it. A kind that needs nothing "
                + $"from the schema ({ViewKindProse.KindsThatNeedNothing}) is never listed there: "
                + "it needs no property to draw its items, so a gallery whose cover property is "
                + "gone reports the missing cover and still shows every item.")
            .Produces<ContainerViewsResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        items.MapPut("/{itemId:guid}/views", SetContainerViewsEndpoint.Handle)
            .WithName("SetContainerViews")
            .WithSummary("Replace the views a container offers")
            .WithDescription(
                "A whole-set replacement, because the order is part of what is being edited. "
                + $"A view's kind is one of {ViewKindProse.EveryKindListed}. What a kind must "
                + $"name is checked here{ViewKindProse.RequirementsAside}, but whether that "
                + "property exists is not: a view may be configured before the property is "
                + "declared, and the read path reports the mismatch instead. Fails with "
                + "'views.invalid' when a view is not storable. 'hideDocument' hides the "
                + "document tab and nothing else: it is not an access control, and the body stays "
                + "readable everywhere it already was. Absent leaves the stored flag as it is; true "
                + "makes the first view open when the default was the document, and fails with "
                + "'views.document_cannot_be_hidden' when there are no views or the default "
                + "explicitly names the document. Replacing the set with no views clears the flag. "
                + "An optional expectedVersion from the views read atomically rejects stale replacements "
                + "with views.version_conflict (409); absent preserves legacy unconditional replacement.")
            .Produces<ContainerViewsResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        return endpoints;
    }

    /// <summary>
    /// Maps a use case's failure onto the status its stable code implies.
    /// </summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="error">Why the use case failed.</param>
    /// <returns>Problem details describing the failure.</returns>
    /// <remarks>
    /// The code is the contract; the status is a consequence of it. A malformed schema or an
    /// invalid property value is 422 rather than 400: the request was understood and well-formed,
    /// and what it asked for is what could not be done.
    /// </remarks>
    internal static Microsoft.AspNetCore.Mvc.ProblemDetails Problem(HttpContext httpContext, NixError error)
    {
        var status = Records.RecordErrors.StatusOf(error.Code) ?? error.Code switch
        {
            PropertyErrors.InvalidPropertiesCode
                or PropertyErrors.InvalidSchemaCode
                or PropertyErrors.InvalidViewsCode
                or PropertyErrors.DocumentCannotBeHiddenCode => StatusCodes.Status422UnprocessableEntity,
            PropertyErrors.SetupCollisionCode or PropertyErrors.ViewVersionConflictCode => StatusCodes.Status409Conflict,
            ItemEndpoints.LifecycleConflictCode => StatusCodes.Status409Conflict,
            _ => StatusCodes.Status404NotFound,
        };

        return ApiProblem.Create(httpContext, status, error);
    }
}
