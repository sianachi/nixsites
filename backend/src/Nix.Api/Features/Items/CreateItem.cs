using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Features.Properties;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>
/// Creates an item under a parent, or at the workspace root.
/// </summary>
/// <param name="WorkspaceId">The workspace to create it in.</param>
/// <param name="Type">Its kind.</param>
/// <param name="Title">Its display name.</param>
/// <param name="ParentId">The parent, or <see langword="null"/> for a workspace root.</param>
/// <param name="Properties">
/// Values to give it on creation, or <see langword="null"/> for none.
/// </param>
/// <remarks>
/// The server mints the identifier and chooses the sibling position. A client that could supply
/// either would be able to collide with an item it cannot see - which, in a system where "cannot
/// see" is the security boundary, is a way to learn that the invisible item exists.
/// </remarks>
public sealed record CreateItem(
    WorkspaceId WorkspaceId,
    string Type,
    string Title,
    ItemId? ParentId,
    JsonObject? Properties) : ICommand<Item>
{
    /// <summary>Optional per-principal request identity, independent of the server-minted item ID.</summary>
    public Guid? IdempotencyKey { get; init; }

    /// <summary>Internal capability for validated finance feature dispatches; never request-bound.</summary>
    internal bool FinanceWrite { get; init; }

    /// <summary>
    /// Internal capability for validated habit feature dispatches, allowing <c>$habit_</c> keys;
    /// never request-bound, and never a way to write a scheduler set-by key.
    /// </summary>
    internal bool HabitWrite { get; init; }

    /// <summary>
    /// Internal capability for the calendar sync pull, allowing <c>$cal_</c> keys; never
    /// request-bound, and never a way to write a scheduler set-by key.
    /// </summary>
    internal bool CalendarWrite { get; init; }
}

