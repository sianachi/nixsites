using System.Globalization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Recurrence;
using Nix.Features.Items;
using Nix.Messaging;

namespace Nix.Features.Recurrence;

/// <summary>Completes one occurrence of an item's repeating series.</summary>
/// <param name="ItemId">The item.</param>
/// <param name="OccurredOn">The occurrence day being completed.</param>
public sealed record CompleteRecurrenceOccurrence(ItemId ItemId, DateOnly OccurredOn) : ICommand<Item>;

/// <summary>Handles <see cref="CompleteRecurrenceOccurrence"/>.</summary>
/// <remarks>
/// <para>
/// <b>Completing twice is success, not an error.</b> <see cref="RecurrenceWrites.ApplyCompletion"/>'s
/// <see cref="RecurrenceCompletionOutcome.AlreadyComplete"/> is exactly that contract - idempotent by
/// design, because a client retrying a completion it already made (a flaky connection, a duplicate
/// tap) should see the same success the first attempt did, not a refusal for having tried again.
/// </para>
/// <para>
/// <b>Every read here fails closed with its own stable code, before the domain guard ever runs.</b>
/// No rule, no anchor, and an unreadable rule are three different reasons this handler cannot even
/// ask <see cref="RecurrenceWrites.ApplyCompletion"/> the question, and collapsing them into one
/// code would leave a client unable to tell "there is nothing to complete" from "something here is
/// broken".
/// </para>
/// </remarks>
public sealed class CompleteRecurrenceOccurrenceHandler(
    IItemTree tree,
    IRecurrenceStore recurrence,
    IPermissionResolver permissions)
    : ICommandHandler<CompleteRecurrenceOccurrence, Item>
{
    private readonly IRecurrenceStore _recurrence = recurrence;

    /// <summary>Completes the occurrence.</summary>
    /// <param name="command">The item and the occurrence day.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The item after the write, or why the occurrence could not be completed.</returns>
    public async ValueTask<Result<Item>> HandleAsync(
        CompleteRecurrenceOccurrence command,
        CancellationToken cancellationToken)
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
                ItemErrors.LifecycleConflict("A deleted item's occurrence cannot be completed."));
        }

        var storedJson = await _recurrence.ReadRuleAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (storedJson is null)
        {
            return Result.Failure<Item>(
                RecurrenceRequestErrors.NotRecurring(
                    "This item carries no recurrence rule, so there is no occurrence to complete."));
        }

        var rule = RecurrenceRuleJson.Read(storedJson);
        if (rule is null)
        {
            return Result.Failure<Item>(
                RecurrenceRequestErrors.UnreadableRule(
                    "The stored recurrence rule could not be read by this build."));
        }

        var anchor = RecurrenceMapping.ReadAnchor(item.DueDay);
        if (anchor is null)
        {
            return Result.Failure<Item>(
                RecurrenceRequestErrors.NoAnchor(
                    "This item has no due date, so its series has nothing to anchor to."));
        }

        var applied = RecurrenceWrites.ApplyCompletion(rule, anchor.Value, command.OccurredOn);
        if (applied.IsFailure)
        {
            return Result.Failure<Item>(applied.Error);
        }

        if (applied.Value.Outcome == RecurrenceCompletionOutcome.AlreadyComplete)
        {
            // Idempotent: nothing changed, so the item handed back is the one already read above
            // rather than a second, unnecessary round trip to storage.
            return Result.Success(item);
        }

        var ruleJson = applied.Value.RuleJson
            ?? throw new InvalidOperationException(
                "RecurrenceWrites.ApplyCompletion returned Prepared without a RuleJson, which "
                + "violates its own contract.");

        var storeOutcome = await _recurrence
            .CompleteOccurrenceAsync(itemId, ruleJson, cancellationToken)
            .ConfigureAwait(false);

        switch (storeOutcome)
        {
            case OccurrenceCompletionOutcome.ItemNotFound:
                return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
            case OccurrenceCompletionOutcome.NotRecurring:
                // A race rather than the precheck above: the rule was cleared between the read at
                // the top of this method and the write just attempted.
                return Result.Failure<Item>(
                    RecurrenceRequestErrors.NotRecurring(
                        "This item's recurrence rule was cleared before this completion could be stored."));
            case OccurrenceCompletionOutcome.Completed:
            case OccurrenceCompletionOutcome.AlreadyComplete:
            default:
                break;
        }

        var written = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        return written is null
            ? Result.Failure<Item>(ItemErrors.NotFound($"Item {itemId} disappeared during the write."))
            : Result.Success(written);
    }
}

/// <summary>
/// Route handler for completing one occurrence of an item's repeating series.
/// </summary>
/// <remarks>
/// Named apart from <see cref="CompleteRecurrenceOccurrence"/> itself: the command record already
/// owns that identifier in this namespace, and a route handler with the same name would be an
/// ambiguous simple name at the <c>MapPost</c> call site.
/// </remarks>
internal static class CompleteRecurrenceOccurrenceEndpoint
{
    /// <summary>Handles a request to complete one occurrence.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="request">The occurrence day.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The rule now in force and which day is complete, or a problem describing why not.</returns>
    internal static async Task<Results<Ok<CompleteOccurrenceResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        CompleteOccurrenceRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (!RecurrenceMapping.TryDay(request.OccurredOn, out var occurredOn))
        {
            return TypedResults.Problem(
                RecurrenceEndpoints.Problem(
                    httpContext,
                    RecurrenceRequestErrors.InvalidOccurredOn(
                        $"'{request.OccurredOn}' is not a yyyy-MM-dd date.")));
        }

        var result = await dispatcher
            .SendAsync<CompleteRecurrenceOccurrence, Item>(
                new CompleteRecurrenceOccurrence(ItemId.From(itemId), occurredOn),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<CompleteOccurrenceResponse>, ProblemHttpResult>>(
            item => TypedResults.Ok(
                new CompleteOccurrenceResponse(
                    RecurrenceMapping.ToResponse(RecurrenceRuleJson.Read(item.Recurrence)),
                    occurredOn.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture))),
            error => TypedResults.Problem(RecurrenceEndpoints.Problem(httpContext, error)));
    }
}
