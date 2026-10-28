using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Features.Items;
using Nix.Messaging;

namespace Nix.Features.Properties;

/// <summary>Replaces the property schema a container declares for its subtree.</summary>
/// <param name="ItemId">The container.</param>
/// <param name="Schema">The schema to declare, or <see langword="null"/> to declare none.</param>
/// <remarks>
/// <para>
/// <b>The schema is refused here rather than repaired.</b> The reader that loads a stored schema is
/// total - it drops what it cannot interpret so that a bad schema never makes the items beneath it
/// unreadable - and this is the counterpart: the one place a person finds out their schema was
/// wrong, while they are looking at it, instead of discovering later that half of it silently did
/// nothing.
/// </para>
/// <para>
/// Editing a schema never touches the values beneath it. A property removed from a schema stops
/// being validated and stops being shown; its values stay where they are and come back if the
/// schema does. See ADR-0007 §4 for why the alternative - invalidating stored data because
/// somebody edited a definition - is the worse failure.
/// </para>
/// </remarks>
public sealed record SetItemSchema(ItemId ItemId, PropertySchema? Schema) : ICommand<PropertySchema>;

/// <summary>Handles <see cref="SetItemSchema"/>.</summary>
public sealed class SetItemSchemaHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    TimeProvider clock)
    : ICommandHandler<SetItemSchema, PropertySchema>
{
    private readonly INixSessionContextAccessor _session = session;

    /// <summary>Sets the schema.</summary>
    /// <param name="command">The container and the schema to declare.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The stored schema, or why it could not be stored.</returns>
    public async ValueTask<Result<PropertySchema>> HandleAsync(
        SetItemSchema command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var itemId = command.ItemId;
        var schema = command.Schema;

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<PropertySchema>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        if (item.LifecycleState != ItemLifecycleState.Active)
        {
            return Result.Failure<PropertySchema>(
                ItemErrors.LifecycleConflict("A deleted item's schema cannot be changed."));
        }

        if (schema is null || schema.IsEmpty)
        {
            await tree
                .UpdateSchemaAsync(itemId, null, context.PrincipalId, clock.GetUtcNow(), cancellationToken)
                .ConfigureAwait(false);

            return Result.Success(PropertySchema.Empty);
        }

        if (PropertySchemaRules.Refuse(schema) is { } refusal)
        {
            return Result.Failure<PropertySchema>(PropertyErrors.InvalidSchema(refusal));
        }

        var json = PropertySchemaJson.Write(schema);
        if (System.Text.Encoding.UTF8.GetByteCount(json) > PropertyValidator.MaximumBytes)
        {
            // Checked here as well as by the column's constraint, so an oversized schema is a
            // problem document naming the limit rather than a constraint violation surfacing as
            // a 500.
            return Result.Failure<PropertySchema>(
                PropertyErrors.InvalidSchema(
                    $"A schema may be at most {PropertyValidator.MaximumBytes} bytes."));
        }

        await tree
            .UpdateSchemaAsync(itemId, json, context.PrincipalId, clock.GetUtcNow(), cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(schema);
    }

    /// <summary>
    /// Every reason a schema is not storable, or null when it is fine.
    /// </summary>
    /// <remarks>
    /// These are the rules the reader cannot enforce, because the reader has to stay total. A
    /// select with no options is the one worth naming: it parses perfectly and then rejects every
    /// value anybody could give it, which looks like a bug in the validator rather than an
    /// unfinished schema.
    /// </remarks>
    public static NixError? Validate(PropertySchema schema)
    {
        ArgumentNullException.ThrowIfNull(schema);
        return PropertySchemaRules.Refuse(schema) is { } reason
            ? PropertyErrors.InvalidSchema(reason)
            : null;
    }

}

/// <summary>
/// Route handler for declaring an item's property schema.
/// </summary>
/// <remarks>
/// Named apart from <see cref="SetItemSchema"/> itself: the command record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapPut</c> call site.
/// </remarks>
internal static class SetItemSchemaEndpoint
{
    /// <summary>The accepted type names, for the message a caller sees when they miss.</summary>
    /// <remarks>
    /// Written from the enum rather than typed out, so it cannot fall behind the vocabulary the way
    /// a hand-maintained list would. Built once: the set cannot change while the process runs.
    /// </remarks>
    private static readonly string AcceptedTypeNames = string.Join(
        ", ",
        Enum.GetValues<PropertyType>().Select(PropertyTypes.ToText));

    /// <summary>Handles a request to declare an item's property schema.</summary>
    /// <param name="itemId">The container.</param>
    /// <param name="request">The schema to declare.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command and the follow-up query to their handlers.</param>
    /// <returns>The effective schema after the write, or a problem describing why it failed.</returns>
    internal static async Task<Results<Ok<EffectiveSchemaResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        SetSchemaRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        if (!PropertyMapping.TryToDomain(request, out var schema, out var unknownType))
        {
            // Refused rather than dropped. The stored-schema reader drops what it cannot interpret
            // so a bad schema never makes items unreadable; a request somebody is waiting on an
            // answer to is the opposite case.
            return TypedResults.Problem(
                StructureEndpoints.Problem(
                    httpContext,
                    PropertyErrors.InvalidSchema(
                        $"'{unknownType}' is not a property type. Expected one of: {AcceptedTypeNames}.")));
        }

        var stored = await dispatcher
            .SendAsync<SetItemSchema, PropertySchema>(
                new SetItemSchema(ItemId.From(itemId), schema),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (stored.IsFailure)
        {
            return TypedResults.Problem(StructureEndpoints.Problem(httpContext, stored.Error));
        }

        // Re-resolved rather than echoing what was sent: what the caller now needs is the merged
        // result, and only the resolver knows what the ancestors contribute.
        var effective = await dispatcher
            .QueryAsync<GetEffectiveSchema, Result<EffectiveSchema>>(
                new GetEffectiveSchema(ItemId.From(itemId)),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return effective.Match<Results<Ok<EffectiveSchemaResponse>, ProblemHttpResult>>(
            resolved => TypedResults.Ok(PropertyMapping.ToResponse(resolved.Effective, resolved.Declared)),
            error => TypedResults.Problem(StructureEndpoints.Problem(httpContext, error)));
    }
}