/// <summary>
/// Creates an item under a parent, or at the workspace root.
/// </summary>
/// <remarks>
/// The server mints the identifier and chooses the sibling position. A client that could supply
/// either would be able to collide with an item it cannot see - which, in a system where "cannot
/// see" is the security boundary, is a way to learn that the invisible item exists.
/// </remarks>
public sealed class CreateItemHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    ISchemaResolver schemas,
    INixSessionContextAccessor session,
    TimeProvider clock,
    IFinanceLock? topology = null)
    : ICommandHandler<CreateItem, Item>
{
    private readonly INixSessionContextAccessor _session = session;

    /// <summary>Creates the item.</summary>
    /// <param name="command">
    /// The workspace to create it in; its kind; its display name; the parent, or
    /// <see langword="null"/> for a workspace root; and values to give it on creation, or
    /// <see langword="null"/> for none.
    /// </param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The created item, or why it could not be created.</returns>
    /// <remarks>
    /// <b>Properties are checked here for the same reasons a later write is checked.</b> Creating a
    /// card already in a column is one gesture rather than a create followed by an edit, and the
    /// value it carries has to face the same schema either way - otherwise the way to store a value
    /// the schema refuses would be to supply it a moment earlier.
    /// </remarks>
    public async ValueTask<Result<Item>> HandleAsync(CreateItem command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var workspaceId = command.WorkspaceId;
        var type = command.Type;
        var title = command.Title;
        var parentId = command.ParentId;
        var properties = command.Properties;

        if (!command.FinanceWrite && properties?.Any(pair => pair.Key.StartsWith("$fin_", StringComparison.Ordinal)) == true)
        {
            return Result.Failure<Item>(new NixError("finance.reserved_property", "Finance properties may only be written through the finance endpoints."));
        }

        if (properties?.Any(pair => SchedulingReservedProperties.IsRefused(pair.Key, command.HabitWrite, command.CalendarWrite)) == true)
        {
            return Result.Failure<Item>(SchedulingReservedProperties.Error);
        }

        // Any other '$' key: reserved for the server and the structural query fields. A create
        // supplying null for one sets nothing, so only a value is refused.
        if (properties?.FirstOrDefault(pair => pair.Value is not null
                && ReservedPropertyKeys.IsRefused(pair.Key, command.HabitWrite, command.CalendarWrite, command.FinanceWrite)) is { Key: { } reserved })
        {
            return Result.Failure<Item>(ReservedPropertyKeys.Refusal(reserved));
        }

        if (string.IsNullOrWhiteSpace(type))
        {
            return Result.Failure<Item>(ItemErrors.NotFound("An item type is required."));
        }

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        if (command.IdempotencyKey == Guid.Empty)
        {
            return Result.Failure<Item>(new NixError("items.invalid_idempotency_key", "A non-empty request UUID is required."));
        }

        if (topology is not null)
        {
            await topology.AcquireWorkspaceTopologyAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        }

        if (!await tree.WorkspaceExistsAsync(workspaceId, cancellationToken).ConfigureAwait(false)
            || !await permissions.CanWriteWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            // Not-found rather than forbidden: a workspace the caller cannot see must not be
            // distinguishable from one that does not exist. A reader who may see the workspace but
            // not write to it gets the same answer here, which costs them a clearer message and
            // costs an attacker the ability to map the tenant by watching which refusal comes back.
            return Result.Failure<Item>(
                ItemErrors.WorkspaceNotFound($"No workspace {workspaceId} is visible."));
        }

        string? creationRequest = null;
        if (command.IdempotencyKey is { } requestKey)
        {
            creationRequest = new JsonObject
            {
                ["workspaceId"] = workspaceId.Value,
                ["parentId"] = parentId?.Value,
                ["type"] = type,
                ["title"] = title,
                ["properties"] = properties?.DeepClone(),
            }.ToJsonString();
            var receipt = await tree.GetCreationReceiptAsync(requestKey, creationRequest, cancellationToken).ConfigureAwait(false);
            if (receipt is not null)
            {
                if (!receipt.MatchesRequest)
                {
                    return Result.Failure<Item>(new NixError("items.idempotency_conflict", "This request UUID belongs to a different creation."));
                }

                var created = await tree.FindAsync(receipt.ItemId, cancellationToken).ConfigureAwait(false);
                return created is not null
                    && await permissions.CanWriteWorkspaceAsync(created.WorkspaceId, cancellationToken).ConfigureAwait(false)
                    ? Result.Success(created)
                    : Result.Failure<Item>(ItemErrors.NotFound("The previously created item is no longer available."));
            }
        }

        if (parentId is { } parent)
        {
            var existing = await tree.FindAsync(parent, cancellationToken).ConfigureAwait(false);
            if (existing is null || existing.WorkspaceId != workspaceId)
            {
                return Result.Failure<Item>(
                    ItemErrors.ParentNotFound($"No parent {parent} is visible in this workspace."));
            }

            // The calendar pull passes: a linked container that refuses new children still has to
            // receive the events its calendar gains, or the mirror would silently fall behind.
            if (existing.NoChildren && !command.CalendarWrite)
            {
                return Result.Failure<Item>(
                    ItemErrors.ChildrenProtected("This item does not accept new children."));
            }
        }

        // The title is written last so it wins. A caller that also passed `title` in the bag would
        // otherwise be able to make the stored title disagree with the one it named, and every
        // listing reads the promoted field.
        var bag = ItemProperties.WithTitle(properties?.ToJsonString(), title);

        // The schema the item is about to fall under, resolved from the parent because the item has
        // no row yet to resolve from - which is the question ResolveForChildrenAsync exists to
        // answer.
        var schema = await schemas
            .ResolveForChildrenAsync(parentId, cancellationToken)
            .ConfigureAwait(false);

        // A create owes no required value at all: a required property is a statement about a
        // finished item, and demanding one here would make an item impossible to create inside any
        // container that requires anything. Everything actually supplied faces its declaration
        // exactly as a later write would.
        var violations = PropertyValidator.ValidateSupplied(bag, schema);
        if (!violations.IsEmpty)
        {
            return Result.Failure<Item>(PropertyErrors.InvalidProperties(violations));
        }

        // The one point this write's scheduled values, if any, are attributed - see
        // ItemProperties.StampSetBy. A create names every key it supplied, so "touched" is
        // simply the properties the request carried, before the title was merged in above.
        var stamped = ItemProperties.StampSetBy(
            bag,
            properties?.Select(pair => pair.Key).ToImmutableArray() ?? ImmutableArray<string>.Empty,
            context.PrincipalId.ToString());

        var now = clock.GetUtcNow();
        var item = new Item
        {
            Id = ItemId.Create(),
            TenantId = context.TenantId,
            WorkspaceId = workspaceId,
            Type = type,
            ParentId = parentId,
            Seq = await tree
                .NextSiblingSequenceAsync(workspaceId, parentId, cancellationToken)
                .ConfigureAwait(false),
            Properties = stamped,
            LifecycleState = ItemLifecycleState.Active,
            CreatedBy = context.PrincipalId,
            LastModifiedBy = context.PrincipalId,
            CreatedAt = now,
            LastModifiedAt = now,
        };

        await tree.InsertAsync(item, cancellationToken).ConfigureAwait(false);
        if (command.IdempotencyKey is { } key)
        {
            await tree.RecordCreationReceiptAsync(key, creationRequest!, item.Id, cancellationToken).ConfigureAwait(false);
        }
        return Result.Success(item);
    }
}

/// <summary>
/// Route handler for creating an item.
/// </summary>
/// <remarks>
/// Named apart from <see cref="CreateItem"/> itself: the command record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapPost</c> call site.
/// </remarks>
internal static class CreateItemEndpoint
{
    /// <summary>Handles a request to create an item.</summary>
    /// <param name="workspaceId">The workspace to create it in.</param>
    /// <param name="request">The requested type, title, parent, and properties.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The created item, or a problem describing why it could not be created.</returns>
    internal static async Task<Results<Created<ItemResponse>, ProblemHttpResult>> Handle(
        Guid workspaceId,
        CreateItemRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .SendAsync<CreateItem, Item>(
                new CreateItem(
                    WorkspaceId.From(workspaceId),
                    request.Type,
                    request.Title,
                    request.ParentId is { } parent ? ItemId.From(parent) : null,
                    request.Properties)
                { IdempotencyKey = request.IdempotencyKey },
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(ItemEndpoints.Problem(httpContext, result.Error));
        }

        var item = result.Value;
        var response = request.IdempotencyKey is null
            ? ItemMapping.ToResponse(item, false)
            : await ItemMapping.RespondAsync(item, dispatcher, httpContext.RequestAborted).ConfigureAwait(false);
        return TypedResults.Created($"/api/v1/items/{item.Id}", response);
    }
}
