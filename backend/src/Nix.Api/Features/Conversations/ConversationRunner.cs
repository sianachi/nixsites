using Nix.Abstractions;
using Nix.Domain.Primitives;
using Nix.Features.Pets;
using Nix.Messaging;

namespace Nix.Features.Conversations;

/// <summary>Turn work owns independent transactions and survives browser disconnects.</summary>
public sealed class ConversationRunner(IIsolatedUnitOfWork units, IHostApplicationLifetime? lifetime = null)
{
    internal async Task<Result<ConversationResponse>> Send(NixSessionContext context, Guid id, SendConversationRequest request, CancellationToken cancellationToken)
    {
        var result = await units.RunAsync(context, async (services, token) =>
        {
            var service = services.GetRequiredService<ConversationService>();
            var read = await service.Read(id, token).ConfigureAwait(false);
            var duplicate = read.IsSuccess && read.Value.Turn?.RequestId == request.RequestId;
            var begun = await service.Begin(id, request, token).ConfigureAwait(false);
            return new IsolatedOutcome<(Result<ConversationResponse> Result, bool Launch)>((begun, begun.IsSuccess && !duplicate
                && begun.Value.Turn?.RequestId == request.RequestId && begun.Value.Turn.Status == "running"), begun.IsSuccess);
        }, cancellationToken).ConfigureAwait(false);
        if (result.Launch)
        {
            _ = Run(context, id, request);
        }

        return result.Result;
    }

    private async Task Run(NixSessionContext context, Guid id, SendConversationRequest request)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(lifetime?.ApplicationStopping ?? CancellationToken.None);
        deadline.CancelAfter(TimeSpan.FromMinutes(3));
        try
        {
            var sent = false;
            while (!deadline.IsCancellationRequested)
            {
                var again = await units.RunAsync(context, async (services, token) =>
                {
                    var service = services.GetRequiredService<ConversationService>();
                    var found = await service.Find(id, true, token).ConfigureAwait(false);
                    if (found.IsFailure)
                    {
                        return new IsolatedOutcome<bool>(false, false);
                    }

                    var config = ConversationService.Configuration(found.Value)!;
                    if (config.Turn is not { Status: "running" } active || active.RequestId != request.RequestId)
                    {
                        if (config.Turn?.RequestId == request.RequestId && config.Turn.Status == "cancelled")
                        {
                            await services.GetRequiredService<PetWorkerClient>().ExecuteConversationAsync(new("interrupt", found.Value.WorkspaceId.Value,
                                config.Turn.PetId ?? config.PetId, request.RequestId, Mode: "chat"), id, config.SourceWorkspaceIds, null, token).ConfigureAwait(false);
                        }
                        return new IsolatedOutcome<bool>(false, false);
                    }
                    if (!await service.SourcesAvailable(config.SourceWorkspaceIds, token).ConfigureAwait(false))
                    {
                        await service.UpdateTurn(id, request.RequestId, "interrupted", "", "Source access changed. Update the sources before continuing.", token).ConfigureAwait(false);
                        return new IsolatedOutcome<bool>(false, true);
                    }
                    IReadOnlyList<PetMessage>? earlier = null;
                    if (!sent)
                    {
                        var all = new Queue<ConversationMessageResponse>();
                        var total = 0;
                        string? cursor = null;
                        do
                        {
                            var page = await service.Messages(id, cursor, 100, token).ConfigureAwait(false);
                            if (page.IsFailure)
                            {
                                return new IsolatedOutcome<bool>(false, false);
                            }

                            foreach (var message in page.Value.Items)
                            {
                                all.Enqueue(message);
                                total++;
                                while (all.Count > 129)
                                {
                                    all.Dequeue();
                                }
                            }
                            cursor = page.Value.NextCursor;
                        } while (cursor is not null);
                        // The durable transcript remains complete. The provider receives its bounded recent context.
                        var budget = 0;
                        var selected = new List<PetMessage>();
                        foreach (var message in all.Where(message => message.RequestId != request.RequestId).Reverse().Take(128))
                        {
                            if (budget + message.Text.Length > 120000)
                            {
                                break;
                            }

                            budget += message.Text.Length;
                            selected.Add(new(message.Id.ToString(), message.Role, message.Text));
                        }
                        selected.Reverse();
                        if (total > selected.Count + all.Count(message => message.RequestId == request.RequestId))
                        {
                            if (selected.Count == 128)
                            {
                                selected.RemoveAt(0);
                            }

                            selected.Insert(0, new("context-truncated", "system", "Earlier saved messages are omitted from this provider context. Do not assume the transcript is complete."));
                        }
                        earlier = selected;
                    }
                    var worker = services.GetRequiredService<PetWorkerClient>();
                    var response = await worker.ExecuteConversationAsync(new(sent ? "read" : "send", found.Value.WorkspaceId.Value,
                        active.PetId ?? config.PetId, request.RequestId, sent ? "" : request.Text, Model: request.Model ?? "", Mode: "chat"),
                        id, config.SourceWorkspaceIds, earlier, token).ConfigureAwait(false);
                    sent = true;
                    if (response.IsFailure)
                    {
                        await service.UpdateTurn(id, request.RequestId, "failed", "", response.Error.Message, token).ConfigureAwait(false);
                        return new IsolatedOutcome<bool>(false, true);
                    }
                    var value = response.Value;
                    var text = value.Messages?.LastOrDefault(message => message.Role == "assistant")?.Text ?? "";
                    var running = value.State is "working" or "running" or "thinking" or "sending" or "busy";
                    var status = running ? "running" : value.State == "success" ? "completed" : value.State == "idle" ? "interrupted" : "failed";
                    await service.UpdateTurn(id, request.RequestId, status, text, status == "failed" ? value.Reason : null, token).ConfigureAwait(false);
                    return new IsolatedOutcome<bool>(running, true);
                }, deadline.Token).ConfigureAwait(false);
                if (!again)
                {
                    return;
                }

                await Task.Delay(TimeSpan.FromSeconds(1), deadline.Token).ConfigureAwait(false);
            }
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            try
            {
                await units.RunAsync(context, async (services, token) =>
                {
                    await services.GetRequiredService<ConversationService>().UpdateTurn(id, request.RequestId, "interrupted", "",
                        "The reply was interrupted. Your saved messages are preserved.", token).ConfigureAwait(false);
                    return new IsolatedOutcome<bool>(true, true);
                }, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception recovery) when (recovery is not OutOfMemoryException) { /* The persisted lease expires and the next read marks interruption. */ }
        }
    }
}

