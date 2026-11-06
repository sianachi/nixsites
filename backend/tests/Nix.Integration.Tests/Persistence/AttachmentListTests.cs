using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Attachments;
using Nix.Features.Items;
using Nix.Features.Locks;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The attachments list on real Postgres as the runtime role: which version a file shows, the
/// filters, keyset paging, pin and link flags, what a lock withholds, and tenant isolation.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class AttachmentListTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private const string Password = "hunter22";

    private static readonly Guid Locker = new("6c8f1d00-3333-4333-8333-6c8f1d000001");
    private static readonly Guid OtherBrowser = new("6c8f1d00-3333-4333-8333-6c8f1d000002");

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static WorkspaceId Workspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    private Guid _alpha;
    private Guid _alphaV1;
    private Guid _bravoV2;
    private Guid _picture;
    private Guid _delta;
    private Guid _vaultFile;
    private Guid _lockedFile;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);

        var vault = await CreateAsync("Vault", null);
        var holder = await CreateAsync("Holder", null);
        var trashedFolder = await CreateAsync("Trashed folder", null);

        (_alpha, var alphaVersions) = await AddFileAsync("alpha.pdf", null, ("application/pdf", "draft"));
        _alphaV1 = alphaVersions[0];
        var (bravo, bravoVersions) = await AddFileAsync("bravo.pdf", null, ("application/pdf", "approved"), ("application/pdf", "approved"), ("application/pdf", "draft"));
        _bravoV2 = bravoVersions[1];
        (_picture, _) = await AddFileAsync("pic.png", null, ("image/png", "draft"));
        (_delta, _) = await AddFileAsync("delta.pdf", null, ("application/pdf", "in_review"));
        (_vaultFile, _) = await AddFileAsync("inside-vault.pdf", vault, ("application/pdf", "draft"));
        (_lockedFile, _) = await AddFileAsync("itself-locked.pdf", null, ("application/pdf", "draft"));
        var (hidden, _) = await AddFileAsync("under-trash.pdf", trashedFolder, ("application/pdf", "draft"));

        var tenant = M0SchemaSeed.Alpha.TenantId;
        var principal = M0SchemaSeed.Alpha.PrincipalId;
        await ExecAsync(
            $"UPDATE item SET properties = properties || '{{\"expiry\":\"2027-03-01\",\"$expiry_set_by\":\"{principal}\"}}'::jsonb WHERE id = '{_delta}'",
            $"UPDATE item SET lifecycle_state = 'deleted' WHERE id = '{trashedFolder}'",
            // A pin on alpha v1, a plain reference to alpha that is not a pin, an active link on bravo and a revoked one on delta.
            $"INSERT INTO item_reference (id, tenant_id, workspace_id, holder_item_id, target_item_id, target_file_version_id, role, created_by, created_at) VALUES (gen_random_uuid(), '{tenant}', '{Workspace.Value}', '{holder}', '{_alpha}', '{_alphaV1}', 'pin', '{principal}', now())",
            $"INSERT INTO item_reference (id, tenant_id, workspace_id, holder_item_id, target_item_id, role, created_by, created_at) VALUES (gen_random_uuid(), '{tenant}', '{Workspace.Value}', '{holder}', '{_alpha}', 'mention', '{principal}', now())",
            $"INSERT INTO public_link (id, tenant_id, workspace_id, item_id, nonce, service_principal_id, created_by, created_at) VALUES (gen_random_uuid(), '{tenant}', '{Workspace.Value}', '{bravo}', 'n1', '{principal}', '{principal}', now())",
            $"INSERT INTO public_link (id, tenant_id, workspace_id, item_id, nonce, service_principal_id, created_by, created_at, revoked_at) VALUES (gen_random_uuid(), '{tenant}', '{Workspace.Value}', '{_delta}', 'n2', '{principal}', '{principal}', now(), now())",
            $"UPDATE file_version SET source_item_id = '{holder}' WHERE file_version_id = '{_bravoV2}'");

        Assert.True((await SendAsync(new LockItem(ItemId.From(vault), Password, null))).IsSuccess);
        Assert.True((await SendAsync(new LockItem(ItemId.From(_lockedFile), Password, null))).IsSuccess);
        _ = hidden;
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_file_shows_its_latest_approved_version_else_its_current_one()
    {
        var rows = await ListAsync(Locker, new ListAttachments(Workspace, null, true, false, null, 200));

        var bravo = Assert.Single(rows, row => row.Title == "bravo.pdf");
        Assert.Equal(_bravoV2, bravo.ShownVersionId);
        Assert.Equal("approved", bravo.ShownVersionState);
        Assert.NotNull(bravo.SourceItemId);
        Assert.True(bravo.HasPublicLink);

        var alpha = Assert.Single(rows, row => row.Title == "alpha.pdf");
        Assert.Equal(_alphaV1, alpha.ShownVersionId);
        Assert.Equal("draft", alpha.ShownVersionState);
        Assert.Equal(1, alpha.PinCount);
        Assert.False(alpha.HasPublicLink);

        // A revoked link is not a link.
        Assert.False(Assert.Single(rows, row => row.Title == "delta.pdf").HasPublicLink);
    }

    [Fact]
    public async Task Images_trash_and_templates_stay_out_unless_asked_for()
    {
        var withoutImages = await ListAsync(Locker, new ListAttachments(Workspace, null, false, false, null, 200));
        var withImages = await ListAsync(Locker, new ListAttachments(Workspace, null, true, false, null, 200));

        Assert.DoesNotContain(withoutImages, row => row.Title == "pic.png");
        Assert.Contains(withImages, row => row.Title == "pic.png");
        Assert.DoesNotContain(withImages, row => row.Title == "under-trash.pdf");
    }

    [Fact]
    public async Task The_state_and_expiring_filters_apply_to_the_shown_version()
    {
        var approved = await ListAsync(Locker, new ListAttachments(Workspace, "approved", true, false, null, 200));
        var inReview = await ListAsync(Locker, new ListAttachments(Workspace, "in_review", true, false, null, 200));
        var expiring = await ListAsync(Locker, new ListAttachments(Workspace, null, true, true, null, 200));

        Assert.Equal(["bravo.pdf"], approved.Select(row => row.Title));
        Assert.Equal(["delta.pdf"], inReview.Select(row => row.Title));
        var delta = Assert.Single(expiring);
        Assert.Equal("delta.pdf", delta.Title);
        Assert.Equal(new DateTimeOffset(2027, 3, 1, 0, 0, 0, TimeSpan.Zero), delta.ExpiresAt);
    }

    [Fact]
    public async Task Paging_walks_every_row_once()
    {
        var all = await ListAsync(Locker, new ListAttachments(Workspace, null, true, false, null, 200));
        var walked = new List<Guid>();
        Guid? after = null;
        for (var guard = 0; guard < 20; guard++)
        {
            var page = await PageAsync(Locker, new ListAttachments(Workspace, null, true, false, after, 2));
            Assert.True(page.Items.Count <= 2);
            walked.AddRange(page.Items.Select(row => row.ItemId));
            if (page.NextCursor is null)
            {
                break;
            }

            after = Guid.Parse(page.NextCursor);
        }

        Assert.Equal(all.Select(row => row.ItemId), walked);
        Assert.Equal(walked.Distinct().Count(), walked.Count);
    }

    [Fact]
    public async Task A_locked_file_and_a_file_under_a_lock_are_left_out_until_the_credential_unlocks_them()
    {
        var closed = await ListAsync(OtherBrowser, new ListAttachments(Workspace, null, true, false, null, 200));
        var open = await ListAsync(Locker, new ListAttachments(Workspace, null, true, false, null, 200));

        Assert.DoesNotContain(closed, row => row.ItemId == _vaultFile || row.ItemId == _lockedFile);
        Assert.DoesNotContain(closed, row => row.Title.Contains("inside-vault", StringComparison.Ordinal) || row.Title.Contains("itself-locked", StringComparison.Ordinal));
        Assert.Contains(open, row => row.ItemId == _vaultFile);
        Assert.Contains(open, row => row.ItemId == _lockedFile);
    }

    [Fact]
    public async Task Another_tenants_workspace_answers_not_found()
    {
        var work = await BeginAsync(Locker);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>().QueryAsync<ListAttachments, Result<AttachmentPage>>(
                new ListAttachments(WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId), null, true, false, null, 50),
                Cancellation);
            Assert.True(result.IsFailure);
        }
    }

    private async Task<IReadOnlyList<AttachmentRow>> ListAsync(Guid credential, ListAttachments query) =>
        (await PageAsync(credential, query)).Items;

    private async Task<AttachmentPage> PageAsync(Guid credential, ListAttachments query)
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>().QueryAsync<ListAttachments, Result<AttachmentPage>>(query, Cancellation);
            Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
            return result.Value;
        }
    }

    private async Task<Guid> CreateAsync(string title, ItemId? parent)
    {
        var work = await BeginAsync(Locker);
        await using (work.ConfigureAwait(false))
        {
            var created = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(
                new CreateItem(Workspace, "note", title, parent, null),
                Cancellation);
            Assert.True(created.IsSuccess, created.IsFailure ? created.Error.Message : string.Empty);
            await work.CommitAsync(Cancellation);
            return created.Value.Id.Value;
        }
    }

    /// <summary>Makes a file item of the given versions (oldest first); the newest is the current one.</summary>
    private async Task<(Guid ItemId, Guid[] Versions)> AddFileAsync(string title, Guid? parent, params (string MediaType, string State)[] versions)
    {
        var itemId = await CreateAsync(title, parent is { } p ? ItemId.From(p) : null);
        var tenant = M0SchemaSeed.Alpha.TenantId;
        var principal = M0SchemaSeed.Alpha.PrincipalId;
        var ids = versions.Select(_ => Guid.NewGuid()).ToArray();
        var statements = new List<string> { $"UPDATE item SET type = 'file' WHERE id = '{itemId}'" };
        for (var index = 0; index < versions.Length; index++)
        {
            statements.Add(
                $"INSERT INTO file_version (file_version_id, tenant_id, workspace_id, item_id, version, object_key, file_name, media_type, byte_length, sha256, previewable, created_by, created_at, state) VALUES ('{ids[index]}', '{tenant}', '{Workspace.Value}', '{itemId}', {index + 1}, 'files/test/{ids[index]}', '{title}', '{versions[index].MediaType}', 4, repeat('c', 64), false, '{principal}', now(), '{versions[index].State}')");
        }

        statements.Add($"INSERT INTO file_body (item_id, tenant_id, workspace_id, current_version_id) VALUES ('{itemId}', '{tenant}', '{Workspace.Value}', '{ids[^1]}')");
        await ExecAsync([.. statements]);
        return (itemId, ids);
    }

    private async Task ExecAsync(params string[] statements)
    {
        var work = await BeginAsync(Locker);
        await using (work.ConfigureAwait(false))
        {
            foreach (var statement in statements)
            {
                await RawSql.ExecuteAsync(
                    (NpgsqlConnection)work.DbContext.Database.GetDbConnection(),
                    (NpgsqlTransaction)work.Transaction.GetDbTransaction(),
                    statement);
            }

            await work.CommitAsync(Cancellation);
        }
    }

    private async Task<Result<bool>> SendAsync(LockItem command)
    {
        var work = await BeginAsync(Locker);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>().SendAsync<LockItem, bool>(command, Cancellation);
            await work.CommitAsync(Cancellation);
            return result;
        }
    }

    private async Task<NixUnitOfWork> BeginAsync(Guid credential)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        work.Resolve<CredentialSessionContext>().Set(credential);
        return work;
    }
}
