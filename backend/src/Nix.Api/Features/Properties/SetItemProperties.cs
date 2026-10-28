using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Features.Items;
using Nix.Messaging;

namespace Nix.Features.Properties;

/// <summary>Writes property values onto an item, checked against the schema in force.</summary>
/// <param name="ItemId">The item.</param>
/// <param name="Changes">
/// The properties to set, as a JSON object. A member set to null clears that property.
/// </param>
/// <remarks>
/// <para>
/// <b>This is what a board drag and a calendar drag both come down to.</b> Moving a card between
/// columns sets its grouping property; dragging it to another day sets its date. Neither writes
/// anything view-local, which is what makes the change visible in every other view and to
/// everybody else - and is why view definitions carry no placement.
/// </para>
/// <para>
/// <b>A merge, not a replacement.</b> A caller sends the properties it is changing, and everything
/// else stays. Replacing the bag would make a board drag drop every property the board does not
/// display, which is most of them.
/// </para>
/// <para>
/// <b>And a partial one, for required values too.</b> The write is checked against the keys it
/// named: clearing a required property is refused, and a required property it never mentioned is
/// none of its business. Demanding a complete bag here meant that declaring a property required
/// write-locked every item that already existed - the drag above would be refused over a field the
/// board does not draw, with no way to supply it.
/// </para>
/// </remarks>
public sealed record SetItemProperties(ItemId ItemId, string Changes) : ICommand<Item>
{
    // The trusted marker lives on the command, never the HTTP DTO. Only finance handlers in this
    // assembly set it after validating their domain write.
    internal bool FinanceWrite { get; init; }

    // The same kind of trusted marker for the habit handlers, which alone may write $habit_ keys.
    // It never admits a scheduler set-by key.
    internal bool HabitWrite { get; init; }

    // And for the calendar sync pull, which alone may write $cal_ keys.
    internal bool CalendarWrite { get; init; }
}

