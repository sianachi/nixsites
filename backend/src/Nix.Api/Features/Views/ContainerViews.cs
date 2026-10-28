using System.Collections.Immutable;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Views;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Messaging;

namespace Nix.Features.Views;

/// <summary>A container's views, and whether each can currently render.</summary>
/// <param name="Views">The views the container offers, in switcher order.</param>
/// <param name="Unrenderable">
/// The identifiers of views whose configured property no longer exists or no longer fits.
/// </param>
/// <param name="Default">
/// What opens: a view's id, or <c>document</c> for the item's own body. Already resolved, so a
/// default naming a deleted view arrives here as <c>document</c> rather than as a dangling id.
/// While the document tab is hidden it is never <c>document</c>: the first view stands in.
/// </param>
/// <param name="HideDocument">
/// Whether the item's own document tab is left out of its switcher. Hides a tab only; it is not an
/// access control, and the body stays readable everywhere it already was.
/// </param>
/// <remarks>
/// The second list is what stops a board whose grouping property was deleted from rendering as an
/// empty board - which is indistinguishable from an item with nothing in it, and sends somebody looking for
/// their missing items instead of their missing property.
/// </remarks>
/// <param name="Version">Opaque version of all durable view settings for a conditional replacement.</param>
public sealed record ContainerViewSet(
    ImmutableArray<ViewDefinition> Views,
    ImmutableArray<string> Unrenderable,
    string Default,
    bool HideDocument = false,
    string Version = "");

/// <summary>Reads the views a container offers.</summary>
/// <param name="ItemId">The container.</param>
public sealed record GetContainerViews(ItemId ItemId) : IQuery<Result<ContainerViewSet>>;

/// <summary>Handles <see cref="GetContainerViews"/>.</summary>
public sealed class GetContainerViewsHandler(
    IItemTree tree,
    ISchemaResolver schemas,
    IPermissionResolver permissions)
    : IQueryHandler<GetContainerViews, Result<ContainerViewSet>>
{
    /// <summary>Reads the views.</summary>
    /// <param name="query">The container whose views are wanted.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The views, or why they could not be read.</returns>
    public async ValueTask<Result<ContainerViewSet>> HandleAsync(
        GetContainerViews query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var itemId = query.ItemId;

        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ContainerViewSet>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        var stored = ViewDefinitionsJson.Read(item.Views);
        var views = stored.Views;
        if (views.IsEmpty)
        {
            return Result.Success(new ContainerViewSet([], [], ViewDefinitionsJson.DocumentView, Version: ViewConfigurationVersion.FromStored(item.Views)));
        }

        // The schema a view's configuration is checked against is the one its children carry,
        // which is the schema at the container itself.
        var schema = await schemas.ResolveForItemAsync(itemId, cancellationToken).ConfigureAwait(false);

        var unrenderable = views
            .Where(view => !view.CanRender(schema))
            .Select(view => view.Id)
            .ToImmutableArray();

        return Result.Success(new ContainerViewSet(views, unrenderable, stored.Resolve(), stored.HideDocument, ViewConfigurationVersion.FromStored(item.Views)));
    }
}

/// <summary>Replaces the views a container offers.</summary>
/// <param name="ItemId">The container.</param>
/// <param name="Views">The views to offer, in switcher order.</param>
/// <param name="DefaultView">
/// Which view opens: a view's id, or <c>document</c> / <see langword="null"/> for the body.
/// </param>
/// <param name="HideDocument">
/// Whether to hide the item's own document tab: <see langword="null"/> leaves the stored flag as it
/// is. Hides a tab only; it is not an access control.
/// </param>
/// <remarks>
/// <b>A whole-set replacement rather than per-view edits.</b> The set is small, bounded and
/// ordered, and the order is part of what is being edited - a switcher's tabs are dragged into an
/// order as often as an individual view is renamed. Per-view endpoints would make reordering a
/// sequence of writes that can half-apply.
/// </remarks>
/// <param name="ExpectedVersion">An observed version, or null for a legacy unconditional write.</param>
public sealed record SetContainerViews(
    ItemId ItemId,
    ImmutableArray<ViewDefinition> Views,
    string? DefaultView,
    bool? HideDocument = null,
    string? ExpectedVersion = null)
    : ICommand<ImmutableArray<ViewDefinition>>;

