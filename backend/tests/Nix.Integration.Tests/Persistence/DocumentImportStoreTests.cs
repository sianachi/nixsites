using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Importing;
using Nix.Abstractions.Templates;
using Nix.Abstractions.Workers;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Features.Conversations;
using Nix.Features.Pets;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.ObjectStorage;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Document imports stay hidden until their complete staged subtree can publish.</summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class DocumentImportStoreTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Native_chat_envelopes_round_trip_settings_messages_and_views_without_reviving_turns_or_granting_source_access(bool unavailableSource)
    {
        Guid importedId;
        var petId = Guid.NewGuid();
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var preferences = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), Cancellation);
            var saved = await dispatcher.SendAsync<SavePetSettings, PetSettingsResponse>(new(preferences.Revision,
                new(true, petId, "system", [new(petId, "Analyst", "cat", "calm", "balanced", "")])), Cancellation);
            Assert.True(saved.IsSuccess);
            var created = await dispatcher.SendAsync<CreateConversation, ConversationResponse>(new(TestTenants.AlphaWorkspace,
                new("Portable chat", null, [TestTenants.AlphaWorkspace], petId, Messages: [new("user", "Compare priorities"), new("assistant", "Saved insight")])), Cancellation);
            Assert.True(created.IsSuccess);
            var tree = work.Resolve<IItemTree>();
            var original = Assert.IsType<Item>(await tree.FindAsync(ItemId.From(created.Value.ItemId), Cancellation));
            var children = await tree.ListChildrenAsync(original.WorkspaceId, original.Id, false, null, 20, Cancellation);
            Assert.Equal(2, children.Count);
            var archivedBag = JsonNode.Parse(original.Properties!)!.AsObject();
            var archivedConfig = JsonNode.Parse(archivedBag["$chat_config"]!.GetValue<string>())!.AsObject();
            archivedConfig["turn"] = new JsonObject
            {
                ["id"] = Guid.NewGuid(),
                ["requestId"] = Guid.NewGuid(),
                ["actorId"] = TestTenants.BetaPrincipal,
                ["status"] = "running",
                ["expiresAt"] = "2099-01-01T00:00:00Z"
            };
            archivedConfig["completedRequestIds"] = new JsonArray(JsonValue.Create(Guid.NewGuid()));
            archivedConfig["providerThreadId"] = "must-not-import";
            if (unavailableSource)
            {
                archivedConfig["sourceWorkspaceIds"] = new JsonArray(JsonValue.Create(TestTenants.BetaWorkspace));
            }
            archivedBag["$chat_config"] = archivedConfig.ToJsonString();
            archivedBag["$chat_config_extra"] = "must-not-import";
            var plans = new List<ImportEnvelopePlan> { new("chat", null, 0, "Portable chat", original.Type, archivedBag.ToJsonString(),
                original.Schema, original.Views, "active", false, null) };
            plans.AddRange(children.Select((child, index) => new ImportEnvelopePlan($"message-{index}", "chat", index,
                ItemProperties.ReadTitle(child.Properties), child.Type, child.Properties, child.Schema, child.Views, "active", false, null)));
            var (imports, operation, digest) = await CommitQueuedAsync(work, "nix", "conversation.nix", 128, plans.Count);
            var stage = Assert.IsType<DocumentImportStageRecord>(await imports.StageAsync(new(DocumentImportId.From(operation.Id), new string('b', 64), digest, plans), Cancellation));
            importedId = stage.RootItemId;
            var staged = await work.DbContext.Items.IgnoreQueryFilters().AsNoTracking().SingleAsync(item => item.Id == ItemId.From(importedId), Cancellation);
            var stagedBag = JsonNode.Parse(staged.Properties!)!.AsObject();
            var stagedConfig = JsonNode.Parse(stagedBag["$chat_config"]!.GetValue<string>())!.AsObject();
            Assert.Null(stagedConfig["turn"]);
            Assert.Empty(stagedConfig["completedRequestIds"]!.AsArray());
            Assert.False(stagedConfig.ContainsKey("providerThreadId"));
            Assert.False(stagedBag.ContainsKey("$chat_config_extra"));
            Assert.IsType<DocumentImportRecord>(await imports.FinalizeAsync(DocumentImportId.From(operation.Id), Cancellation));
            await work.CommitAsync(Cancellation);
        }
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var service = work.Resolve<ConversationService>();
            var read = await service.Read(importedId, Cancellation);
            Assert.True(read.IsSuccess);
            Assert.Equal(petId, read.Value.PetId);
            Assert.Null(read.Value.Turn);
            Assert.True(read.Value.CanEdit);
            Assert.Equal(!unavailableSource, read.Value.CanSend);
            var messages = await service.Messages(importedId, null, 50, Cancellation);
            Assert.Collection(messages.Value.Items, message => Assert.Equal("Compare priorities", message.Text), message => Assert.Equal("Saved insight", message.Text));
            var restored = await work.Resolve<IItemTree>().FindAsync(ItemId.From(importedId), Cancellation);
            Assert.Contains("chat", restored!.Views!, StringComparison.Ordinal);
            if (unavailableSource)
            {
                var refused = await service.Begin(importedId, new(Guid.NewGuid(), "Do not reach inaccessible source"), Cancellation);
                Assert.Equal("conversations.sources_unavailable", refused.Error.Code);
            }
        }
        await using (var other = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation))
        {
            var denied = await other.Resolve<ConversationService>().Read(importedId, Cancellation);
            Assert.Equal("conversations.not_found", denied.Error.Code);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Native_configuration_cannot_turn_an_ordinary_item_into_a_chat_without_a_compatible_chat_view(bool compatibleSchema)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var config = new JsonObject
        {
            ["petId"] = Guid.NewGuid(),
            ["revision"] = 1,
            ["sourceWorkspaceIds"] = new JsonArray(JsonValue.Create(TestTenants.AlphaWorkspace))
        };
        var properties = new JsonObject { ["$chat_config"] = config.ToJsonString() };
        var schema = compatibleSchema ? PropertySchemaJson.Write(new PropertySchema
        {
            Inherit = true,
            Properties = [
            new("chat_role", "Role", PropertyType.Select, ["user", "assistant", "system"], false),
            new("chat_text", "Message", PropertyType.Text, [], false),
            new("chat_created_at", "Sent", PropertyType.Date, [], false),
            new("chat_author", "Author", PropertyType.Text, [], false)]
        }) : null;
        var (imports, operation, digest) = await CommitQueuedAsync(work, "nix", "crafted-chat.nix", 128, itemCount: 1);
        var ordinary = new ImportEnvelopePlan("ordinary", null, 0, "Ordinary note", "document", properties.ToJsonString(),
            schema, null, "active", false, null);
        Assert.Null(await imports.StageAsync(new(DocumentImportId.From(operation.Id), new string('b', 64), digest, [ordinary]), Cancellation));
    }

    [Fact]
    public async Task Finance_properties_cannot_enter_through_document_imports()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var (imports, operation, digest) = await CommitQueuedAsync(work, "nix", "finance.nix", 8, itemCount: 1);
        var note = new ImportEnvelopePlan("note", null, 0, "Finance injection", "note",
            "{\"$fin_kind\":\"transaction\",\"$fin_amount\":-100}", null, null, "active", false, null);
        Assert.Null(await imports.StageAsync(new StageDocumentImport(
            DocumentImportId.From(operation.Id), new string('b', 64), digest, [note]), Cancellation));
    }

    [Fact]
    public async Task An_imported_due_date_and_reminder_are_attributed_to_the_importer()
    {
        // H1a: a set-by value in an imported file names whoever the file's author chose; the
        // importing principal is the one who set every value that lands.
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var (imports, operation, digest) = await CommitQueuedAsync(work, "nix", "forged.nix", 8, itemCount: 1);
        var forged = TestTenants.BetaPrincipal.ToString();
        var note = new ImportEnvelopePlan("note", null, 0, "Imported task", "note",
            $$"""{"due_date":"2026-12-01","$due_set_by":"{{forged}}","reminder":"2026-12-01T09:00:00+00:00[Etc/UTC]","$reminder_set_by":"{{forged}}"}""",
            null, null, "active", false, null);
        var stage = Assert.IsType<DocumentImportStageRecord>(await imports.StageAsync(new StageDocumentImport(
            DocumentImportId.From(operation.Id), new string('b', 64), digest, [note]), Cancellation));

        var staged = await work.DbContext.Items.IgnoreQueryFilters().AsNoTracking()
            .SingleAsync(item => item.Id == ItemId.From(stage.RootItemId), Cancellation);
        var bag = Assert.IsType<System.Text.Json.Nodes.JsonObject>(System.Text.Json.Nodes.JsonNode.Parse(staged.Properties!));
        Assert.Equal(TestTenants.AlphaPrincipal.ToString(), (string?)bag[ItemProperties.DueSetByKey]);
        Assert.Equal(TestTenants.AlphaPrincipal.ToString(), (string?)bag[ItemProperties.ReminderSetByKey]);
    }

    [Fact]
    public async Task An_import_restores_note_comments_for_the_importer_without_queueing_notices()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var (imports, operation, digest) = await CommitQueuedAsync(work, "nix", "comments.nix", 8, itemCount: 1);
        var stamp = DateTimeOffset.Parse("2026-10-29T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var note = new ImportEnvelopePlan("note", null, 0, "Commented", "note", null, null, null, "active", false, null,
        [
            new(new string('q', 1500), true, [new("Ada", "Why?", stamp), new("Grace", "Because.", stamp.AddMinutes(1)), new("Nobody", "", stamp)]),
            new(null, false, [new(null, "Open question", null)]),
        ]);
        var stage = Assert.IsType<DocumentImportStageRecord>(await imports.StageAsync(new StageDocumentImport(
            DocumentImportId.From(operation.Id), new string('b', 64), digest, [note]), Cancellation));

        var rows = await work.DbContext.NoteComments.AsNoTracking()
            .Where(row => row.ItemId == ItemId.From(stage.RootItemId)).OrderBy(row => row.CreatedAt).ToListAsync(Cancellation);

        Assert.Equal(3, rows.Count);
        Assert.All(rows, row => Assert.Equal(TestTenants.AlphaPrincipal, row.AuthorPrincipalId.Value));
        Assert.Equal(["Ada", "Grace", "Unknown"], rows.Select(row => row.ImportedAuthor));
        var root = rows[0];
        Assert.Equal(root.Id, root.ThreadId);
        Assert.Equal(root.Id, rows[1].ThreadId);
        Assert.Equal(1000, root.Quote!.Length);
        Assert.Equal(stamp, root.CreatedAt);
        Assert.NotNull(root.ResolvedAt);
        Assert.Null(root.AnchorStart);
        Assert.Null(rows[2].ResolvedAt);
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(0, await RawSql.CountAsync(connection, null, "SELECT count(*) FROM scheduled_trigger WHERE source = 'note.comment'"));
        }
    }

    [Fact]
    public async Task An_import_with_more_comments_than_the_caps_allow_is_refused_and_a_cut_keeps_a_surrogate_pair_whole()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var (imports, operation, digest) = await CommitQueuedAsync(work, "nix", "caps.nix", 8, itemCount: 1);
        ImportEnvelopePlan Note(IReadOnlyList<ImportCommentThread> threads) =>
            new("note", null, 0, "Commented", "note", null, null, null, "active", false, null, threads);
        async Task<DocumentImportStageRecord?> Stage(IReadOnlyList<ImportCommentThread> threads) =>
            await imports.StageAsync(new StageDocumentImport(DocumentImportId.From(operation.Id), new string('b', 64), digest, [Note(threads)]), Cancellation);

        var tooManyThreads = Enumerable.Range(0, 501).Select(_ => new ImportCommentThread(null, false, [new("A", "x", null)])).ToList();
        Assert.Null(await Stage(tooManyThreads));
        var tooLong = new ImportCommentThread(null, false, [.. Enumerable.Range(0, 101).Select(_ => new ImportComment("A", "x", null))]);
        Assert.Null(await Stage([tooLong]));

        var pair = new string('q', 999) + "\U0001F600";
        var stage = Assert.IsType<DocumentImportStageRecord>(await Stage([new(pair, false, [new("A", "x", null)])]));
        var quote = (await work.DbContext.NoteComments.AsNoTracking().SingleAsync(row => row.ItemId == ItemId.From(stage.RootItemId), Cancellation)).Quote;
        Assert.Equal(new string('q', 999), quote);
    }

    [Fact]
    public async Task An_import_keeps_habit_content_and_drops_every_other_reserved_key()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var (imports, operation, digest) = await CommitQueuedAsync(work, "nix", "reserved.nix", 8, itemCount: 1);
        var note = new ImportEnvelopePlan("note", null, 0, "Imported note", "note",
            """{"$type":"task","$cal_link":"x","$custom":1,"$habit_unit":"times"}""",
            null, null, "active", false, null);
        var stage = Assert.IsType<DocumentImportStageRecord>(await imports.StageAsync(new StageDocumentImport(
            DocumentImportId.From(operation.Id), new string('b', 64), digest, [note]), Cancellation));

        var staged = await work.DbContext.Items.IgnoreQueryFilters().AsNoTracking()
            .SingleAsync(item => item.Id == ItemId.From(stage.RootItemId), Cancellation);
        var bag = Assert.IsType<System.Text.Json.Nodes.JsonObject>(System.Text.Json.Nodes.JsonNode.Parse(staged.Properties!));
        Assert.False(bag.ContainsKey("$type"));
        Assert.False(bag.ContainsKey("$cal_link"));
        Assert.False(bag.ContainsKey("$custom"));
        Assert.Equal("times", (string?)bag["$habit_unit"]);
    }

    [Theory]
    [InlineData("""{"$habit_frequency":"daily"}""")]
    [InlineData("""{"$habit_frequency":"daily","$habit_timezone":"UTC","$habit_start_date":"2026-01-01","$habit_target":1,"$habit_unit":"times","$habit_status_versions":[{"effectiveFrom":"2026-01-01","status":"forged"}]}""")]
    public async Task An_import_with_malformed_habit_settings_is_refused(string properties)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var (imports, operation, digest) = await CommitQueuedAsync(work, "nix", "habit.nix", 8, itemCount: 1);
        var note = new ImportEnvelopePlan("note", null, 0, "Broken habit", "note",
            properties, null, null, "active", false, null);

        Assert.Null(await imports.StageAsync(new StageDocumentImport(
            DocumentImportId.From(operation.Id), new string('b', 64), digest, [note]), Cancellation));
    }

    [Fact]
    public async Task A_planned_bag_naming_a_member_twice_is_refused_rather_than_failing_the_request()
    {
        // JsonNode.Parse accepts a duplicate member name and JsonObject throws on first use, so a
        // plan like this used to escape the title and set-by rewrites as an unhandled exception.
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var (imports, operation, digest) = await CommitQueuedAsync(work, "nix", "duplicated.nix", 8, itemCount: 1);
        var note = new ImportEnvelopePlan("note", null, 0, "Duplicated keys", "note",
            $$"""{"due_date":"2026-12-01","$due_set_by":"{{TestTenants.BetaPrincipal}}","$due_set_by":"{{TestTenants.AlphaPrincipal}}"}""",
            null, null, "active", false, null);

        Assert.Null(await imports.StageAsync(new StageDocumentImport(
            DocumentImportId.From(operation.Id), new string('b', 64), digest, [note]), Cancellation));
    }

    [Fact]
    public async Task Finalization_rechecks_finance_properties_on_legacy_staged_items()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var (imports, operation, digest) = await CommitQueuedAsync(work, "nix", "legacy.nix", 8, itemCount: 1);
        var note = new ImportEnvelopePlan("note", null, 0, "Legacy staged note", "note",
            null, null, null, "active", false, null);
        var stage = Assert.IsType<DocumentImportStageRecord>(await imports.StageAsync(new StageDocumentImport(
            DocumentImportId.From(operation.Id), new string('b', 64), digest, [note]), Cancellation));
        var targetId = ItemId.From(stage.RootItemId);
        await work.DbContext.Items.IgnoreQueryFilters().Where(item => item.Id == targetId)
            .ExecuteUpdateAsync(update => update.SetProperty(item => item.Properties,
                "{\"$title\":\"Legacy staged note\",\"$fin_kind\":\"transaction\"}"), Cancellation);
        Assert.Null(await imports.FinalizeAsync(DocumentImportId.From(operation.Id), Cancellation));
        Assert.False(await work.DbContext.Items.AnyAsync(item => item.Id == targetId, Cancellation));
    }

    [Fact]
    public async Task Large_object_cleanup_sets_use_bounded_idempotent_batches()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var ownerId = Guid.NewGuid();
        var keys = Enumerable.Range(0, 10_003)
            .Select(index => $"tenant/{TestTenants.Alpha:D}/file-version/{index:D5}")
            .ToArray();
        var excludedPublishedKey = "tenant/published-template/file-version/keep";
        var jobs = work.Resolve<IWorkerJobStore>();
        var queued = await ObjectCleanupJobs.QueueBatchedAsync(
            jobs, TestTenants.AlphaContext.TenantId, TestTenants.AlphaContext.PrincipalId,
            WorkspaceId.From(TestTenants.AlphaWorkspace), "template-delete", ownerId,
            DateTimeOffset.UtcNow, keys, Cancellation);

        Assert.Equal(2, queued.Count);
        var payloads = queued.Select(job => Assert.IsType<ObjectCleanupJobPayload>(JsonSerializer.Deserialize(
            job.Payload, ObjectCleanupJsonContext.Default.ObjectCleanupJobPayload))).ToArray();
        Assert.All(payloads, payload => Assert.InRange(payload.ObjectKeys.Count, 1, 10_002));
        var flattened = payloads.SelectMany(payload => payload.ObjectKeys).ToArray();
        Assert.Equal(keys.Order(StringComparer.Ordinal), flattened);
        Assert.DoesNotContain(excludedPublishedKey, flattened);

        var replay = await ObjectCleanupJobs.QueueBatchedAsync(
            jobs, TestTenants.AlphaContext.TenantId, TestTenants.AlphaContext.PrincipalId,
            WorkspaceId.From(TestTenants.AlphaWorkspace), "template-delete", ownerId,
            DateTimeOffset.UtcNow, keys, Cancellation);
        Assert.Equal(queued.Select(job => job.Id), replay.Select(job => job.Id));
    }

    [Fact]
    public async Task A_complete_txt_plan_publishes_the_note_and_retained_source_atomically()
    {
        DocumentImportRecord operation;
        DocumentImportStageRecord stage;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var prepared = await CommitQueuedAsync(work, "txt", "source.txt", 4);
            var imports = prepared.Store;
            operation = prepared.Operation;
            var root = new ImportEnvelopePlan(
                "root",
                ParentSourceId: null,
                Order: 0,
                "Imported note",
                "note",
                Properties: null,
                Schema: null,
                Views: null,
                FinalLifecycleState: "active",
                BodyRequired: true,
                File: null);
            var original = new ImportEnvelopePlan(
                "original",
                "root",
                Order: 0,
                "source.txt",
                "file",
                Properties: null,
                Schema: null,
                Views: null,
                FinalLifecycleState: "active",
                BodyRequired: false,
                new ImportFilePlan(
                    "source",
                    AssetPath: null,
                    "source.txt",
                    "text/plain",
                    4,
                    prepared.SourceDigest,
                    Previewable: false,
                    PixelWidth: null,
                    PixelHeight: null));

            stage = Assert.IsType<DocumentImportStageRecord>(await imports.StageAsync(
                new StageDocumentImport(
                    DocumentImportId.From(operation.Id),
                    new string('b', 64),
                    prepared.SourceDigest,
                    [root, original]),
                Cancellation));

            Assert.False(await work.DbContext.Items.AnyAsync(
                item => item.Id == ItemId.From(stage.RootItemId),
                Cancellation));
            Assert.Equal(2, await work.DbContext.Items.IgnoreQueryFilters().CountAsync(
                item => stage.Items.Select(mapping => ItemId.From(mapping.TargetItemId)).Contains(item.Id),
                Cancellation));
            Assert.Null(await imports.FinalizeAsync(DocumentImportId.From(operation.Id), Cancellation));
            Assert.True(await imports.MarkObjectReadyAsync(
                DocumentImportId.From(operation.Id),
                "original",
                4,
                prepared.SourceDigest,
                Cancellation));
            await work.CommitAsync(Cancellation);
        }

        await WriteCollaborationBodyAsync(stage.RootItemId);

        await using (var publish = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var completed = Assert.IsType<DocumentImportRecord>(await publish.Resolve<IDocumentImportStore>().FinalizeAsync(
                DocumentImportId.From(operation.Id),
                Cancellation));

            Assert.Equal(DocumentImportStatuses.Completed, completed.Status);
            Assert.Equal(stage.RootItemId, completed.RootItemId);
            Assert.Equal(2, await publish.DbContext.Items.CountAsync(
                item => stage.Items.Select(mapping => ItemId.From(mapping.TargetItemId)).Contains(item.Id),
                Cancellation));
            var importedItemIds = stage.Items
                .Select(mapping => ItemId.From(mapping.TargetItemId))
                .ToArray();
            var indexEvents = await publish.DbContext.WorkerOutboxEvents
                .Where(value => value.ItemId != null && importedItemIds.Contains(value.ItemId.Value))
                .Select(value => new { value.ItemId, value.Kind })
                .ToListAsync(Cancellation);

            Assert.Equal(2, indexEvents.Count);
            Assert.All(indexEvents, value => Assert.Equal("item.changed", value.Kind));
            Assert.Single(indexEvents, value => value.ItemId == ItemId.From(stage.RootItemId));
            var sourceItemId = ItemId.From(stage.Items.Single(mapping => mapping.SourceId == "original").TargetItemId);
            Assert.Single(indexEvents, value => value.ItemId == sourceItemId);
        }
    }

    [Fact]
    public async Task Archive_file_history_stages_fresh_versions_and_completes_in_fenced_pages()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var (imports, operation, digest) = await CommitQueuedAsync(work, "nix", "history.nix", 8);
        var note = new ImportEnvelopePlan("note", null, 0, "History", "note", null, null, null,
            "active", true, null);
        var file = new ImportEnvelopePlan("asset", "note", 0, "asset.bin", "file", null, null, null,
            "active", false, null);
        var histories = new[]
        {
            new ImportFileVersionPlan("asset", 1, "asset.bin", "application/octet-stream", 4,
                new string('c', 64), false, null, null),
            new ImportFileVersionPlan("asset", 2, "asset.bin", "application/octet-stream", 7,
                new string('d', 64), false, null, null),
        };
        var stage = Assert.IsType<DocumentImportStageRecord>(await imports.StageAsync(
            new StageDocumentImport(DocumentImportId.From(operation.Id), new string('b', 64), digest,
                [note, file], histories), Cancellation));
        Assert.Collection(stage.FileVersions!,
            first => Assert.Equal(1, first.TargetVersion),
            second => Assert.Equal(2, second.TargetVersion));
        var originalFileTarget = stage.Items.Single(value => value.SourceId == "asset").TargetItemId;
        var currentBody = await work.DbContext.FileBodies.IgnoreQueryFilters().SingleAsync(
            value => value.ItemId == ItemId.From(originalFileTarget), Cancellation);
        var current = await work.DbContext.FileVersions.IgnoreQueryFilters().SingleAsync(
            value => value.Id == currentBody.CurrentVersionId, Cancellation);
        Assert.Equal(2, current.Version);
        Assert.False(current.ObjectReady);
        Assert.Null(await imports.FinalizeAsync(DocumentImportId.From(operation.Id), Cancellation));

        var executionId = Guid.NewGuid().ToString("D");
        var firstPage = Assert.IsType<DocumentImportFileVersionsPage>(await imports.AuthorizeFileVersionsAsync(
            DocumentImportId.From(operation.Id), executionId, null, 1, Cancellation));
        Assert.Single(firstPage.Files);
        Assert.False(firstPage.Complete);
        Assert.True(await imports.CompleteFileVersionsAsync(DocumentImportId.From(operation.Id), executionId,
            [firstPage.Files[0].TransferId], Cancellation));
        var secondPage = Assert.IsType<DocumentImportFileVersionsPage>(await imports.AuthorizeFileVersionsAsync(
            DocumentImportId.From(operation.Id), executionId, firstPage.NextAfterTransferId, 1, Cancellation));
        Assert.Single(secondPage.Files);
        Assert.True(secondPage.Complete);
        Assert.True(await imports.CompleteFileVersionsAsync(DocumentImportId.From(operation.Id), executionId,
            [secondPage.Files[0].TransferId], Cancellation));
        Assert.True(await work.DbContext.FileVersions.AsNoTracking().AnyAsync(
            value => value.Id == current.Id && value.ObjectReady, Cancellation));
        Assert.Equal(2, await work.DbContext.FileVersions.AsNoTracking().CountAsync(
            value => value.ItemId == ItemId.From(originalFileTarget) && value.ObjectReady, Cancellation));
    }

    [Fact]
    public async Task Archive_file_history_stage_replay_returns_existing_mappings_across_unit_of_work()
    {
        DocumentImportRecord operation;
        StageDocumentImport request;
        DocumentImportStageRecord original;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var prepared = await CommitQueuedAsync(work, "nix", "replay-history.nix", 8);
            operation = prepared.Operation;
            var note = new ImportEnvelopePlan("note", null, 0, "History", "note", null, null, null,
                "active", true, null);
            var file = new ImportEnvelopePlan("asset", "note", 0, "asset.bin", "file", null, null, null,
                "active", false, null);
            var histories = new[]
            {
                new ImportFileVersionPlan("asset", 1, "asset.bin", "application/octet-stream", 4,
                    new string('c', 64), false, null, null),
                new ImportFileVersionPlan("asset", 2, "asset.bin", "application/octet-stream", 7,
                    new string('d', 64), false, null, null),
            };
            request = new StageDocumentImport(DocumentImportId.From(operation.Id), new string('b', 64),
                prepared.SourceDigest, [note, file], histories);
            original = Assert.IsType<DocumentImportStageRecord>(await prepared.Store.StageAsync(request, Cancellation));
            Assert.Collection(original.FileVersions!,
                first => Assert.Equal(1, first.TargetVersion),
                second => Assert.Equal(2, second.TargetVersion));
            await work.CommitAsync(Cancellation);
        }

        await using var replayWork = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var replay = Assert.IsType<DocumentImportStageRecord>(await replayWork.Resolve<IDocumentImportStore>()
            .StageAsync(request, Cancellation));
        Assert.Equal(original.Items.OrderBy(value => value.SourceId), replay.Items.OrderBy(value => value.SourceId));
        Assert.Equal(original.FileVersions!.OrderBy(value => value.TransferId),
            replay.FileVersions!.OrderBy(value => value.TransferId));
        var fileTargetId = ItemId.From(original.Items.Single(value => value.SourceId == "asset").TargetItemId);
        Assert.Equal(2, await replayWork.DbContext.FileVersions.CountAsync(value => value.ItemId == fileTargetId, Cancellation));
        Assert.Equal(2, await replayWork.DbContext.DocumentImportFileVersions.CountAsync(
            value => value.ImportId == DocumentImportId.From(operation.Id), Cancellation));
    }

    [Fact]
    public async Task A_plan_cannot_substitute_or_omit_the_declared_source_file()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var (imports, operation, digest) = await CommitQueuedAsync(work, "txt", "source.txt", 4);
        var root = new ImportEnvelopePlan(
            "root", null, 0, "Imported", "note", null, null, null, "active", BodyRequired: true, File: null);
        var substituted = new ImportEnvelopePlan(
            "original", "root", 0, "other.txt", "file", null, null, null, "active", BodyRequired: false,
            new ImportFilePlan("source", null, "other.txt", "text/plain", 4, digest, false, null, null));

        Assert.Null(await imports.StageAsync(
            new StageDocumentImport(
                DocumentImportId.From(operation.Id),
                new string('b', 64),
                digest,
                [root]),
            Cancellation));
        Assert.Null(await imports.StageAsync(
            new StageDocumentImport(
                DocumentImportId.From(operation.Id),
                new string('b', 64),
                digest,
                [root, substituted]),
            Cancellation));
        Assert.False(await work.DbContext.Items.IgnoreQueryFilters().AnyAsync(
            item => item.LifecycleState == ItemLifecycleState.Provisioning,
            Cancellation));
    }

    [Fact]
    public async Task A_failed_commit_removes_every_staged_envelope_and_file_version()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var (imports, operation, digest) = await CommitQueuedAsync(work, "txt", "source.txt", 4);
        var root = new ImportEnvelopePlan(
            "root", null, 0, "Imported", "note", null, null, null, "active", BodyRequired: true, File: null);
        var original = new ImportEnvelopePlan(
            "original", "root", 0, "source.txt", "file", null, null, null, "active", BodyRequired: false,
            new ImportFilePlan("source", null, "source.txt", "text/plain", 4, digest, false, null, null));
        var stage = Assert.IsType<DocumentImportStageRecord>(await imports.StageAsync(
            new StageDocumentImport(
                DocumentImportId.From(operation.Id),
                new string('b', 64),
                digest,
                [root, original]),
            Cancellation));

        var cleanup = Assert.IsType<DocumentImportCleanupRecord>(await imports.FailAsync(
            DocumentImportId.From(operation.Id),
            "import_body_invalid",
            Cancellation));
        Assert.Contains(cleanup.ObjectKeys, key => key.Contains("files/versions/", StringComparison.Ordinal));

        var targetIds = stage.Items.Select(mapping => ItemId.From(mapping.TargetItemId)).ToArray();
        Assert.False(await work.DbContext.Items.IgnoreQueryFilters().AnyAsync(
            item => targetIds.Contains(item.Id),
            Cancellation));
        Assert.False(await work.DbContext.FileVersions.AnyAsync(
            version => targetIds.Contains(version.ItemId),
            Cancellation));
    }

    [Fact]
    public async Task An_expired_staged_import_is_removed_and_every_object_is_queued_for_cleanup()
    {
        Guid importId;
        Guid[] targetIds;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation))
        {
            var (imports, operation, digest) = await CommitQueuedAsync(
                work,
                "txt",
                "expired.txt",
                4);
            var root = new ImportEnvelopePlan(
                "root", null, 0, "Expired", "note", null, null, null, "active", true, null);
            var source = new ImportEnvelopePlan(
                "source", "root", 0, "expired.txt", "file", null, null, null, "active", false,
                new ImportFilePlan("source", null, "expired.txt", "text/plain", 4, digest, false, null, null));
            var stage = Assert.IsType<DocumentImportStageRecord>(await imports.StageAsync(
                new StageDocumentImport(DocumentImportId.From(operation.Id), new string('b', 64), digest, [root, source]),
                Cancellation));
            importId = operation.Id;
            targetIds = stage.Items.Select(value => value.TargetItemId).ToArray();
            await work.CommitAsync(Cancellation);
        }

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(
                "UPDATE document_import SET expires_at = now() - interval '1 minute' WHERE import_id = @import_id",
                connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddWithValue("import_id", importId);
                await command.ExecuteNonQueryAsync(Cancellation);
            }
        }

        await using (var scope = fixture.Application.CreateUnscopedScope())
        {
            Assert.Equal(1, await scope.ServiceProvider
                .GetRequiredService<AbandonedObjectReaper>()
                .ReapOnceAsync(Cancellation));
        }

        await using var verify = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var operationRecord = Assert.IsType<DocumentImportRecord>(await verify
            .Resolve<IDocumentImportStore>()
            .GetAsync(DocumentImportId.From(importId), Cancellation));
        Assert.Equal(DocumentImportStatuses.Failed, operationRecord.Status);
        Assert.Equal("import_expired", operationRecord.FailureCode);
        Assert.False(await verify.DbContext.Items.IgnoreQueryFilters()
            .AnyAsync(value => targetIds.Select(ItemId.From).Contains(value.Id), Cancellation));
        var cleanupJob = await verify.DbContext.WorkerJobs.SingleAsync(
            job => job.Kind == "object.cleanup"
                && job.IdempotencyKey == $"object.cleanup:document-import:{importId:D}",
            Cancellation);
        using var payload = JsonDocument.Parse(cleanupJob.Payload);
        var keys = payload.RootElement.GetProperty("objectKeys")
            .EnumerateArray()
            .Select(value => value.GetString())
            .ToArray();
        Assert.Equal(3, keys.Length);
        Assert.Contains(keys, key => key is not null && key.StartsWith("files/uploads/", StringComparison.Ordinal));
        Assert.Contains(keys, key => key is not null && key.StartsWith("files/versions/", StringComparison.Ordinal));
        Assert.Contains(keys, key => key is not null && key.StartsWith("imports/plans/", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Cancellation_and_finalization_never_publish_a_partial_subtree()
    {
        DocumentImportStageRecord stage;
        Guid importId;
        await using (var prepare = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation))
        {
            var (imports, operation, digest) = await CommitQueuedAsync(prepare, "markdown", "race.md", 4);
            var root = new ImportEnvelopePlan(
                "root", null, 0, "Race", "note", null, null, null, "active", true, null);
            var child = new ImportEnvelopePlan(
                "child", "root", 0, "Child", "note", null, null, null, "active", false, null);
            stage = Assert.IsType<DocumentImportStageRecord>(await imports.StageAsync(
                new StageDocumentImport(DocumentImportId.From(operation.Id), new string('b', 64), digest, [root, child]),
                Cancellation));
            importId = operation.Id;
            await prepare.CommitAsync(Cancellation);
        }
        await WriteCollaborationBodyAsync(stage.RootItemId);

        async Task<DocumentImportRecord?> FinalizeAsync()
        {
            await using var work = await fixture.Application.BeginUnitOfWorkAsync(
                TestTenants.AlphaContext,
                Cancellation);
            var result = await work.Resolve<IDocumentImportStore>()
                .FinalizeAsync(DocumentImportId.From(importId), Cancellation);
            await work.CommitAsync(Cancellation);
            return result;
        }

        async Task<DocumentImportCleanupRecord?> CancelAsync()
        {
            await using var work = await fixture.Application.BeginUnitOfWorkAsync(
                TestTenants.AlphaContext,
                Cancellation);
            var result = await work.Resolve<IDocumentImportStore>()
                .CancelAsync(DocumentImportId.From(importId), Cancellation);
            await work.CommitAsync(Cancellation);
            return result;
        }

        var finalizeTask = FinalizeAsync();
        var cancelTask = CancelAsync();
        await Task.WhenAll(finalizeTask, cancelTask);
        var finalized = await finalizeTask;
        var cancelled = await cancelTask;
        await using var verify = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var verifiedOperation = Assert.IsType<DocumentImportRecord>(await verify.Resolve<IDocumentImportStore>()
            .GetAsync(DocumentImportId.From(importId), Cancellation));
        var persistedTargets = await verify.DbContext.Items.IgnoreQueryFilters().CountAsync(
            value => stage.Items.Select(mapping => ItemId.From(mapping.TargetItemId)).Contains(value.Id),
            Cancellation);
        if (verifiedOperation.Status == DocumentImportStatuses.Completed)
        {
            Assert.NotNull(finalized);
            Assert.Null(cancelled);
            Assert.Equal(stage.Items.Count, persistedTargets);
        }
        else
        {
            Assert.Equal(DocumentImportStatuses.Cancelled, verifiedOperation.Status);
            Assert.Null(finalized);
            Assert.NotNull(cancelled);
            Assert.Equal(0, persistedTargets);
        }
    }

    [Fact]
    public async Task A_template_attempt_tracks_its_hidden_stage_until_the_catalog_is_published()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var files = work.Resolve<IFileStore>();
        var imports = work.Resolve<IDocumentImportStore>();
        var jobs = work.Resolve<IWorkerJobStore>();
        var templates = work.Resolve<ITemplateStagingStore>();
        var templateCatalog = work.Resolve<ITemplateCatalogStore>();
        var digest = new string('a', 64);
        var upload = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
            new BeginFileUpload(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ParentId: null,
                TargetItemId: null,
                "portable.nix",
                "application/zip",
                128,
                "template-archive-attempt",
                FileUploadPurposes.TemplateImport),
            Cancellation));
        var attempt = Assert.IsType<DocumentImportRecord>(await imports.BeginAsync(
            new BeginDocumentImport(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ParentId: null,
                FileUploadId.From(upload.Id),
                "nix",
                "portable.nix",
                "template-archive-attempt",
                DocumentImportPurposes.TemplateUser),
            Cancellation));
        var previewJob = await jobs.CreateAsync(
            TenantId.From(M0SchemaSeed.Alpha.TenantId),
            Nix.Domain.Identity.PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId),
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            "template.preview",
            "template-preview-attempt",
            "{}",
            Cancellation);
        Assert.NotNull(await imports.AttachPreviewJobAsync(
            DocumentImportId.From(attempt.Id),
            Nix.Domain.Workers.WorkerJobId.From(previewJob.Id),
            Cancellation));
        Assert.NotNull(await imports.CompletePreviewAsync(
            new CompleteDocumentImportPreview(
                DocumentImportId.From(attempt.Id),
                new string('b', 64),
                PlanByteLength: 256,
                digest,
                ItemCount: 1,
                AssetCount: 0,
                "[]",
                "[]",
                "{\"profile\":{\"kind\":\"template\"}}"),
            Cancellation));
        var commitJob = await jobs.CreateAsync(
            TenantId.From(M0SchemaSeed.Alpha.TenantId),
            Nix.Domain.Identity.PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId),
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            "template.commit",
            "template-commit-attempt",
            "{}",
            Cancellation);
        Assert.NotNull(await imports.AttachCommitJobAsync(
            DocumentImportId.From(attempt.Id),
            Nix.Domain.Workers.WorkerJobId.From(commitJob.Id),
            Cancellation));

        var sourceId = Guid.NewGuid();
        var sourceFileId = Guid.NewGuid();
        var stagedResult = await templates.BeginImportAsync(
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            "template-archive-attempt",
            new TemplateImportDescriptor(
                "portable-template",
                "Portable template",
                null,
                TemplateOrigin.User,
                null,
                digest,
                IncludeBody: false,
                IncludeChildren: false),
            [
                new TemplateImportItem(sourceId, null, "note", "Portable template", 1024, null, null, null, false),
                new TemplateImportItem(sourceFileId, sourceId, "file", "Attachment", 1, null, null, null, false),
            ],
            Cancellation);
        Assert.True(stagedResult.IsSuccess, stagedResult.Error.Message);
        var staged = stagedResult.Value;
        var stagingAttempt = Assert.IsType<DocumentImportRecord>(await imports.AttachTemplateStageAsync(
            new AttachTemplateImportStage(
                DocumentImportId.From(attempt.Id),
                staged.OperationId,
                staged.TemplateId,
                "portable-template",
                digest,
                staged.Unchanged),
            Cancellation));
        Assert.Equal(DocumentImportStatuses.Staging, stagingAttempt.Status);
        Assert.Equal(staged.OperationId?.Value, stagingAttempt.TemplateOperationId);

        var filePlan = new ImportFileVersionPlan(sourceFileId.ToString("D"), 1, "attachment.bin",
            "application/octet-stream", 8, new string('c', 64), false, null, null);
        var targetPairs = staged.ItemMappings.Select(mapping =>
            (mapping.SourceId.ToString("D"), mapping.ItemId)).ToArray();
        var fileMappings = Assert.IsAssignableFrom<IReadOnlyList<DocumentImportFileVersionMapping>>(
            await imports.StageTemplateFileVersionsAsync(DocumentImportId.From(attempt.Id),
                [filePlan], targetPairs, Cancellation));
        await work.CommitAsync(Cancellation);

        await using var replayWork = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext, Cancellation);
        var replayImports = replayWork.Resolve<IDocumentImportStore>();
        var replayTemplates = replayWork.Resolve<ITemplateStagingStore>();
        var replayCatalog = replayWork.Resolve<ITemplateCatalogStore>();
        var replayedFileMappings = Assert.IsAssignableFrom<IReadOnlyList<DocumentImportFileVersionMapping>>(
            await replayImports.StageTemplateFileVersionsAsync(DocumentImportId.From(attempt.Id),
                [filePlan], targetPairs, Cancellation));
        Assert.Equal(fileMappings, replayedFileMappings);
        var authorization = Assert.IsType<DocumentImportFileVersionsPage>(await replayImports.AuthorizeFileVersionsAsync(
            DocumentImportId.From(attempt.Id), "template-commit-attempt", null, 100, Cancellation));
        Assert.Single(authorization.Files);
        Assert.False(authorization.Files[0].ObjectReady);
        Assert.True(await replayImports.CompleteFileVersionsAsync(DocumentImportId.From(attempt.Id),
            "template-commit-attempt", [authorization.Files[0].TransferId], Cancellation));
        Assert.True(await replayWork.DbContext.FileVersions.AsNoTracking().AnyAsync(
            version => version.ItemId == ItemId.From(fileMappings[0].TargetItemId) && version.ObjectReady,
            Cancellation));

        if (staged.OperationId is { } operationId)
        {
            var finalized = await replayTemplates.FinalizeOperationAsync(operationId, [], Cancellation);
            Assert.True(finalized.IsSuccess, finalized.Error.Message);
        }
        var completed = Assert.IsType<DocumentImportRecord>(await replayImports.CompleteTemplateAsync(
            new CompleteTemplateImport(DocumentImportId.From(attempt.Id), [], Managed: false),
            Cancellation));
        Assert.Equal(DocumentImportStatuses.Completed, completed.Status);
        Assert.Equal(staged.TemplateId.Value, completed.TemplateId);
        Assert.Equal("portable-template", completed.TemplateStableKey);
        Assert.Equal(digest, completed.TemplateDigest);
        Assert.Equal("[]", completed.TemplateWrittenTargetItemIds);

        var deleted = await replayCatalog.DeleteAsync(staged.TemplateId, Cancellation);
        Assert.True(deleted.IsSuccess, deleted.Error.Message);
        Assert.False(await replayWork.DbContext.WorkspaceTemplates.AnyAsync(
            template => template.Id == staged.TemplateId,
            Cancellation));
        var retainedHistory = Assert.IsType<DocumentImportRecord>(await replayImports.GetAsync(
            DocumentImportId.From(attempt.Id),
            Cancellation));
        Assert.Equal(staged.TemplateId.Value, retainedHistory.TemplateId);
    }

    [Fact]
    public async Task Expiry_reaps_a_linked_template_stage_even_after_the_actor_is_suspended()
    {
        DocumentImportRecord attempt;
        TemplateImportPlan stage;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation))
        {
            (attempt, stage) = await PrepareTemplateStageAsync(work, "expired-template-stage");
            await work.CommitAsync(Cancellation);
        }

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(
                """
                UPDATE document_import
                   SET expires_at = now() - interval '1 minute'
                 WHERE import_id = @import_id;
                UPDATE principal
                   SET status = 'suspended'
                 WHERE tenant_id = @tenant_id
                   AND principal_id = @principal_id;
                """,
                connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddWithValue("import_id", attempt.Id);
                command.Parameters.AddWithValue("tenant_id", M0SchemaSeed.Alpha.TenantId);
                command.Parameters.AddWithValue("principal_id", M0SchemaSeed.Alpha.PrincipalId);
                await command.ExecuteNonQueryAsync(Cancellation);
            }
        }

        await using (var scope = fixture.Application.CreateUnscopedScope())
        {
            Assert.Equal(1, await scope.ServiceProvider
                .GetRequiredService<AbandonedObjectReaper>()
                .ReapOnceAsync(Cancellation));
        }

        await using var verify = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var durable = Assert.IsType<DocumentImportRecord>(await verify.Resolve<IDocumentImportStore>()
            .GetAsync(DocumentImportId.From(attempt.Id), Cancellation));
        Assert.Equal(DocumentImportStatuses.Failed, durable.Status);
        Assert.Equal("import_expired", durable.FailureCode);
        Assert.False(await verify.DbContext.TemplateOperations.AnyAsync(
            value => value.Id == stage.OperationId,
            Cancellation));
        var targets = stage.ItemMappings.Select(value => value.ItemId).ToArray();
        Assert.False(await verify.DbContext.Items.IgnoreQueryFilters().AnyAsync(
            value => targets.Contains(value.Id),
            Cancellation));
        Assert.False(await verify.DbContext.WorkspaceTemplates.AnyAsync(
            value => value.Id == stage.TemplateId,
            Cancellation));
        Assert.Single(await verify.DbContext.WorkerJobs.Where(
            job => job.Kind == "object.cleanup"
                && job.IdempotencyKey == $"object.cleanup:document-import:{attempt.Id:D}")
            .ToListAsync(Cancellation));
    }

    [Fact]
    public async Task Import_operations_never_cross_tenants()
    {
        Guid betaImportId;
        await using (var beta = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation))
        {
            var upload = Assert.IsType<FileUploadRecord>(await beta.Resolve<IFileStore>().BeginAsync(
                new BeginFileUpload(
                    WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId),
                    ParentId: null,
                    TargetItemId: null,
                    "source.txt",
                    "text/plain",
                    4,
                    "beta-import",
                    FileUploadPurposes.DocumentImport),
                Cancellation));
            var operation = Assert.IsType<DocumentImportRecord>(await beta.Resolve<IDocumentImportStore>().BeginAsync(
                new BeginDocumentImport(
                    WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId),
                    ParentId: null,
                    FileUploadId.From(upload.Id),
                    "txt",
                    "Beta import",
                    "beta-import"),
                Cancellation));
            betaImportId = operation.Id;
            await beta.CommitAsync(Cancellation);
        }

        await using var alpha = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        Assert.Null(await alpha.Resolve<IDocumentImportStore>().GetAsync(
            DocumentImportId.From(betaImportId),
            Cancellation));
    }

    private static async Task<(IDocumentImportStore Store, DocumentImportRecord Operation, string SourceDigest)> CommitQueuedAsync(
        NixUnitOfWork work,
        string format,
        string fileName,
        long bytes,
        int itemCount = 2)
    {
        var files = work.Resolve<IFileStore>();
        var imports = work.Resolve<IDocumentImportStore>();
        var jobs = work.Resolve<IWorkerJobStore>();
        var digest = new string('a', 64);
        var upload = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
            new BeginFileUpload(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ParentId: null,
                TargetItemId: null,
                fileName,
                "text/plain",
                bytes,
                $"{format}-document-import",
                FileUploadPurposes.DocumentImport),
            Cancellation));
        var operation = Assert.IsType<DocumentImportRecord>(await imports.BeginAsync(
            new BeginDocumentImport(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ParentId: null,
                FileUploadId.From(upload.Id),
                format,
                "Imported note",
                $"{format}-document-import"),
            Cancellation));
        var previewJob = await jobs.CreateAsync(
            TenantId.From(M0SchemaSeed.Alpha.TenantId),
            Nix.Domain.Identity.PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId),
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            $"import.preview.{format}",
            $"preview-{format}",
            "{}",
            Cancellation);
        Assert.NotNull(await imports.AttachPreviewJobAsync(
            DocumentImportId.From(operation.Id),
            Nix.Domain.Workers.WorkerJobId.From(previewJob.Id),
            Cancellation));
        Assert.NotNull(await imports.CompletePreviewAsync(
            new CompleteDocumentImportPreview(
                DocumentImportId.From(operation.Id),
                new string('b', 64),
                PlanByteLength: 100,
                digest,
                ItemCount: itemCount,
                AssetCount: 0,
                "[]",
                "[]"),
            Cancellation));
        var commitJob = await jobs.CreateAsync(
            TenantId.From(M0SchemaSeed.Alpha.TenantId),
            Nix.Domain.Identity.PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId),
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            "import.commit",
            $"commit-{format}",
            "{}",
            Cancellation);
        operation = Assert.IsType<DocumentImportRecord>(await imports.AttachCommitJobAsync(
            DocumentImportId.From(operation.Id),
            Nix.Domain.Workers.WorkerJobId.From(commitJob.Id),
            Cancellation));
        return (imports, operation, digest);
    }

    private static async Task<(DocumentImportRecord Attempt, TemplateImportPlan Stage)> PrepareTemplateStageAsync(
        NixUnitOfWork work,
        string idempotencyKey)
    {
        var files = work.Resolve<IFileStore>();
        var imports = work.Resolve<IDocumentImportStore>();
        var jobs = work.Resolve<IWorkerJobStore>();
        var templates = work.Resolve<ITemplateStagingStore>();
        var digest = new string('a', 64);
        var upload = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
            new BeginFileUpload(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ParentId: null,
                TargetItemId: null,
                "expired.nix",
                "application/zip",
                128,
                idempotencyKey,
                FileUploadPurposes.TemplateImport),
            Cancellation));
        var attempt = Assert.IsType<DocumentImportRecord>(await imports.BeginAsync(
            new BeginDocumentImport(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ParentId: null,
                FileUploadId.From(upload.Id),
                "nix",
                "expired.nix",
                idempotencyKey,
                DocumentImportPurposes.TemplateUser),
            Cancellation));
        var preview = await jobs.CreateAsync(
            TenantId.From(M0SchemaSeed.Alpha.TenantId),
            Nix.Domain.Identity.PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId),
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            "template.preview",
            $"{idempotencyKey}:preview",
            "{}",
            Cancellation);
        Assert.NotNull(await imports.AttachPreviewJobAsync(
            DocumentImportId.From(attempt.Id),
            Nix.Domain.Workers.WorkerJobId.From(preview.Id),
            Cancellation));
        Assert.NotNull(await imports.CompletePreviewAsync(
            new CompleteDocumentImportPreview(
                DocumentImportId.From(attempt.Id),
                new string('b', 64),
                PlanByteLength: 256,
                digest,
                ItemCount: 1,
                AssetCount: 0,
                "[]",
                "[]",
                "{\"profile\":{\"kind\":\"template\"}}"),
            Cancellation));
        var commit = await jobs.CreateAsync(
            TenantId.From(M0SchemaSeed.Alpha.TenantId),
            Nix.Domain.Identity.PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId),
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            "template.commit",
            $"{idempotencyKey}:commit",
            "{}",
            Cancellation);
        Assert.NotNull(await imports.AttachCommitJobAsync(
            DocumentImportId.From(attempt.Id),
            Nix.Domain.Workers.WorkerJobId.From(commit.Id),
            Cancellation));
        var sourceId = Guid.NewGuid();
        var staged = await templates.BeginImportAsync(
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            idempotencyKey,
            new TemplateImportDescriptor(
                idempotencyKey,
                "Expired template",
                null,
                TemplateOrigin.User,
                null,
                digest,
                IncludeBody: false,
                IncludeChildren: false),
            [new TemplateImportItem(sourceId, null, "note", "Expired", 1024, null, null, null, false)],
            Cancellation);
        Assert.True(staged.IsSuccess, staged.Error.Message);
        attempt = Assert.IsType<DocumentImportRecord>(await imports.AttachTemplateStageAsync(
            new AttachTemplateImportStage(
                DocumentImportId.From(attempt.Id),
                staged.Value.OperationId,
                staged.Value.TemplateId,
                idempotencyKey,
                digest,
                staged.Value.Unchanged),
            Cancellation));
        return (attempt, staged.Value);
    }

    private async Task WriteCollaborationBodyAsync(Guid itemId)
    {
        var connectionString = new NpgsqlConnectionStringBuilder(fixture.ApplicationConnectionString)
        {
            Username = NixDatabaseRoles.Collaboration,
            Password = NixDatabaseRoles.Password,
        }.ConnectionString;
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(Cancellation);
        await using var transaction = await connection.BeginTransactionAsync(Cancellation);
        var command = new NpgsqlCommand(
            """
            SELECT set_config('nix.tenant_id', @tenant_id::text, true),
                   set_config('nix.principal_id', @principal_id::text, true);
            INSERT INTO content_doc
                (doc_id, tenant_id, item_id, workspace_id, schema_version, head_seq, created_at)
            VALUES (@doc_id, @tenant_id, @item_id, @workspace_id, 2, 1, now());
            """,
            connection,
            transaction);
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.AddWithValue("doc_id", Guid.NewGuid());
            command.Parameters.AddWithValue("tenant_id", M0SchemaSeed.Alpha.TenantId);
            command.Parameters.AddWithValue("principal_id", M0SchemaSeed.Alpha.PrincipalId);
            command.Parameters.AddWithValue("item_id", itemId);
            command.Parameters.AddWithValue("workspace_id", M0SchemaSeed.Alpha.WorkspaceId);
            await command.ExecuteNonQueryAsync(Cancellation);
        }
        await transaction.CommitAsync(Cancellation);
    }
}