/// <summary>Handles <see cref="SetItemProperties"/>.</summary>
public sealed class SetItemPropertiesHandler(
    IItemTree tree,
    ISchemaResolver schemas,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    TimeProvider clock,
    IFinanceMutationGuard? financeGuard = null)
    : ICommandHandler<SetItemProperties, Item>
{
    private readonly INixSessionContextAccessor _session = session;

    /// <summary>Writes the properties.</summary>
    /// <param name="command">The item and the properties to set.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The updated item, or why it could not be written.</returns>
    public async ValueTask<Result<Item>> HandleAsync(
        SetItemProperties command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var itemId = command.ItemId;
        var changes = command.Changes;

        ArgumentNullException.ThrowIfNull(changes);

        if (!command.FinanceWrite && ContainsReservedFinanceKey(changes))
        {
            return Result.Failure<Item>(new NixError("finance.reserved_property", "Finance properties may only be written through the finance endpoints."));
        }

        if (ContainsKeyMatching(changes, name => SchedulingReservedProperties.IsRefused(name, command.HabitWrite, command.CalendarWrite)))
        {
            return Result.Failure<Item>(SchedulingReservedProperties.Error);
        }

        if (ContainsKeyMatching(changes, name => name.StartsWith("$chat_", StringComparison.Ordinal)))
        {
            return Result.Failure<Item>(ReservedPropertyKeys.Refusal("$chat_config"));
        }

        if (FirstKeySet(changes, name => ReservedPropertyKeys.IsRefused(name, command.HabitWrite, command.CalendarWrite, command.FinanceWrite)) is { } reserved)
        {
            return Result.Failure<Item>(ReservedPropertyKeys.Refusal(reserved));
        }

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        if (item.LifecycleState != ItemLifecycleState.Active)
        {
            return Result.Failure<Item>(
                ItemErrors.LifecycleConflict("A deleted item's properties cannot be changed."));
        }

        // An event the owner cannot edit at its source keeps its mirrored fields: the provider
        // would overwrite them on the next pull. Everything else on it, a reminder say, is the
        // user's own and stays writable.
        if (!command.CalendarWrite
            && item.ManagedBy == ItemManagers.CalendarEvent
            && ItemProperties.ReadCalendarReadOnly(item.Properties)
            && ContainsKeyMatching(changes, name => name is Nix.Features.CalendarSync.CalendarContainerSchema.StartKey
                or Nix.Features.CalendarSync.CalendarContainerSchema.EndKey
                or Nix.Features.CalendarSync.CalendarContainerSchema.LocationKey
                or Nix.Features.CalendarSync.CalendarContainerSchema.DetailsKey))
        {
            return Result.Failure<Item>(ItemErrors.ReadOnly(
                "This event cannot be edited in its calendar, so its time and details cannot be changed here."));
        }

        if (!command.FinanceWrite && financeGuard is not null)
        {
            var blocked = await financeGuard.CheckAsync(item.WorkspaceId, itemId, null, false, cancellationToken, allowOpenTransaction: true).ConfigureAwait(false);
            if (blocked is not null)
            {
                return Result.Failure<Item>(blocked.Value);
            }
            item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
            if (item is null || item.LifecycleState != ItemLifecycleState.Active)
            {
                return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
            }
        }

        var write = ItemProperties.Merge(item.Properties, changes);
        if (write is not { } merged)
        {
            return Result.Failure<Item>(
                PropertyErrors.InvalidProperties(
                    [new PropertyViolation(string.Empty, "The properties must be a JSON object.")]));
        }

        // Resolved at the item, not at its parent: an item's own declaration is part of the schema
        // its own values are checked against.
        var schema = await schemas.ResolveForItemAsync(itemId, cancellationToken).ConfigureAwait(false);

        // The merge carries the keys this write named as well as its result, and required-ness is
        // enforced on those keys alone: clearing a required value is refused, leaving one alone is
        // not.
        var violations = PropertyValidator.ValidateWrite(merged, schema);
        if (!violations.IsEmpty)
        {
            return Result.Failure<Item>(PropertyErrors.InvalidProperties(violations));
        }

        // The one point this write's scheduled values, if any, are attributed - see
        // ItemProperties.StampSetBy.
        var stamped = ItemProperties.StampSetBy(
            merged.Merged,
            merged.Touched,
            context.PrincipalId.ToString());

        await tree
            .UpdatePropertiesAsync(
                itemId,
                stamped,
                context.PrincipalId,
                clock.GetUtcNow(),
                cancellationToken)
            .ConfigureAwait(false);

        var written = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);

        return written is null
            ? Result.Failure<Item>(ItemErrors.NotFound($"Item {itemId} disappeared during the write."))
            : Result.Success(written);
    }

    private static bool ContainsReservedFinanceKey(string changes) =>
        ContainsKeyMatching(changes, name => name.StartsWith("$fin_", StringComparison.Ordinal));

    /// <summary>The first key the change document sets (to anything but null) that matches, or null.</summary>
    private static string? FirstKeySet(string changes, Func<string, bool> matches)
    {
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(changes);
            if (document.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object)
            {
                return null;
            }

            foreach (var property in document.RootElement.EnumerateObject())
            {
                if (property.Value.ValueKind != System.Text.Json.JsonValueKind.Null && matches(property.Name))
                {
                    return property.Name;
                }
            }

            return null;
        }
        catch (System.Text.Json.JsonException)
        {
            return null; // The ordinary JSON validator below returns the established error.
        }
    }

    private static bool ContainsKeyMatching(string changes, Func<string, bool> matches)
    {
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(changes);
            return document.RootElement.ValueKind == System.Text.Json.JsonValueKind.Object
                && document.RootElement.EnumerateObject().Any(property => matches(property.Name));
        }
        catch (System.Text.Json.JsonException)
        {
            return false; // The ordinary JSON validator below returns the established error.
        }
    }
}

/// <summary>
/// Route handler for writing property values onto an item.
/// </summary>
/// <remarks>
/// Named apart from <see cref="SetItemProperties"/> itself: the command record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapPatch</c> call site.
/// </remarks>
internal static class SetItemPropertiesEndpoint
{
    /// <summary>Handles a request to write property values onto an item.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="request">The properties to set.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command and the follow-up query to their handlers.</param>
    /// <returns>The updated item, or a problem describing why the write failed.</returns>
    internal static async Task<Results<Ok<ItemResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        SetPropertiesRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .SendAsync<SetItemProperties, Item>(
                new SetItemProperties(ItemId.From(itemId), request.Properties.ToJsonString()),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(StructureEndpoints.Problem(httpContext, result.Error));
        }

        var item = result.Value;
        var withChildren = await dispatcher
            .QueryAsync<ItemsWithChildren, IReadOnlySet<ItemId>>(
                new ItemsWithChildren(item.WorkspaceId, [item.Id]),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return TypedResults.Ok(ItemMapping.ToResponse(item, withChildren.Contains(item.Id)));
    }
}
