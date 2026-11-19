using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Abstractions.Automations;
using Nix.Abstractions.Connections;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Automations;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Connections;
using Nix.Messaging;

namespace Nix.Features.PetRuns;

internal sealed record PollPetMailbox(PetRoutineBinding Binding, Guid ExecutionId) : ICommand<bool>;

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class PetMailboxPollHandler(
    IAutomationRuleStore rules, IConnectorStore grants, ConnectorActions connectors,
    IPetMailboxPollStore polls, PetRunService runs, IItemTree items, INixSessionContextAccessor session) : ICommandHandler<PollPetMailbox, bool>
{
    internal const string GmailCheckpoint = "gmail.checkpoint";
    internal const string GmailChanges = "gmail.list-changes";
    internal const string OutlookChanges = "outlook-mail.poll-folder";

    public async ValueTask<Result<bool>> HandleAsync(PollPetMailbox command, CancellationToken cancellationToken)
    {
        var rule = await rules.GetForUpdateAsync(command.Binding.RuleId, cancellationToken).ConfigureAwait(false);
        if (rule is not { Enabled: true, TriggerType: "schedule", ScopeItemId: { } itemId }
            || rule.Revision != command.Binding.Revision
            || AutomationActionJson.ReadStored(rule.Actions) is not [PollPetMailboxAction watch]
            || session.Current is not { } caller || rule.OwnerPrincipalId != caller.PrincipalId || rule.TenantId != caller.TenantId
            || await items.FindAsync(itemId, cancellationToken).ConfigureAwait(false) is not
            { Type: "note", LifecycleState: ItemLifecycleState.Active } item || item.WorkspaceId != rule.WorkspaceId
            || ItemSettings.Read(item.Settings).WithholdFromPets
            || !await GrantAvailableAsync(rule.WorkspaceId, watch, false, cancellationToken).ConfigureAwait(false))
        {
            return Result.Success(false);
        }

        var current = await polls.ReadAsync(rule.Id, watch, cancellationToken).ConfigureAwait(false);
        var action = watch.Provider == "gmail" ? current is null ? GmailCheckpoint : GmailChanges : OutlookChanges;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(20));
        Result<JsonElement> result;
        try
        {
            result = await ReadAsync(rule.WorkspaceId, watch, action, command.ExecutionId, current, deadline.Token).ConfigureAwait(false);
            if (result.IsFailure && action == GmailChanges && current?.PageToken is not null && !deadline.IsCancellationRequested)
            {
                // Gmail signs page tokens with the current OAuth access token. Restart a page walk
                // from its durable history checkpoint if refreshing the token invalidated a page.
                result = await ReadAsync(rule.WorkspaceId, watch, action, command.ExecutionId,
                    current with { PageToken = null }, deadline.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && deadline.IsCancellationRequested)
        {
            return Result.Failure<bool>(ConnectorErrors.Unavailable());
        }
        cancellationToken.ThrowIfCancellationRequested();
        if (result.IsFailure)
        {
            return result.Error.Code is "connector.not_found" or "connector.changed"
                ? Result.Success(false)
                : Result.Failure<bool>(result.Error);
        }
        if (PetMailboxPage.Read(action, current, result.Value) is not { } page)
        {
            return Result.Failure<bool>(new NixError("mailbox.invalid_page", "The provider returned an invalid mailbox page."));
        }
        if (page.ResyncRequired)
        {
            return Result.Failure<bool>(new NixError("mailbox.resync_required", "The mailbox history expired. Create a new watch to begin at the current mailbox."));
        }
        // The provider call runs in a separate transaction. Check the exact grant again and
        // pin it under this transaction before persisting the cursor and newly queued jobs.
        if (!await GrantAvailableAsync(rule.WorkspaceId, watch, true, cancellationToken).ConfigureAwait(false))
        {
            return Result.Success(false);
        }

        var queued = false;
        foreach (var messageId in page.MessageIds)
        {
            if (!await polls.MarkSeenAsync(rule.Id, watch, messageId, cancellationToken).ConfigureAwait(false))
            {
                continue;
            }
            var getMessage = watch.Provider == "gmail" ? "gmail.get-message" : "outlook-mail.get-message";
            var brief = $"""
                {watch.Brief}

                A message arrived in the configured mailbox. Request review to read it using connection.action with
                connectionId {watch.ConnectionId:D}, action {getMessage}, and arguments.messageId "{messageId}".
                Request a separate decision for any proposed reply or external edit.
                """;
            var started = await runs.StartAsync(itemId,
                new StartPetRunRequest(brief, Abilities: ["connection.action", "task.comment"], IncludeTargetText: watch.IncludeTargetText),
                cancellationToken).ConfigureAwait(false);
            if (started.IsFailure)
            {
                return Result.Failure<bool>(started.Error);
            }
            queued = true;
        }
        await polls.SaveAsync(rule.Id, watch, page.Cursor, cancellationToken).ConfigureAwait(false);
        return Result.Success(queued);
    }

    private async Task<bool> GrantAvailableAsync(
        WorkspaceId workspace, PollPetMailboxAction watch, bool lockForUpdate, CancellationToken cancellationToken) =>
        await grants.GetAsync(workspace, watch.ConnectionId, lockForUpdate, cancellationToken).ConfigureAwait(false) is { ProtectedTokens: not null } grant
        && grant.Revision == watch.ConnectionRevision && grant.ResourceId == watch.ResourceId
        && (watch.Provider == "gmail"
            ? grant.Provider == "google" && grant.ResourceKind == "gmail-label" && grant.Actions.Contains(GmailCheckpoint, StringComparer.Ordinal)
                && grant.Actions.Contains(GmailChanges, StringComparer.Ordinal) && grant.Actions.Contains("gmail.get-message", StringComparer.Ordinal)
            : grant.Provider == "microsoft" && grant.ResourceKind == "folder" && grant.Actions.Contains(OutlookChanges, StringComparer.Ordinal)
                && grant.Actions.Contains("outlook-mail.get-message", StringComparer.Ordinal));

    private async Task<Result<JsonElement>> ReadAsync(
        WorkspaceId workspace, PollPetMailboxAction watch, string action, Guid executionId, PetMailboxCursor? cursor,
        CancellationToken cancellationToken)
    {
        var arguments = new JsonObject();
        if (cursor is not null && action == GmailChanges)
        {
            arguments["after"] = cursor.Cursor;
            arguments["pageSize"] = 5;
            if (cursor.PageToken is not null)
            {
                arguments["pageToken"] = cursor.PageToken;
            }
        }
        if (cursor is not null && action == OutlookChanges)
        {
            arguments["cursor"] = cursor.Cursor;
        }
        using var document = JsonDocument.Parse(arguments.ToJsonString());
        var preview = await connectors.PreviewAsync(workspace, watch.ConnectionId, action,
            document.RootElement, cancellationToken).ConfigureAwait(false);
        if (preview.IsFailure)
        {
            return Result.Failure<JsonElement>(preview.Error);
        }
        if (preview.Value is not { Kind: "read" } prepared || prepared.ConnectionRevision != watch.ConnectionRevision
            || prepared.ResourceId != watch.ResourceId || prepared.Action != action)
        {
            return Result.Failure<JsonElement>(ConnectorErrors.Stale());
        }
        return await connectors.ExecuteAsync(workspace, executionId, prepared, cancellationToken).ConfigureAwait(false);
    }
}

internal sealed record PetMailboxPage(PetMailboxCursor Cursor, IReadOnlyList<string> MessageIds, bool ResyncRequired = false)
{
    internal static PetMailboxPage? Read(string action, PetMailboxCursor? current, JsonElement data)
    {
        if (data.ValueKind != JsonValueKind.Object)
        {
            return null;
        }
        return action switch
        {
            PetMailboxPollHandler.GmailCheckpoint => ReadText(data, "historyId", 25) is { } baseline && baseline.All(char.IsAsciiDigit)
                ? new PetMailboxPage(new PetMailboxCursor(baseline, null, true), []) : null,
            PetMailboxPollHandler.GmailChanges when current is not null => ReadGmail(current, data),
            PetMailboxPollHandler.OutlookChanges => ReadOutlook(current, data),
            _ => null,
        };
    }

    private static PetMailboxPage? ReadGmail(PetMailboxCursor current, JsonElement data)
    {
        if (ReadText(data, "status", 24) == "resync_required")
        {
            return new PetMailboxPage(current, [], ResyncRequired: true);
        }
        var pageToken = ReadText(data, "nextPageToken", 8192);
        return ReadText(data, "status", 24) == "ready"
            && ReadText(data, "historyId", 25) is { } history && history.All(char.IsAsciiDigit)
            && (pageToken is not null || !data.TryGetProperty("nextPageToken", out _))
            && ReadIds(data) is { } messages
            ? new PetMailboxPage(new PetMailboxCursor(pageToken is null ? history : current.Cursor, pageToken, true), messages)
            : null;
    }

    private static PetMailboxPage? ReadOutlook(PetMailboxCursor? current, JsonElement data)
    {
        if (ReadText(data, "cursor", 8192) is not { } cursor
            || !data.TryGetProperty("hasMore", out var hasMore) || hasMore.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
            || ReadIds(data) is not { } messages)
        {
            return null;
        }
        var baselined = current?.Baselined == true;
        return new PetMailboxPage(new PetMailboxCursor(cursor, null, baselined || !hasMore.GetBoolean()), baselined ? messages : []);
    }

    private static List<string>? ReadIds(JsonElement data)
    {
        if (!data.TryGetProperty("messages", out var entries) || entries.ValueKind != JsonValueKind.Array || entries.GetArrayLength() > 100)
        {
            return null;
        }
        var ids = new List<string>(entries.GetArrayLength());
        foreach (var entry in entries.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object || ReadText(entry, "id", 512) is not { } id
                || id.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('_' or '!' or '@' or ':' or '.' or '=' or '~' or '+' or '/' or '-')))
            {
                return null;
            }
            ids.Add(id);
        }
        return ids;
    }

    private static string? ReadText(JsonElement data, string name, int limit) =>
        data.TryGetProperty(name, out var member) && member.ValueKind == JsonValueKind.String
        && member.GetString() is { Length: > 0 } text && text.Length <= limit
        && text.All(c => char.IsAscii(c) && !char.IsControl(c)) ? text : null;
}
