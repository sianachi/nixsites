using System.Text.Json;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Features.Conversations;
using Nix.Features.Items;
using Nix.Features.Locks;
using Nix.Features.Pets;
using Nix.Features.Properties;
using Nix.Features.Workspaces;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class ConversationPersistenceTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;
    private static readonly Guid Pet = new("fee11111-1111-4111-8111-111111111111");
    private static readonly Guid Reader = new("fee22222-1111-4111-8111-111111111111");
    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private async Task<Guid> Create(IReadOnlyList<ConversationImportMessage>? messages = null, Guid? groupId = null)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var dispatcher = work.Resolve<NixDispatcher>();
        var previousSettings = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), Cancellation);
        var settings = await dispatcher.SendAsync<SavePetSettings, PetSettingsResponse>(new(previousSettings.Revision,
            new(true, Pet, [new(Pet, "Analyst", "cat", "")])), Cancellation);
        Assert.True(settings.IsSuccess, settings.IsFailure ? settings.Error.Message : "");
        if (groupId is { } group)
        {
            var previousArrangement = await dispatcher.QueryAsync<GetWorkspaceArrangement, WorkspaceArrangementResponse>(new(), Cancellation);
            var arrangement = await dispatcher.SendAsync<SaveWorkspaceArrangement, WorkspaceArrangementResponse>(new(previousArrangement.Revision,
                new([new(group, "Research", [TestTenants.AlphaWorkspace])], [])), Cancellation);
            Assert.True(arrangement.IsSuccess);
        }
        var made = await dispatcher.SendAsync<CreateConversation, ConversationResponse>(new(TestTenants.AlphaWorkspace,
            new("Research chat", null, [TestTenants.AlphaWorkspace], Pet, groupId, messages)), Cancellation);
        Assert.True(made.IsSuccess, made.IsFailure ? made.Error.Message : "");
        await work.CommitAsync(Cancellation);
        return made.Value.ItemId;
    }

    [Fact]
    public async Task Imported_messages_survive_a_new_request_page_in_order_and_stay_tenant_isolated()
    {
        var group = Guid.NewGuid();
        var id = await Create([new("user", "Compare priorities"), new("assistant", "The first priority is shipping.")], group);
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var chat = await dispatcher.QueryAsync<GetConversation, Result<ConversationResponse>>(new(id), Cancellation);
            Assert.True(chat.IsSuccess);
            Assert.True(chat.Value.CanSend);
            Assert.Equal([TestTenants.AlphaWorkspace], chat.Value.SourceWorkspaceIds);
            var first = await dispatcher.QueryAsync<GetConversationMessages, Result<ConversationMessagesResponse>>(new(id, null, 1), Cancellation);
            Assert.Equal("Compare priorities", Assert.Single(first.Value.Items).Text);
            Assert.NotNull(first.Value.NextCursor);
            var next = await dispatcher.QueryAsync<GetConversationMessages, Result<ConversationMessagesResponse>>(new(id, first.Value.NextCursor, 1), Cancellation);
            Assert.Equal("The first priority is shipping.", Assert.Single(next.Value.Items).Text);
            Assert.Null(next.Value.NextCursor);
            var item = await work.Resolve<IItemTree>().FindAsync(new ItemId(id), Cancellation);
            Assert.Equal("document", item!.Type);
            var arrangement = await dispatcher.QueryAsync<GetWorkspaceArrangement, WorkspaceArrangementResponse>(new(), Cancellation);
            Assert.Equal([id], Assert.Single(arrangement.Groups).ConversationItemIds);
            Assert.Equal(TestTenants.AlphaWorkspace, arrangement.Groups[0].LastDestinationWorkspaceId);
        }
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation))
        {
            var denied = await work.Resolve<NixDispatcher>().QueryAsync<GetConversation, Result<ConversationResponse>>(new(id), Cancellation);
            Assert.True(denied.IsFailure);
            Assert.Equal("conversations.not_found", denied.Error.Code);
        }
    }

    [Fact]
    public async Task Retrying_a_send_request_does_not_append_a_second_user_message()
    {
        var id = await Create();
        var request = new SendConversationRequest(Guid.NewGuid(), "One durable question");
        for (var attempt = 0; attempt < 2; attempt++)
        {
            await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            var sent = await work.Resolve<NixDispatcher>().SendAsync<SendConversation, ConversationResponse>(new(id, request), Cancellation);
            Assert.True(sent.IsSuccess, sent.IsFailure ? sent.Error.Message : "");
            await work.CommitAsync(Cancellation);
        }
        // This storage host deliberately has no model worker. Its background turn settles as interrupted.
        for (var attempt = 0; attempt < 30; attempt++)
        {
            await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            var chat = await work.Resolve<NixDispatcher>().QueryAsync<GetConversation, Result<ConversationResponse>>(new(id), Cancellation);
            if (chat.Value.Turn?.Status != "running")
            {
                var messages = await work.Resolve<NixDispatcher>().QueryAsync<GetConversationMessages, Result<ConversationMessagesResponse>>(new(id, null, 50), Cancellation);
                Assert.Equal("One durable question", Assert.Single(messages.Value.Items).Text);
                return;
            }
            await Task.Delay(50, Cancellation);
        }
        Assert.Fail("The worker-less turn did not settle.");
    }

    [Fact]
    public async Task Concurrent_claims_have_one_winner_and_cancel_fences_a_late_assistant_completion()
    {
        var id = await Create();
        async Task<Result<ConversationResponse>> Claim(string text)
        {
            await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            var result = await work.Resolve<ConversationService>().Begin(id, new(Guid.NewGuid(), text), Cancellation);
            if (result.IsSuccess)
            {
                await work.CommitAsync(Cancellation);
            }
            return result;
        }
        var results = await Task.WhenAll(Claim("First sender"), Claim("Second sender"));
        var winner = Assert.Single(results, result => result.IsSuccess).Value;
        Assert.Equal("conversations.busy", Assert.Single(results, result => result.IsFailure).Error.Code);
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var service = work.Resolve<ConversationService>();
        var cancelled = await service.UpdateTurn(id, winner.Turn!.RequestId, "cancelled", "", null, Cancellation);
        Assert.Equal("cancelled", cancelled.Value.Turn!.Status);
        var late = await service.UpdateTurn(id, winner.Turn.RequestId, "completed", "Late provider content", null, Cancellation);
        Assert.Equal("cancelled", late.Value.Turn!.Status);
        var messages = await service.Messages(id, null, 50, Cancellation);
        Assert.Single(messages.Value.Items);
        Assert.DoesNotContain(messages.Value.Items, message => message.Text == "Late provider content");
        await work.CommitAsync(Cancellation);
    }

    [Fact]
    public async Task Expired_turn_is_interrupted_without_losing_the_committed_user_message()
    {
        var id = await Create();
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var service = work.Resolve<ConversationService>();
            var begun = await service.Begin(id, new(Guid.NewGuid(), "Keep this message"), Cancellation);
            Assert.True(begun.IsSuccess);
            var tree = work.Resolve<IItemTree>();
            var item = await tree.FindAsync(new ItemId(id), Cancellation);
            var bag = System.Text.Json.Nodes.JsonNode.Parse(item!.Properties!)!;
            var config = System.Text.Json.Nodes.JsonNode.Parse(bag["$chat_config"]!.GetValue<string>())!;
            config["turn"]!["expiresAt"] = DateTimeOffset.UtcNow.AddMinutes(-1).ToString("O", System.Globalization.CultureInfo.InvariantCulture);
            await tree.UpdateConversationConfigurationAsync(item.Id, config.ToJsonString(), item.CreatedBy, DateTimeOffset.UtcNow, Cancellation);
            await work.CommitAsync(Cancellation);
        }
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var service = work.Resolve<ConversationService>();
            var read = await service.Read(id, Cancellation);
            Assert.Equal("interrupted", read.Value.Turn!.Status);
            var messages = await service.Messages(id, null, 50, Cancellation);
            Assert.Equal("Keep this message", Assert.Single(messages.Value.Items).Text);
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Revoked_source_pauses_sending_while_destination_remains_editable()
    {
        var id = await Create();
        Guid sourceId;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var made = await work.Resolve<NixDispatcher>().SendAsync<CreateWorkspace, Nix.Persistence.Workspaces.WorkspaceSnapshot>(new("Source workspace"), Cancellation);
            Assert.True(made.IsSuccess);
            sourceId = made.Value.Id.Value;
            var service = work.Resolve<ConversationService>();
            var current = await service.Read(id, Cancellation);
            var changed = await work.Resolve<NixDispatcher>().SendAsync<ChangeConversationSources, ConversationResponse>(new(id,
                new([TestTenants.AlphaWorkspace, sourceId], current.Value.Revision)), Cancellation);
            Assert.True(changed.IsSuccess);
            await work.CommitAsync(Cancellation);
        }
        await using (var connection = new NpgsqlConnection(fixture.SuperuserConnectionString))
        {
            await connection.OpenAsync(Cancellation);
            await RawSql.ExecuteAsync(connection, null, $"""
                DELETE FROM tenant_role WHERE tenant_id='{TestTenants.Alpha}' AND subject_id='{TestTenants.AlphaPrincipal}';
                DELETE FROM workspace_member WHERE workspace_id='{sourceId}' AND subject_id='{TestTenants.AlphaPrincipal}';
                """);
        }
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var service = work.Resolve<ConversationService>();
            var current = await service.Read(id, Cancellation);
            Assert.True(current.Value.CanEdit);
            Assert.False(current.Value.CanSend);
            var refused = await service.Begin(id, new(Guid.NewGuid(), "Must not reach model"), Cancellation);
            Assert.Equal("conversations.sources_unavailable", refused.Error.Code);
        }
    }

    [Fact]
    public async Task Assistant_replies_report_the_workspaces_they_were_answered_from_and_older_ones_report_none()
    {
        var id = await Create([new("assistant", "Imported reply")]);
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var tree = work.Resolve<IItemTree>();
        var context = TestTenants.AlphaContext;
        var source = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        var messageId = ItemId.Create();
        var bag = new System.Text.Json.Nodes.JsonObject
        {
            ["chat_role"] = "assistant",
            ["chat_text"] = "Answered",
            ["chat_message_id"] = messageId.Value.ToString(),
            ["chat_sources"] = new System.Text.Json.Nodes.JsonArray(source.ToString(), "not-a-guid")
        };
        await tree.InsertAsync(new Item
        {
            Id = messageId,
            TenantId = context.TenantId,
            WorkspaceId = new(TestTenants.AlphaWorkspace),
            Type = "document",
            ParentId = new(id),
            Seq = await tree.NextSiblingSequenceAsync(new(TestTenants.AlphaWorkspace), new(id), Cancellation),
            Properties = bag.ToJsonString(),
            LifecycleState = ItemLifecycleState.Active,
            CreatedBy = context.PrincipalId,
            LastModifiedBy = context.PrincipalId,
            CreatedAt = now,
            LastModifiedAt = now
        }, Cancellation);
        var messages = await work.Resolve<ConversationService>().Messages(id, null, 50, Cancellation);
        Assert.Null(messages.Value.Items[0].SourceWorkspaceIds);
        Assert.Equal([source], messages.Value.Items[1].SourceWorkspaceIds);
    }

    [Fact]
    public async Task Long_unicode_transcripts_are_chunked_without_loss_below_the_property_storage_bound()
    {
        var text = new string('a', 2999) + "\U0001F600" + new string('界', 20000);
        var id = await Create([new("assistant", text), new("user", "Continue")]);
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var service = work.Resolve<ConversationService>();
        var messages = await service.Messages(id, null, 1, Cancellation);
        Assert.Equal(text, Assert.Single(messages.Value.Items).Text);
        Assert.NotNull(messages.Value.NextCursor);
        var next = await service.Messages(id, messages.Value.NextCursor, 1, Cancellation);
        Assert.Equal("Continue", Assert.Single(next.Value.Items).Text);
        Assert.Null(next.Value.NextCursor);
        var children = await work.Resolve<IItemTree>().ListChildrenAsync(new(TestTenants.AlphaWorkspace), new(id), false, null, 100, Cancellation);
        Assert.True(children.Count > 2);
        Assert.All(children, child => Assert.True(child.Properties!.Length < 32768));
    }

    [Fact]
    public async Task History_scans_a_bounded_page_of_non_message_children_and_can_continue()
    {
        var id = await Create();
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var tree = work.Resolve<IItemTree>();
        var parent = await tree.FindAsync(new(id), Cancellation);
        for (var index = 1; index <= 501; index++)
        {
            await tree.InsertAsync(new Item
            {
                Id = ItemId.Create(),
                TenantId = parent!.TenantId,
                WorkspaceId = parent.WorkspaceId,
                Type = "document",
                ParentId = parent.Id,
                Seq = index * 1000,
                Properties = "{\"title\":\"Other child\"}",
                LifecycleState = ItemLifecycleState.Active,
                CreatedBy = parent.CreatedBy,
                LastModifiedBy = parent.CreatedBy,
                CreatedAt = parent.CreatedAt,
                LastModifiedAt = parent.CreatedAt
            }, Cancellation);
        }
        var service = work.Resolve<ConversationService>();
        var sent = await service.Begin(id, new(Guid.NewGuid(), "Visible after ordinary children"), Cancellation);
        Assert.True(sent.IsSuccess);
        var first = await service.Messages(id, null, 1, Cancellation);
        Assert.Empty(first.Value.Items);
        Assert.Equal("500000", first.Value.NextCursor);
        var next = await service.Messages(id, first.Value.NextCursor, 1, Cancellation);
        Assert.Equal("Visible after ordinary children", Assert.Single(next.Value.Items).Text);
        Assert.Null(next.Value.NextCursor);
    }

    [Fact]
    public async Task Locked_rows_are_omitted_from_both_search_and_list_tool_results()
    {
        var id = await Create();
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var dispatcher = work.Resolve<NixDispatcher>();
        var secret = await dispatcher.SendAsync<CreateItem, Item>(new(new Nix.Domain.Tenancy.WorkspaceId(TestTenants.AlphaWorkspace),
            "document", "Confidential tool leak probe", null, null), Cancellation);
        Assert.True(secret.IsSuccess);
        var locked = await dispatcher.SendAsync<LockItem, bool>(new(secret.Value.Id, "a-test-password", null), Cancellation);
        Assert.True(locked.IsSuccess);
        var requestId = Guid.NewGuid();
        var begun = await work.Resolve<ConversationService>().Begin(id, new(requestId, "Look for confidential material"), Cancellation);
        Assert.True(begun.IsSuccess);
        foreach (var operation in new[] { "search", "list_items" })
        {
            var arguments = new Dictionary<string, JsonElement>
            {
                ["operation"] = JsonSerializer.SerializeToElement(operation),
                ["workspaceId"] = JsonSerializer.SerializeToElement(TestTenants.AlphaWorkspace.ToString()),
                ["query"] = JsonSerializer.SerializeToElement("Confidential tool leak probe"),
            };
            var result = await ConversationTools.Execute(id, new(TestTenants.Alpha, TestTenants.AlphaPrincipal, requestId, arguments),
                work.Resolve<IServiceProvider>(), Cancellation);
            Assert.True(result.Success, result.Result);
            Assert.DoesNotContain("Confidential tool leak probe", result.Result, StringComparison.Ordinal);
            Assert.DoesNotContain(secret.Value.Id.Value.ToString(), result.Result, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Trash_and_restore_before_lease_expiry_interrupts_the_turn_and_keeps_the_transcript()
    {
        var id = await Create();
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var begun = await work.Resolve<ConversationService>().Begin(id, new(Guid.NewGuid(), "Preserve through trash"), Cancellation);
            Assert.True(begun.IsSuccess);
            var dispatcher = work.Resolve<NixDispatcher>();
            var trashed = await dispatcher.SendAsync<DeleteItem, ItemId>(new(new ItemId(id)), Cancellation);
            Assert.True(trashed.IsSuccess);
            var restored = await dispatcher.SendAsync<RestoreItem, Item>(new(new ItemId(id)), Cancellation);
            Assert.True(restored.IsSuccess);
            await work.CommitAsync(Cancellation);
        }
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var service = work.Resolve<ConversationService>();
            var read = await service.Read(id, Cancellation);
            Assert.Equal("interrupted", read.Value.Turn!.Status);
            var messages = await service.Messages(id, null, 50, Cancellation);
            Assert.Equal("Preserve through trash", Assert.Single(messages.Value.Items).Text);
        }
    }

    [Fact]
    public async Task Locked_message_children_are_not_returned_as_plain_transcript_text()
    {
        var id = await Create([new("assistant", "Individually locked transcript text")]);
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var service = work.Resolve<ConversationService>();
        var before = await service.Messages(id, null, 50, Cancellation);
        var messageId = Assert.Single(before.Value.Items).Id;
        var locked = await work.Resolve<NixDispatcher>().SendAsync<LockItem, bool>(new(new ItemId(messageId), "a-test-password", null), Cancellation);
        Assert.True(locked.IsSuccess);
        var after = await service.Messages(id, null, 50, Cancellation);
        Assert.Empty(after.Value.Items);
    }

    [Fact]
    public async Task Reserved_turn_configuration_cannot_be_replaced_or_removed_through_ordinary_properties()
    {
        var id = await Create();
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        foreach (var change in new[] { "{\"$chat_config\":null}", "{\"$chat_config\":\"forged\"}" })
        {
            var refused = await work.Resolve<NixDispatcher>().SendAsync<SetItemProperties, Item>(new(new ItemId(id), change), Cancellation);
            Assert.True(refused.IsFailure);
        }
        var chat = await work.Resolve<NixDispatcher>().QueryAsync<GetConversation, Result<ConversationResponse>>(new(id), Cancellation);
        Assert.True(chat.IsSuccess);
        Assert.Null(chat.Value.Turn);
    }

    [Fact]
    public async Task Readers_can_read_saved_messages_but_cannot_change_sources_or_send()
    {
        var id = await Create([new("assistant", "Shared result")]);
        await using (var connection = new NpgsqlConnection(fixture.SuperuserConnectionString))
        {
            await connection.OpenAsync(Cancellation);
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO principal (principal_id,tenant_id,external_issuer,external_subject,kind,display_name,status)
                VALUES ('{Reader}', '{TestTenants.Alpha}', 'https://issuer.alpha.test', 'chat-reader', 'user', 'Chat reader', 'active');
                INSERT INTO workspace_member (workspace_id,subject_type,subject_id,tenant_id,role,granted_by,granted_at)
                VALUES ('{TestTenants.AlphaWorkspace}', 'principal', '{Reader}', '{TestTenants.Alpha}', 'viewer', '{TestTenants.AlphaPrincipal}', now());
                """);
        }
        var context = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Reader);
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        var dispatcher = work.Resolve<NixDispatcher>();
        var read = await dispatcher.QueryAsync<GetConversation, Result<ConversationResponse>>(new(id), Cancellation);
        Assert.True(read.IsSuccess);
        Assert.False(read.Value.CanSend);
        Assert.False(read.Value.CanEdit);
        var messages = await dispatcher.QueryAsync<GetConversationMessages, Result<ConversationMessagesResponse>>(new(id, null, 50), Cancellation);
        Assert.Equal("Shared result", Assert.Single(messages.Value.Items).Text);
        var sources = await dispatcher.SendAsync<ChangeConversationSources, ConversationResponse>(new(id,
            new([TestTenants.AlphaWorkspace], read.Value.Revision)), Cancellation);
        Assert.True(sources.IsFailure);
    }
}