/// <summary>Handles <see cref="SetContainerViews"/>.</summary>
public sealed class SetContainerViewsHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    TimeProvider clock,
    ISchemaResolver schemas)
    : ICommandHandler<SetContainerViews, ImmutableArray<ViewDefinition>>
{
    private readonly INixSessionContextAccessor _session = session;

    /// <summary>Sets the views.</summary>
    /// <param name="command">The container, the views to offer, and which one opens.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The stored views, or why they could not be stored.</returns>
    public async ValueTask<Result<ImmutableArray<ViewDefinition>>> HandleAsync(
        SetContainerViews command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var itemId = command.ItemId;
        var views = command.Views;
        var defaultView = command.DefaultView;

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ImmutableArray<ViewDefinition>>(
                ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        if (item.LifecycleState != ItemLifecycleState.Active)
        {
            return Result.Failure<ImmutableArray<ViewDefinition>>(
                ItemErrors.LifecycleConflict("A deleted container's views cannot be changed."));
        }

        if (command.ExpectedVersion is not null
            && !string.Equals(command.ExpectedVersion, ViewConfigurationVersion.FromStored(item.Views), StringComparison.Ordinal))
        {
            return Result.Failure<ImmutableArray<ViewDefinition>>(PropertyErrors.ViewVersionConflict());
        }

        if (ViewDefinitionRules.Refuse(views, defaultView) is { } reason)
        {
            return Result.Failure<ImmutableArray<ViewDefinition>>(PropertyErrors.InvalidViews(reason));
        }

        if (await RefuseAgainstSchemaAsync(itemId, views, cancellationToken).ConfigureAwait(false) is { } fit)
        {
            return Result.Failure<ImmutableArray<ViewDefinition>>(PropertyErrors.InvalidViews(fit));
        }

        // An absent flag keeps what is stored. Asking for it outright is the one case that rewrites
        // a default of "document" to the first view instead of refusing it, because that is the
        // request's own intent; a flag that was already stored makes a "document" default a
        // contradiction of the request instead. With no views left the flag is not refused unless
        // it was asked for: Write clears it, so deleting the last view cannot fail.
        var hideDocument = command.HideDocument ?? ViewDefinitionsJson.Read(item.Views).HideDocument;
        var askedToHide = command.HideDocument == true;
        var checkedDefault = askedToHide
            && string.Equals(defaultView, ViewDefinitionsJson.DocumentView, StringComparison.Ordinal)
                ? null
                : defaultView;
        if (ViewDefinitionRules.RefuseDocumentVisibility(
                views,
                checkedDefault,
                hideDocument && (askedToHide || !views.IsDefaultOrEmpty)) is { } visibility)
        {
            return Result.Failure<ImmutableArray<ViewDefinition>>(
                PropertyErrors.DocumentCannotBeHidden(visibility));
        }

        var json = ViewDefinitionsJson.Write(views, checkedDefault, hideDocument);
        if (json is not null
            && System.Text.Encoding.UTF8.GetByteCount(json) > ViewDefinitionsJson.MaximumBytes)
        {
            return Result.Failure<ImmutableArray<ViewDefinition>>(
                PropertyErrors.InvalidViews(
                    $"A container's views may be at most {ViewDefinitionsJson.MaximumBytes} bytes."));
        }

        if (command.ExpectedVersion is not null)
        {
            if (!await tree.TryUpdateViewsAsync(itemId, item.WorkspaceId, item.Views, json,
                    context.PrincipalId, clock.GetUtcNow(), cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<ImmutableArray<ViewDefinition>>(PropertyErrors.ViewVersionConflict());
            }
        }
        else
        {
            await tree
                .UpdateViewsAsync(itemId, json, context.PrincipalId, clock.GetUtcNow(), cancellationToken)
                .ConfigureAwait(false);
        }

        return Result.Success(views);
    }

    /// <summary>
    /// Every reason a view set is not storable, or null when it is fine.
    /// </summary>
    /// <remarks>
    /// <b>What is deliberately not checked here: whether the configured property exists.</b> A
    /// board may be configured before the property it groups by is declared, and a property may be
    /// deleted from under a board that was fine yesterday. Refusing either would make the order of
    /// two independent edits matter. The read path reports such a view as unrenderable instead,
    /// which is a thing the interface can explain.
    /// </remarks>
    /// <summary>The most filter rules one view may carry.</summary>
    /// <remarks>
    /// The presets need two; eight is headroom. The bound is what keeps the compiled statement's
    /// size a constant rather than a function of what somebody managed to store.
    /// </remarks>
    internal const int MaximumFilters = ViewDefinitionRules.MaximumFilters;

    /// <summary>
    /// The first configured property that exists in the container's schema but cannot serve, or null.
    /// </summary>
    /// <remarks>
    /// Only a chart's split is checked, and only when the property exists: a property declared
    /// later is still allowed, by the argument the remarks on <see cref="Validate"/> make. A split by
    /// a property with a value per child is refused because it is a legend nobody can read and a
    /// read that groups by every child.
    /// </remarks>
    private async ValueTask<string?> RefuseAgainstSchemaAsync(
        ItemId itemId,
        ImmutableArray<ViewDefinition> views,
        CancellationToken cancellationToken)
    {
        if (views.IsDefaultOrEmpty || !views.Any(view => view.Kind == ViewKind.Chat || view.Chart?.SplitBy is not null))
        {
            return null;
        }

        var schema = views.Any(view => view.Kind == ViewKind.Chat)
            ? await schemas.ResolveForChildrenAsync(itemId, cancellationToken).ConfigureAwait(false)
            : await schemas.ResolveForItemAsync(itemId, cancellationToken).ConfigureAwait(false);
        foreach (var view in views)
        {
            if (view.Kind == ViewKind.Chat && ChatSchema.Refuse(schema) is { } chatReason)
            {
                return chatReason;
            }

            if (view.Chart?.SplitBy is { } split
                && schema.Find(split) is { } property
                && !property.Type.CanSplitBy())
            {
                return $"'{view.Name}': a chart splits into series by a single choice, a checkbox or a "
                    + $"person, and '{property.Label}' has a value per item";
            }
        }

        return null;
    }

    /// <summary>Validates a complete stored-view replacement without writing it.</summary>
    public static NixError? Validate(
        ImmutableArray<ViewDefinition> views,
        string? defaultView,
        bool hideDocument = false) =>
        ViewDefinitionRules.Refuse(views, defaultView) is { } reason
            ? PropertyErrors.InvalidViews(reason)
            : ViewDefinitionRules.RefuseDocumentVisibility(views, defaultView, hideDocument) is { } visibility
                ? PropertyErrors.DocumentCannotBeHidden(visibility)
                : null;

}

/// <summary>
/// Route handler for reading the views a container offers.
/// </summary>
/// <remarks>
/// Named apart from <see cref="GetContainerViews"/> itself: the query record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapGet</c> call site.
/// </remarks>
internal static class GetContainerViewsEndpoint
{
    /// <summary>Handles a request for the views a container offers.</summary>
    /// <param name="itemId">The container.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The views, or a problem describing why they could not be read.</returns>
    internal static async Task<Results<Ok<ContainerViewsResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .QueryAsync<GetContainerViews, Result<ContainerViewSet>>(
                new GetContainerViews(ItemId.From(itemId)),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<ContainerViewsResponse>, ProblemHttpResult>>(
            views => TypedResults.Ok(
                new ContainerViewsResponse(
                    [.. views.Views.Select(ViewMapping.ToResponse)],
                    views.Unrenderable,
                    views.Default,
                    views.HideDocument,
                    views.Version)),
            error => TypedResults.Problem(StructureEndpoints.Problem(httpContext, error)));
    }
}

/// <summary>
/// Route handler for replacing the views a container offers.
/// </summary>
/// <remarks>
/// Named apart from <see cref="SetContainerViews"/> itself: the command record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapPut</c> call site.
/// </remarks>
internal static class SetContainerViewsEndpoint
{
    /// <summary>Handles a request to replace the views a container offers.</summary>
    /// <param name="itemId">The container.</param>
    /// <param name="request">The views to offer, and which one should open.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command and the follow-up query to their handlers.</param>
    /// <returns>The stored views, or a problem describing why the write failed.</returns>
    internal static async Task<Results<Ok<ContainerViewsResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        SetViewsRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        if (!ViewMapping.TryToDomain(request, out var views, out var viewsRefusal))
        {
            return TypedResults.Problem(
                StructureEndpoints.Problem(
                    httpContext,
                    PropertyErrors.InvalidViews(viewsRefusal)));
        }

        var stored = await dispatcher
            .SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
                new SetContainerViews(ItemId.From(itemId), views, request.Default, request.HideDocument, request.ExpectedVersion),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (stored.IsFailure)
        {
            return TypedResults.Problem(StructureEndpoints.Problem(httpContext, stored.Error));
        }

        // Read back so the response carries the unrenderable list, which the write path does not
        // compute and the caller needs in order to say anything honest about what it just saved.
        var reread = await dispatcher
            .QueryAsync<GetContainerViews, Result<ContainerViewSet>>(
                new GetContainerViews(ItemId.From(itemId)),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return reread.Match<Results<Ok<ContainerViewsResponse>, ProblemHttpResult>>(
            set => TypedResults.Ok(
                new ContainerViewsResponse(
                    [.. set.Views.Select(ViewMapping.ToResponse)],
                    set.Unrenderable,
                    set.Default,
                    set.HideDocument,
                    set.Version)),
            error => TypedResults.Problem(StructureEndpoints.Problem(httpContext, error)));
    }
}
