using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Comments;
using Nix.Features.Items;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence;
using Nix.Persistence.Workspaces;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Per-item settings against real Postgres: everything starts off, who may change an item's
/// settings and the workspace defaults, the defaults new items take, and comments refused while off.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class ItemSettingsTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly Guid Viewer = new("5e771195-4444-4444-8444-000000000011");
    private static readonly Guid Editor = new("5e771195-4444-4444-8444-000000000012");
    private static readonly WorkspaceId Workspace = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static NixSessionContext As(Guid principal) =>
        TestTenants.ContextFor(M0SchemaSeed.Alpha.TenantId, M0SchemaSeed.Alpha.WorkspaceId, principal);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var granter = Literal(M0SchemaSeed.Alpha.PrincipalId);
        await RunAsync($"""
            INSERT INTO principal (principal_id, tenant_id, external_subject, kind, display_name, email, status, deprovisioned_at)
            VALUES
                ({Literal(Viewer)}, {tenant}, 's-viewer', 'user', 'Viewer', 'viewer@example.test', 'active', NULL),
                ({Literal(Editor)}, {tenant}, 's-editor', 'user', 'Editor', 'editor@example.test', 'active', NULL);
            INSERT INTO workspace_member (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES
                ({Literal(Workspace.Value)}, 'principal', {Literal(Viewer)}, {tenant}, 'viewer', {granter}, now()),
                ({Literal(Workspace.Value)}, 'principal', {Literal(Editor)}, {tenant}, 'editor', {granter}, now());
            """);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_new_item_starts_with_everything_off()
    {
        var note = await CreateNoteAsync(M0SchemaSeed.Alpha.PrincipalId);

        Assert.Equal(new ItemSettings(), ItemSettings.Read(note.Settings));
    }

    [Fact]
    public async Task An_editor_changes_only_the_switches_named_and_a_viewer_cannot()
    {
        var note = await CreateNoteAsync(M0SchemaSeed.Alpha.PrincipalId);

        Assert.Equal("items.not_found", (await SetAsync(Viewer, note.Id, comments: true)).Error.Code);

        await SetAsync(Editor, note.Id, comments: true);
        var after = await SetAsync(Editor, note.Id, fullWidth: true);

        Assert.Equal(new ItemSettings(Comments: true, FullWidth: true), ItemSettings.Read(after.Value.Settings));

        var off = await SetAsync(Editor, note.Id, comments: false);
        Assert.Equal(new ItemSettings(FullWidth: true), ItemSettings.Read(off.Value.Settings));
    }

    [Fact]
    public async Task A_reviewed_item_row_revision_changes_when_the_item_settings_change()
    {
        var owner = M0SchemaSeed.Alpha.PrincipalId;
        var item = await CreateNoteAsync(owner);
        long? reviewed;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(As(owner), Cancellation))
        {
            reviewed = await work.Resolve<IItemTree>().ReadPetRevisionAsync(Workspace, item.Id, pin: false, Cancellation);
            Assert.NotNull(reviewed);
        }

        var edited = await SetAsync(Editor, item.Id, comments: true);
        Assert.True(edited.IsSuccess);
        Assert.Equal(item.Seq, edited.Value.Seq);

        await using var execution = await fixture.Application.BeginUnitOfWorkAsync(As(owner), Cancellation);
        var tree = execution.Resolve<IItemTree>();
        var pinned = await tree.ReadPetRevisionAsync(Workspace, item.Id, pin: true, Cancellation);
        Assert.NotNull(pinned);
        Assert.NotEqual(reviewed, pinned);
        Assert.Null(await tree.ReadPetRevisionAsync(WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId), item.Id, pin: true, Cancellation));
    }

    [Fact]
    public async Task Marking_an_item_for_pet_protection_advances_its_revision_and_survives_ordinary_settings_edits()
    {
        var owner = M0SchemaSeed.Alpha.PrincipalId;
        var item = await CreateNoteAsync(owner);
        var child = (await SendAsync<CreateItem, Item>(owner, new CreateItem(Workspace, "note", "Child", item.Id, null))).Value;
        Assert.True((await SetAsync(Editor, item.Id, fullWidth: true)).IsSuccess);
        var otherWorkspace = WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId);

        long? before;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(As(owner), Cancellation))
        {
            var tree = work.Resolve<IItemTree>();
            Assert.False(await tree.AnyItemsWithheldFromPetsAsync(Workspace, Cancellation));
            before = await work.Resolve<INativeReplayStore>().LockItemRevisionAsync(Workspace, item.Id, Cancellation);
            Assert.NotNull(before);
            Assert.False(await tree.SetItemPetProtectionAsync(item.Id, otherWorkspace, true, Cancellation));
            Assert.True(await tree.SetItemPetProtectionAsync(item.Id, Workspace, true, Cancellation));
            await work.CommitAsync(Cancellation);
        }

        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(As(owner), Cancellation))
        {
            var tree = work.Resolve<IItemTree>();
            Assert.True(await tree.AnyItemsWithheldFromPetsAsync(Workspace, Cancellation));
            Assert.False(await tree.AnyItemsWithheldFromPetsAsync(otherWorkspace, Cancellation));
            Assert.False(ItemSettings.Read((await tree.FindAsync(child.Id, Cancellation))!.Settings).WithholdFromPets);
            var after = await work.Resolve<INativeReplayStore>().LockItemRevisionAsync(Workspace, item.Id, Cancellation);
            Assert.Equal(before + 1, after);
        }

        var edited = await SetAsync(Editor, item.Id, comments: true);
        Assert.Equal(new ItemSettings(Comments: true, FullWidth: true, WithholdFromPets: true), ItemSettings.Read(edited.Value.Settings));

        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(As(owner), Cancellation))
        {
            var tree = work.Resolve<IItemTree>();
            Assert.True(await tree.SetItemPetProtectionAsync(item.Id, Workspace, false, Cancellation));
            await work.CommitAsync(Cancellation);
        }

        await using var read = await fixture.Application.BeginUnitOfWorkAsync(As(owner), Cancellation);
        var cleared = await read.Resolve<IItemTree>().FindAsync(item.Id, Cancellation);
        Assert.Equal(new ItemSettings(Comments: true, FullWidth: true), ItemSettings.Read(cleared!.Settings));
        Assert.False(await read.Resolve<IItemTree>().AnyItemsWithheldFromPetsAsync(Workspace, Cancellation));
        Assert.Equal(before + 3, await read.Resolve<INativeReplayStore>().LockItemRevisionAsync(Workspace, item.Id, Cancellation));
    }

    [Fact]
    public async Task Workspace_defaults_are_set_by_an_owner_only_and_apply_to_items_created_afterwards()
    {
        var existing = await CreateNoteAsync(M0SchemaSeed.Alpha.PrincipalId);

        Assert.Null(await SetDefaultsAsync(Editor, "{\"comments\":true}"));
        Assert.Null(await SetDefaultsAsync(Viewer, "{\"comments\":true}"));
        Assert.NotNull(await SetDefaultsAsync(M0SchemaSeed.Alpha.PrincipalId, ItemSettings.Patch(true, null, null, true)));

        var created = await CreateNoteAsync(Editor);
        Assert.Equal(new ItemSettings(Comments: true, FullWidth: true), ItemSettings.Read(created.Settings));

        // A member reads them; the item that existed before keeps its own.
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(As(Viewer), Cancellation))
        {
            var stored = await work.Resolve<WorkspaceAdministrationStore>().ReadItemDefaultsAsync(Workspace, Cancellation);
            Assert.Equal(new ItemSettings(Comments: true, FullWidth: true), ItemSettings.Read(stored));
        }

        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(As(Viewer), Cancellation))
        {
            var found = await work.Resolve<IItemTree>().FindAsync(existing.Id, Cancellation);
            Assert.Equal(new ItemSettings(), ItemSettings.Read(found!.Settings));
        }
    }

    [Fact]
    public async Task Comments_are_refused_while_off_existing_threads_stay_and_return_when_switched_on()
    {
        var note = await CreateNoteAsync(M0SchemaSeed.Alpha.PrincipalId);

        var refused = await CommentAsync(Editor, note.Id, "hello");
        Assert.Equal("comments.disabled", refused.Error.Code);

        await SetAsync(Editor, note.Id, comments: true);
        var thread = (await CommentAsync(Editor, note.Id, "hello")).Value;

        await SetAsync(Editor, note.Id, comments: false);
        Assert.Equal("comments.disabled", (await CommentAsync(Editor, note.Id, "again")).Error.Code);
        Assert.Equal("comments.disabled",
            (await SendAsync<ReplyComment, CommentThreadDto>(Editor, new ReplyComment(note.Id, thread.Id, new("reply", null)))).Error.Code);

        var listed = await ListAsync(Editor, note.Id);
        Assert.Single(listed.Value.Threads);
        Assert.False(listed.Value.CanComment);
        Assert.False(listed.Value.Enabled);

        await SetAsync(Editor, note.Id, comments: true);
        Assert.True((await ListAsync(Editor, note.Id)).Value.CanComment);
        Assert.True((await ListAsync(Editor, note.Id)).Value.Enabled);
        Assert.True((await CommentAsync(Editor, note.Id, "back")).IsSuccess);
    }

    [Fact]
    public async Task The_upgrade_switches_comments_on_for_notes_that_already_have_threads_only()
    {
        var options = new DbContextOptionsBuilder<NixDbContext>().UseNpgsql(fixture.MigratorConnectionString).Options;
        await using var context = new NixDbContext(options);
        var migrator = context.GetService<IMigrator>();
        await migrator.MigrateAsync("20261109170000_RetireFinanceViews", Cancellation);
        try
        {
            // The seed already gives each tenant's item a thread, so the control is a second, thread-free item.
            var ids = new[] { M0SchemaSeed.Alpha.ItemId, Guid.NewGuid(), Guid.NewGuid() };
            await context.Database.ExecuteSqlRawAsync(
                "INSERT INTO item (id, tenant_id, workspace_id, type, seq, lifecycle_state, created_by, last_modified_by, created_at, last_modified_at) "
                + "SELECT {0}, tenant_id, workspace_id, 'note', 2000, 'active', created_by, last_modified_by, now(), now() FROM item WHERE id = {2} "
                + "UNION ALL "
                + "SELECT {1}, tenant_id, workspace_id, 'file', 2001, 'active', created_by, last_modified_by, now(), now() FROM item WHERE id = {2}",
                [ids[1], ids[2], ids[0]], Cancellation);
            Assert.Equal(1, await context.Database
                .SqlQueryRaw<int>("SELECT count(*)::int AS \"Value\" FROM note_comment WHERE item_id = {0}", ids[0]).SingleAsync(Cancellation));

            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);

            var settings = await context.Database
                .SqlQueryRaw<string>("SELECT COALESCE(settings::text, '') AS \"Value\" FROM item WHERE id = {0}", ids[0])
                .SingleAsync(Cancellation);
            Assert.True(ItemSettings.Read(settings).Comments);
            var untouched = await context.Database
                .SqlQueryRaw<string>("SELECT COALESCE(settings::text, '') AS \"Value\" FROM item WHERE id = {0}", ids[1])
                .SingleAsync(Cancellation);
            Assert.Equal(string.Empty, untouched);

            // An existing file keeps its review states, so a public note still serves only approved versions.
            var file = await context.Database
                .SqlQueryRaw<string>("SELECT COALESCE(settings::text, '') AS \"Value\" FROM item WHERE id = {0}", ids[2])
                .SingleAsync(Cancellation);
            Assert.True(ItemSettings.Read(file).ReviewStates);
        }
        finally
        {
            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);
        }
    }

    [Fact]
    public async Task Notes_under_a_board_get_comments_on_unless_someone_has_set_them()
    {
        const string Board = """{"views":[{"id":"b","name":"Board","kind":"board"}],"default":"b"}""";
        var owner = M0SchemaSeed.Alpha.PrincipalId;
        var parent = await CreateNoteAsync(owner);
        var plain = await CreateNoteAsync(owner, parent.Id);
        var switchedOff = await CreateNoteAsync(owner, parent.Id);
        Assert.False(ItemSettings.Read(plain.Settings).Comments);
        Assert.True((await SetAsync(owner, switchedOff.Id, comments: false)).IsSuccess);

        // Gaining a board view turns the untouched child on and leaves the explicit off alone.
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(As(owner), Cancellation))
        {
            await work.Resolve<IItemTree>().UpdateViewsAsync(
                parent.Id, Board, PrincipalId.From(owner), DateTimeOffset.UtcNow, Cancellation);
            Assert.True(ItemSettings.Read((await work.Resolve<IItemTree>().FindAsync(plain.Id, Cancellation))!.Settings).Comments);
            Assert.False(ItemSettings.Read((await work.Resolve<IItemTree>().FindAsync(switchedOff.Id, Cancellation))!.Settings).Comments);
            await work.CommitAsync(Cancellation);
        }

        // A card created on the board starts on, and says so in the create answer.
        var card = await CreateNoteAsync(owner, parent.Id);
        Assert.True(ItemSettings.Read(card.Settings).Comments);
        Assert.True((await CommentAsync(owner, card.Id, "First")).IsSuccess);

        // A workspace default that says off wins over the board.
        await SetDefaultsAsync(owner, ItemSettings.Patch(false, null, null, null));
        Assert.False(ItemSettings.Read((await CreateNoteAsync(owner, parent.Id)).Settings).Comments);
    }

    [Fact]
    public async Task The_upgrade_switches_comments_on_for_existing_board_cards_nobody_has_set()
    {
        var options = new DbContextOptionsBuilder<NixDbContext>().UseNpgsql(fixture.MigratorConnectionString).Options;
        await using var context = new NixDbContext(options);
        var migrator = context.GetService<IMigrator>();
        await migrator.MigrateAsync("20261119100000_PetDecisionNotices", Cancellation);
        try
        {
            var ids = new[] { M0SchemaSeed.Alpha.ItemId, Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid() };
            await context.Database.ExecuteSqlRawAsync(
                "UPDATE item SET views = '{{\"views\":[{{\"id\":\"b\",\"kind\":\"board\"}}],\"default\":\"b\"}}'::jsonb WHERE id = {0}; "
                + "INSERT INTO item (id, tenant_id, workspace_id, parent_id, type, seq, lifecycle_state, settings, created_by, last_modified_by, created_at, last_modified_at) "
                + "SELECT v.id, i.tenant_id, i.workspace_id, i.id, v.type, v.seq, 'active', v.settings::jsonb, i.created_by, i.last_modified_by, now(), now() "
                + "FROM item i, (VALUES ({1}, 'note', 2000, NULL), ({2}, 'note', 2001, '{{\"comments\":false}}'), ({3}, 'file', 2002, NULL)) "
                + "AS v(id, type, seq, settings) WHERE i.id = {0}",
                [ids[0], ids[1], ids[2], ids[3]], Cancellation);

            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);

            async Task<string> SettingsAsync(Guid id) => await context.Database
                .SqlQueryRaw<string>("SELECT COALESCE(settings::text, '') AS \"Value\" FROM item WHERE id = {0}", id)
                .SingleAsync(Cancellation);
            Assert.True(ItemSettings.Read(await SettingsAsync(ids[1])).Comments);
            Assert.False(ItemSettings.Read(await SettingsAsync(ids[2])).Comments);
            Assert.Equal(string.Empty, await SettingsAsync(ids[3]));
        }
        finally
        {
            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);
        }
    }

    private async Task<Item> CreateNoteAsync(Guid who, ItemId? parent = null) =>
        (await SendAsync<CreateItem, Item>(who, new CreateItem(Workspace, "note", "Plan", parent, null))).Value;

    private Task<Result<Item>> SetAsync(
        Guid who, ItemId item, bool? comments = null, bool? fullWidth = null) =>
        SendAsync<SetItemSettings, Item>(who, new SetItemSettings(item, comments, null, null, fullWidth));

    private Task<Result<CommentThreadDto>> CommentAsync(Guid who, ItemId note, string body) =>
        SendAsync<AddComment, CommentThreadDto>(who, new AddComment(note, new(body, null, null)));

    private async Task<string?> SetDefaultsAsync(Guid who, string patch)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(As(who), Cancellation);
        var stored = await work.Resolve<WorkspaceAdministrationStore>().SetItemDefaultsAsync(Workspace, patch, Cancellation);
        await work.CommitAsync(Cancellation);
        return stored;
    }

    private async Task<Result<CommentsResponse>> ListAsync(Guid who, ItemId note)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(As(who), Cancellation);
        return await work.Resolve<NixDispatcher>()
            .QueryAsync<ListComments, Result<CommentsResponse>>(new ListComments(note), Cancellation);
    }

    private async Task<Result<TValue>> SendAsync<TCommand, TValue>(Guid who, TCommand command)
        where TCommand : ICommand<TValue>
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(As(who), Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<TCommand, TValue>(command, Cancellation);
        if (result.IsSuccess)
        {
            await work.CommitAsync(Cancellation);
        }

        return result;
    }

    private async Task RunAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, sql);
        }
    }

    private static string Literal(Guid value) => $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
