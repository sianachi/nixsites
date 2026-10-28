using System.Collections.Immutable;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Recurrence;
using Nix.Features.Items;
using Nix.Messaging;

namespace Nix.Features.Recurrence;

/// <summary>
/// Sets or clears an item's repeating rule.
/// </summary>
/// <param name="ItemId">The item.</param>
/// <param name="Request">
/// The rule to author, or <see langword="null"/> to clear it and stop the item repeating.
/// </param>
/// <remarks>
/// Carried as the wire request rather than an already-validated <see cref="RecurrenceRule"/>, the
/// same shape <c>SetItemProperties</c> carries its raw JSON in: the handler is where a malformed
/// request is refused with its own stable code, so nothing about that refusal depends on a route
/// being in front of it.
/// </remarks>
public sealed record SetItemRecurrence(ItemId ItemId, SetRecurrenceRequest? Request) : ICommand<Item>;

/// <summary>Handles <see cref="SetItemRecurrence"/>.</summary>
/// <remarks>
/// <para>
/// <b>Completion state survives an edit by construction, not by accident.</b> A rule edit is
/// authored against the item's series, not against a blank slate: somebody who already completed
/// several occurrences did real work, and swapping "every Monday" for "every Tuesday" must not erase
/// it. The watermark (<see cref="RecurrenceRule.CompletedThrough"/>) carries over untouched - it
/// means "every occurrence at or before this day is done", which stays true of the new rule's
/// occurrences whether or not the day itself is one of them. The exception list
/// (<see cref="RecurrenceRule.Completed"/>) is different: each entry names one specific day, and a
/// day the new rule no longer produces is not a completion of anything, so it is dropped rather than
/// kept as a completion for an occurrence that no longer exists.
/// </para>
/// <para>
/// <b>The bound this stands in front of is <see cref="RecurrenceWrites.PrepareRule"/>, never the
/// database CHECK.</b> A rule too large to store fails here as a coded, mapped refusal - the
/// migration's own remark names <c>RecurrenceWrites</c> as the guard the constraint is only a
/// backstop for.
/// </para>
/// </remarks>
public sealed class SetItemRecurrenceHandler(
    IItemTree tree,
    IRecurrenceStore recurrence,
    IPermissionResolver permissions)
    : ICommandHandler<SetItemRecurrence, Item>
{
    private readonly IRecurrenceStore _recurrence = recurrence;

    /// <summary>Sets or clears the rule.</summary>
    /// <param name="command">The item and the rule to author, or <see langword="null"/> to clear it.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The item after the write, or why it could not be written.</returns>
    public async ValueTask<Result<Item>> HandleAsync(SetItemRecurrence command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var itemId = command.ItemId;

        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        if (item.LifecycleState != ItemLifecycleState.Active)
        {
            return Result.Failure<Item>(
                ItemErrors.LifecycleConflict("A deleted item's recurrence rule cannot be changed."));
        }

        string? ruleJson = null;
        if (command.Request is { } request)
        {
            var mapped = RecurrenceMapping.ToDomain(request);
            if (mapped.IsFailure)
            {
                return Result.Failure<Item>(mapped.Error);
            }

            var carried = await CarryCompletionsAsync(itemId, item.DueDay, mapped.Value, cancellationToken)
                .ConfigureAwait(false);

            var prepared = RecurrenceWrites.PrepareRule(carried);
            if (prepared.IsFailure)
            {
                return Result.Failure<Item>(prepared.Error);
            }

            ruleJson = prepared.Value;
        }

        var outcome = await _recurrence.SetRuleAsync(itemId, ruleJson, cancellationToken).ConfigureAwait(false);
        if (outcome == RecurrenceWriteOutcome.ItemNotFound)
        {
            return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        // Re-read rather than constructing the updated shape here: the write went through the
        // store, and inventing what the row now looks like is how a response drifts from the row it
        // claims to describe.
        var written = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        return written is null
            ? Result.Failure<Item>(ItemErrors.NotFound($"Item {itemId} disappeared during the write."))
            : Result.Success(written);
    }

    /// <summary>
    /// Carries a previously stored rule's completion state onto a freshly authored one.
    /// </summary>
    /// <param name="itemId">The item, to read whatever rule is stored today.</param>
    /// <param name="dueDay">The item's own anchor, as stored on the row.</param>
    /// <param name="requested">The newly authored rule, with no completion state of its own.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns><paramref name="requested"/>, with completion state carried over where it still applies.</returns>
    /// <remarks>
    /// When the item carries no anchor to check occurrences against, the exception list is carried
    /// over unfiltered rather than guessed at: there is nothing here to prove a completed day no
    /// longer applies, and losing it without proof is exactly the silent un-completion this method
    /// exists to avoid.
    /// </remarks>
    private async ValueTask<RecurrenceRule> CarryCompletionsAsync(
        ItemId itemId,
        string? dueDay,
        RecurrenceRule requested,
        CancellationToken cancellationToken)
    {
        var storedJson = await _recurrence.ReadRuleAsync(itemId, cancellationToken).ConfigureAwait(false);
        var stored = RecurrenceRuleJson.Read(storedJson);
        if (stored is null)
        {
            return requested;
        }

        var anchor = RecurrenceMapping.ReadAnchor(dueDay);
        var completed = anchor is { } day
            ? stored.Completed
                .Where(occurrence => RecurrenceExpansion.Occurrences(requested, day, occurrence, occurrence).Any())
                .ToImmutableArray()
            : stored.Completed;

        return requested with { CompletedThrough = stored.CompletedThrough, Completed = completed };
    }
}

/// <summary>
/// Route handler for setting or clearing an item's repeating rule.
/// </summary>
/// <remarks>
/// Named apart from <see cref="SetItemRecurrence"/> itself: the command record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapPut</c> call site.
/// </remarks>
internal static class SetItemRecurrenceEndpoint
{
    /// <summary>Handles a request to set or clear an item's repeating rule.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="request">
    /// The rule to author, or <see langword="null"/> when the request body itself is the JSON
    /// literal <c>null</c> - which clears the rule rather than being refused as malformed.
    /// </param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The rule now in force, or a problem describing why it could not be stored.</returns>
    internal static async Task<Results<Ok<SetRecurrenceResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        SetRecurrenceRequest? request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .SendAsync<SetItemRecurrence, Item>(
                new SetItemRecurrence(ItemId.From(itemId), request),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<SetRecurrenceResponse>, ProblemHttpResult>>(
            item => TypedResults.Ok(
                new SetRecurrenceResponse(RecurrenceMapping.ToResponse(RecurrenceRuleJson.Read(item.Recurrence)))),
            error => TypedResults.Problem(RecurrenceEndpoints.Problem(httpContext, error)));
    }
}