public sealed class ConversationHandlers(ConversationService service, ConversationRunner runner, INixSessionContextAccessor session, IWorkspaceLocks workspaceLocks)
    : ICommandHandler<CreateConversation, ConversationResponse>, ICommandHandler<ConfigureConversation, ConversationResponse>, IQueryHandler<GetConversation, Result<ConversationResponse>>,
      IQueryHandler<GetConversationMessages, Result<ConversationMessagesResponse>>, ICommandHandler<SendConversation, ConversationResponse>,
      ICommandHandler<CancelConversation, ConversationResponse>, ICommandHandler<ChangeConversationSources, ConversationResponse>
{
    public async ValueTask<Result<ConversationResponse>> HandleAsync(ConfigureConversation command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        return await service.Configure(command.ItemId, command.Request, cancellationToken).ConfigureAwait(false);
    }
    public async ValueTask<Result<ConversationResponse>> HandleAsync(CreateConversation command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        return await service.Create(command.WorkspaceId, command.Request, cancellationToken).ConfigureAwait(false);
    }
    public async ValueTask<Result<ConversationResponse>> HandleAsync(GetConversation query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return await service.Read(query.ItemId, cancellationToken).ConfigureAwait(false);
    }
    public async ValueTask<Result<ConversationMessagesResponse>> HandleAsync(GetConversationMessages query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return await service.Messages(query.ItemId, query.Cursor, query.Limit, cancellationToken).ConfigureAwait(false);
    }
    public async ValueTask<Result<ConversationResponse>> HandleAsync(SendConversation command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        // A turn runs after this request returns, in units of work that hold no browser session or
        // token and so can never hold a workspace unlock. In a password-protected workspace it
        // would fail with a missing conversation, so say why here instead, while the person is
        // looking. Nothing is widened to make it work.
        var found = await service.Find(command.ItemId, true, cancellationToken).ConfigureAwait(false);
        if (found.IsSuccess
            && (await workspaceLocks.GetStateAsync(found.Value.WorkspaceId, cancellationToken).ConfigureAwait(false)).PasswordProtected)
        {
            return Result.Failure<ConversationResponse>(new(
                "conversations.workspace_protected",
                "Chat is not available in a password-protected workspace. Remove the workspace password to use it."));
        }

        return await runner.Send(session.Current!.Value, command.ItemId, command.Request, cancellationToken).ConfigureAwait(false);
    }
    public async ValueTask<Result<ConversationResponse>> HandleAsync(CancelConversation command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        return await service.UpdateTurn(command.ItemId, null, "cancelled", "", null, cancellationToken).ConfigureAwait(false);
    }
    public async ValueTask<Result<ConversationResponse>> HandleAsync(ChangeConversationSources command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        return await service.ChangeSources(command.ItemId, command.Request, cancellationToken).ConfigureAwait(false);
    }
}
