using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Features.Locks;
using Nix.Features.References;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// References and pins against a database built from migrations: the same-workspace rule, pins
/// that need an approved version, delete protection under the topology lock, workspace moves,
/// purge and tenant isolation.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class ItemReferenceTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly Guid Locker = new("5b7e0c00-3333-4333-8333-5b7e0c000001");
    private static readonly Guid OtherBrowser = new("5b7e0c00-3333-4333-8333-5b7e0c000002");
    private static readonly Guid OtherWorkspace = new("5b7e0c00-3333-4333-8333-5b7e0c000003");

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static ItemId Folder => ItemId.From(M0SchemaSeed.Alpha.ItemId);

    private static WorkspaceId Workspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await ExecuteAsMigratorAsync($"""
            INSERT INTO workspace
                (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                 storage_quota_bytes, created_at)
            VALUES ({Literal(OtherWorkspace)}, {Literal(M0SchemaSeed.Alpha.TenantId)},
                    'Other workspace', 30, 10, 1073741824, now());

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ({Literal(OtherWorkspace)}, 'principal', {Literal(M0SchemaSeed.Alpha.PrincipalId)},
                    {Literal(M0SchemaSeed.Alpha.TenantId)}, 'owner',
                    {Literal(M0SchemaSeed.Alpha.PrincipalId)}, now());
            """);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_reference_must_stay_inside_one_workspace_and_says_nothing_about_the_other()
    {
        var holder = await CreateAsync("Holder", Folder);
        var foreign = await CreateAsync("Secret plans", null, WorkspaceId.From(OtherWorkspace));

        var refused = await AddAsync(holder, foreign);

        Assert.True(refused.IsFailure);
        Assert.Equal("references.target_not_found", refused.Error.Code);
        Assert.DoesNotContain("Secret", refused.Error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(OtherWorkspace.ToString(), refused.Error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("references.target_not_found", (await AddAsync(holder, ItemId.Create())).Error.Code);
    }

    [Fact]
    public async Task A_pin_needs_a_file_and_one_of_its_own_approved_versions()
    {
        var holder = await CreateAsync("Holder", Folder);
        var (file, draft) = await NewFileAsync("Letter", Folder, "draft");
        var (_, otherVersion) = await NewFileAsync("Other", Folder, "approved");
        var note = await CreateAsync("Plain note", Folder);

        Assert.Equal("references.version_not_approved", (await AddAsync(holder, file, draft)).Error.Code);
        Assert.Equal("references.version_not_found", (await AddAsync(holder, file, otherVersion)).Error.Code);
        Assert.Equal("references.pin_requires_file", (await AddAsync(holder, note, draft)).Error.Code);

        await SetVersionStateAsync(draft, "approved");
        var pinned = await AddAsync(holder, file, draft);
        Assert.True(pinned.IsSuccess, pinned.IsFailure ? pinned.Error.Message : string.Empty);
        Assert.Equal("approved", pinned.Value.TargetVersionState);
    }

    [Fact]
    public async Task A_revoked_version_keeps_its_pin_and_the_file_stays_protected()
    {
        var holder = await CreateAsync("Holder", Folder);
        var (file, version) = await NewFileAsync("Letter", Folder, "approved");
        Assert.True((await AddAsync(holder, file, version)).IsSuccess);

        await SetVersionStateAsync(version, "revoked");

        var listed = await ListAsync(holder);
        Assert.Equal("revoked", Assert.Single(listed.Value.Items).TargetVersionState);
        Assert.Equal("items.pinned", (await DeleteAsync(file)).Error.Code);
    }

    [Fact]
    public async Task A_pinned_file_and_its_parents_refuse_trash_until_unpinned()
    {
        var holder = await CreateAsync("Holder", Folder);
        var parent = await CreateAsync("Parent", Folder);
        var (file, version) = await NewFileAsync("Letter", parent, "approved");
        var pin = await AddAsync(holder, file, version);

        var direct = await DeleteAsync(file);
        Assert.Equal("items.pinned", direct.Error.Code);
        Assert.Equal("items.pinned", (await DeleteAsync(parent)).Error.Code);
        Assert.Equal("items.pinned", (await DeleteAsync(Folder)).Error.Code);

        Assert.True((await RemoveAsync(holder, pin.Value.Id)).IsSuccess);
        Assert.True((await DeleteAsync(parent)).IsSuccess);
        Assert.Equal(ItemLifecycleState.Deleted, await StateOfAsync(parent));
    }

    [Fact]
    public async Task A_pin_protects_again_when_its_holder_is_restored_and_can_be_removed_while_it_is_trashed()
    {
        var holder = await CreateAsync("Holder", Folder);
        var (file, version) = await NewFileAsync("Letter", Folder, "approved");
        var pin = await AddAsync(holder, file, version);

        Assert.True((await DeleteAsync(holder)).IsSuccess);
        Assert.True((await SendAsync<RestoreItem, Item>(Locker, new RestoreItem(holder))).IsSuccess);
        Assert.Equal("items.pinned", (await DeleteAsync(file)).Error.Code);

        // Release it from the trash: the holder is hidden, the pin still has to be removable.
        Assert.True((await DeleteAsync(holder)).IsSuccess);
        Assert.True((await RemoveAsync(holder, pin.Value.Id)).IsSuccess);
        Assert.True((await DeleteAsync(file)).IsSuccess);
    }

    [Fact]
    public async Task A_plain_reference_blocks_nothing_and_a_trashed_target_shows_as_unavailable()
    {
        var holder = await CreateAsync("Holder", Folder);
        var target = await CreateAsync("Contact", Folder);

        var first = await AddAsync(holder, target, role: "contact");
        var again = await AddAsync(holder, target, role: "contact");
        Assert.True(first.IsSuccess);
        Assert.Equal(first.Value.Id, again.Value.Id);
        Assert.True(first.Value.TargetAvailable);

        Assert.True((await DeleteAsync(target)).IsSuccess);

        var row = Assert.Single((await ListAsync(holder)).Value.Items);
        Assert.False(row.TargetAvailable);
        Assert.Equal("contact", row.Role);
    }

    [Fact]
    public async Task Referenced_by_lists_holders_a_page_at_a_time()
    {
        var target = await CreateAsync("Organisation", Folder);
        var holders = new[] { await CreateAsync("One", Folder), await CreateAsync("Two", Folder), await CreateAsync("Three", Folder) };
        foreach (var holder in holders)
        {
            Assert.True((await AddAsync(holder, target)).IsSuccess);
        }

        var first = await QueryAsync<ListReferencedBy, ReferencePage<ItemReferencedByResponse>>(new ListReferencedBy(target, null, 2));
        Assert.Equal(2, first.Value.Items.Count);
        Assert.NotNull(first.Value.NextCursor);
        var second = await QueryAsync<ListReferencedBy, ReferencePage<ItemReferencedByResponse>>(new ListReferencedBy(target, first.Value.NextCursor, 2));
        Assert.Single(second.Value.Items);
        Assert.Null(second.Value.NextCursor);
        Assert.Equal(
            holders.Select(h => h.Value).Order(),
            first.Value.Items.Concat(second.Value.Items).Select(r => r.HolderItemId).Order());
        Assert.Equal("references.invalid_cursor", (await QueryAsync<ListReferencedBy, ReferencePage<ItemReferencedByResponse>>(new ListReferencedBy(target, "nonsense!", 2))).Error.Code);
    }

    [Fact]
    public async Task A_locked_target_is_unavailable_and_its_title_is_withheld()
    {
        var holder = await CreateAsync("Holder", Folder);
        var target = await CreateAsync("Private contact", Folder);
        Assert.True((await AddAsync(holder, target)).IsSuccess);
        Assert.True((await SendAsync<LockItem, bool>(Locker, new LockItem(target, "hunter22", null))).IsSuccess);

        var row = Assert.Single((await ListAsync(holder, OtherBrowser)).Value.Items);
        Assert.False(row.TargetAvailable);
        Assert.Null(row.TargetTitle);

        var open = Assert.Single((await ListAsync(holder, Locker)).Value.Items);
        Assert.True(open.TargetAvailable);
        Assert.Equal("Private contact", open.TargetTitle);
        Assert.Equal("items.locked", (await AddAsync(holder, target, credential: OtherBrowser)).Error.Code);
    }

    [Fact]
    public async Task The_record_keeps_the_same_approved_bytes_after_a_newer_upload()
    {
        var holder = await CreateAsync("Holder", Folder);
        var (file, v1) = await NewFileAsync("Letter", Folder, "approved");
        var before = await Sha256Async(v1);
        Assert.True((await AddAsync(holder, file, v1)).IsSuccess);

        var v2 = await AddVersionAsync(file, 2, "draft");
        await ExecuteAsMigratorAsync($"UPDATE file_body SET current_version_id = {Literal(v2)} WHERE item_id = {Literal(file.Value)}");

        var pin = Assert.Single((await ListAsync(holder)).Value.Items);
        Assert.Equal(v1, pin.TargetFileVersionId);
        Assert.Equal("approved", pin.TargetVersionState);
        Assert.Equal(before, await Sha256Async(pin.TargetFileVersionId!.Value));
        Assert.NotEqual(before, await Sha256Async(v2));
    }

    [Fact]
    public async Task A_pin_added_while_a_delete_waits_for_the_topology_lock_is_seen_by_the_delete()
    {
        var holder = await CreateAsync("Holder", Folder);
        var (file, version) = await NewFileAsync("Letter", Folder, "approved");

        await using var pinner = await BeginAsync(Locker);
        Assert.True((await pinner.Resolve<NixDispatcher>().SendAsync<AddReference, ItemReferenceResponse>(
            new AddReference(holder, new AddItemReferenceRequest(file.Value, version)), Cancellation)).IsSuccess);

        var pending = Task.Run(() => DeleteAsync(file), Cancellation);
        Assert.NotSame(pending, await Task.WhenAny(pending, Task.Delay(TimeSpan.FromSeconds(1), Cancellation)));

        await pinner.CommitAsync(Cancellation);
        var refused = await pending.WaitAsync(TimeSpan.FromSeconds(15), Cancellation);
        Assert.Equal("items.pinned", refused.Error.Code);
        Assert.Equal(ItemLifecycleState.Active, await StateOfAsync(file));
    }

    [Fact]
    public async Task Delete_takes_the_topology_lock_even_with_no_finance_guard()
    {
        var item = await CreateAsync("Loose note", Folder);
        await using var holdsLock = await BeginAsync(Locker);
        await holdsLock.Resolve<IFinanceLock>().AcquireWorkspaceTopologyAsync(Workspace, Cancellation);

        await using var deleter = await BeginAsync(Locker);
        var handler = new DeleteItemHandler(
            deleter.Resolve<IItemTree>(), deleter.Resolve<IPermissionResolver>(),
            deleter.Resolve<INixSessionContextAccessor>(), TimeProvider.System,
            deleter.Resolve<IFinanceLock>(), financeGuard: null, deleter.Resolve<IItemProtections>());
        var pending = handler.HandleAsync(new DeleteItem(item), Cancellation).AsTask();

        Assert.NotSame(pending, await Task.WhenAny(pending, Task.Delay(TimeSpan.FromSeconds(1), Cancellation)));
        await holdsLock.CommitAsync(Cancellation);
        Assert.True((await pending.WaitAsync(TimeSpan.FromSeconds(15), Cancellation)).IsSuccess);
        await deleter.CommitAsync(Cancellation);
    }

    [Fact]
    public async Task A_workspace_move_is_refused_when_the_item_or_anything_below_it_is_referenced()
    {
        var holder = await CreateAsync("Holder", Folder);
        var target = await CreateAsync("Contact", Folder);
        var folderWithTarget = await CreateAsync("Contacts", Folder);
        var below = await CreateAsync("Below", folderWithTarget);
        var loose = await CreateAsync("Loose", Folder);
        Assert.True((await AddAsync(holder, below)).IsSuccess);
        Assert.True((await AddAsync(holder, target)).IsSuccess);

        Assert.Equal("items.transfer_conflict", (await MoveAcrossAsync(holder)).Error.Code);
        Assert.Equal("items.transfer_conflict", (await MoveAcrossAsync(target)).Error.Code);
        Assert.Equal("items.transfer_conflict", (await MoveAcrossAsync(folderWithTarget)).Error.Code);

        var moved = await MoveAcrossAsync(loose);
        Assert.True(moved.IsSuccess, moved.IsFailure ? moved.Error.Message : string.Empty);
        Assert.Equal(WorkspaceId.From(OtherWorkspace), moved.Value.WorkspaceId);
    }

    [Fact]
    public async Task Purging_a_holder_deletes_the_references_it_holds_and_keeps_the_ones_pointing_at_it()
    {
        var holder = await CreateAsync("Holder", Folder);
        var target = await CreateAsync("Contact", Folder);
        var pointer = await CreateAsync("Pointer", Folder);
        Assert.True((await AddAsync(holder, target)).IsSuccess);
        Assert.True((await AddAsync(pointer, holder)).IsSuccess);

        Assert.True((await DeleteAsync(holder)).IsSuccess);
        Assert.True((await SendAsync<PurgeItem, ItemId>(Locker, new PurgeItem(holder))).IsSuccess);

        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM item_reference WHERE holder_item_id = {Literal(holder.Value)}"));
        var survivor = Assert.Single((await ListAsync(pointer)).Value.Items);
        Assert.False(survivor.TargetAvailable);
    }

    [Fact]
    public async Task Another_tenant_sees_no_references()
    {
        var holder = await CreateAsync("Holder", Folder);
        var target = await CreateAsync("Contact", Folder);
        Assert.True((await AddAsync(holder, target)).IsSuccess);

        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var listed = await dispatcher.QueryAsync<ListReferences, Result<ReferencePage<ItemReferenceResponse>>>(
                new ListReferences(holder, null, 50), Cancellation);
            Assert.Equal("items.not_found", listed.Error.Code);
            var by = await dispatcher.QueryAsync<ListReferencedBy, Result<ReferencePage<ItemReferencedByResponse>>>(
                new ListReferencedBy(target, null, 50), Cancellation);
            Assert.Equal("items.not_found", by.Error.Code);
            var removed = await dispatcher.SendAsync<RemoveReference, Guid>(new RemoveReference(holder, Guid.NewGuid()), Cancellation);
            Assert.Equal("items.not_found", removed.Error.Code);
            var seen = await RawSql.CountAsync(
                (Npgsql.NpgsqlConnection)work.DbContext.Database.GetDbConnection(),
                (Npgsql.NpgsqlTransaction)work.Transaction.GetDbTransaction(),
                "SELECT count(*) FROM item_reference WHERE role IS DISTINCT FROM 'seed' AND tenant_id <> '" + TestTenants.Beta + "'");
            Assert.Equal(0, seen);
        }
    }

    private async Task<ItemId> CreateAsync(string title, ItemId? parent, WorkspaceId? workspace = null)
    {
        var created = await SendAsync<CreateItem, Item>(Locker, new CreateItem(workspace ?? Workspace, "note", title, parent, null));
        Assert.True(created.IsSuccess, created.IsFailure ? created.Error.Message : string.Empty);
        return created.Value.Id;
    }

    /// <summary>A note turned into a file item with one version in the given state.</summary>
    private async Task<(ItemId File, Guid Version)> NewFileAsync(string title, ItemId parent, string state)
    {
        var file = await CreateAsync(title, parent);
        await ExecuteAsMigratorAsync($"UPDATE item SET type = 'file' WHERE id = {Literal(file.Value)}");
        return (file, await AddVersionAsync(file, 1, state));
    }

    private async Task<Guid> AddVersionAsync(ItemId file, int number, string state)
    {
        var id = Guid.NewGuid();
        await ExecuteAsMigratorAsync($"""
            INSERT INTO file_version
                (file_version_id, tenant_id, workspace_id, item_id, version, object_key, file_name,
                 media_type, byte_length, sha256, previewable, created_by, created_at, state)
            VALUES ({Literal(id)}, {Literal(M0SchemaSeed.Alpha.TenantId)}, {Literal(M0SchemaSeed.Alpha.WorkspaceId)},
                    {Literal(file.Value)}, {number}, 'files/test/{id:N}', 'letter.pdf', 'application/pdf', 4,
                    repeat('{id.ToString("N", CultureInfo.InvariantCulture)[0]}', 63) || '{number}', false,
                    {Literal(M0SchemaSeed.Alpha.PrincipalId)}, now(), '{state}')
            """);
        return id;
    }

    private Task SetVersionStateAsync(Guid version, string state) =>
        ExecuteAsMigratorAsync($"UPDATE file_version SET state = '{state}' WHERE file_version_id = {Literal(version)}");

    private Task<Result<ItemReferenceResponse>> AddAsync(
        ItemId holder, ItemId target, Guid? version = null, string? role = null, Guid? credential = null) =>
        SendAsync<AddReference, ItemReferenceResponse>(
            credential ?? Locker, new AddReference(holder, new AddItemReferenceRequest(target.Value, version, role)));

    private Task<Result<Guid>> RemoveAsync(ItemId holder, Guid reference) =>
        SendAsync<RemoveReference, Guid>(Locker, new RemoveReference(holder, reference));

    private Task<Result<ReferencePage<ItemReferenceResponse>>> ListAsync(ItemId holder, Guid? credential = null) =>
        QueryAsync<ListReferences, ReferencePage<ItemReferenceResponse>>(new ListReferences(holder, null, 50), credential ?? Locker);

    private Task<Result<ItemId>> DeleteAsync(ItemId item) => SendAsync<DeleteItem, ItemId>(Locker, new DeleteItem(item));

    private Task<Result<Item>> MoveAcrossAsync(ItemId item) =>
        SendAsync<MoveItem, Item>(Locker, new MoveItem(item, null, null, WorkspaceId.From(OtherWorkspace)));

    private async Task<Result<TResult>> SendAsync<TCommand, TResult>(Guid credential, TCommand command)
        where TCommand : ICommand<TResult>
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>().SendAsync<TCommand, TResult>(command, Cancellation);
            await work.CommitAsync(Cancellation);
            return result;
        }
    }

    private async Task<Result<TResult>> QueryAsync<TQuery, TResult>(TQuery query, Guid? credential = null)
        where TQuery : IQuery<Result<TResult>>
    {
        var work = await BeginAsync(credential ?? Locker);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>().QueryAsync<TQuery, Result<TResult>>(query, Cancellation);
        }
    }

    private async Task<ItemLifecycleState> StateOfAsync(ItemId item)
    {
        var work = await BeginAsync(Locker);
        await using (work.ConfigureAwait(false))
        {
            return (await work.Resolve<IItemTree>().FindStoredAsync(item, Cancellation))!.LifecycleState;
        }
    }

    private async Task<string?> Sha256Async(Guid version)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.TextAsync(connection, null, $"SELECT sha256 FROM file_version WHERE file_version_id = {Literal(version)}");
        }
    }

    private async Task<long> CountAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.CountAsync(connection, null, sql);
        }
    }

    private async Task<NixUnitOfWork> BeginAsync(Guid credential)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        work.Resolve<CredentialSessionContext>().Set(credential);
        return work;
    }

    private async Task ExecuteAsMigratorAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private static string Literal(Guid value) =>
        $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
