using System.Globalization;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Domain.Items;
using Nix.Domain.Links;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Features.Internal;
using Nix.Features.Locks;
using Nix.Features.Search;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence;
using Nix.Persistence.Templates;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// An item lock withholds the body from every credential that has not presented the password, on
/// every path that serves the body or something derived from it.
/// </summary>
/// <remarks>
/// <para>
/// Credentials are the unit that matters, not principals: the same person in two browsers is two
/// credentials, and unlocking in one must leave the other closed. The tests set the credential the
/// way the unit-of-work middleware does, through <see cref="CredentialSessionContext"/>.
/// </para>
/// <para>
/// The seeded item carries a body ("alpha note body") in the search table and a self-edge in the
/// link table, which is what the derived-path tests below lean on.
/// </para>
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class ItemLockTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    /// <summary>The browser session that sets the lock.</summary>
    private static readonly Guid Locker = new("10c10c00-1111-4111-8111-10c10c000001");

    /// <summary>The same person's other browser.</summary>
    private static readonly Guid OtherBrowser = new("10c10c00-1111-4111-8111-10c10c000002");

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static ItemId Item => ItemId.From(M0SchemaSeed.Alpha.ItemId);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Locking_leaves_the_locking_session_open_and_every_other_session_closed()
    {
        Assert.True((await LockAsync(Locker, "hunter22")).IsSuccess);

        var mine = await StateAsync(Locker);
        var theirs = await StateAsync(OtherBrowser);
        var nobody = await StateAsync(null);

        Assert.True(mine.Locked);
        Assert.NotNull(mine.UnlockedUntil);
        Assert.True(theirs.Locked);
        Assert.Null(theirs.UnlockedUntil);
        Assert.True(nobody.Locked);
        Assert.Null(nobody.UnlockedUntil);
    }

    /// <summary>
    /// The one question the collaboration service asks for every body it serves - the live
    /// document, updates, history, versions and an export's root.
    /// </summary>
    [Fact]
    public async Task The_collaboration_service_is_refused_a_locked_body_for_a_session_that_has_not_unlocked_it()
    {
        Assert.True((await AuthorizeAsync(OtherBrowser)).IsSuccess);

        await LockAsync(Locker, "hunter22");

        Assert.True((await AuthorizeAsync(Locker)).IsSuccess);

        var refused = await AuthorizeAsync(OtherBrowser);
        Assert.True(refused.IsFailure);
        Assert.Equal(InternalErrors.BodyLockedCode, refused.Error.Code);

        // A worker delegation or external token has no credential, and so no way past the lock.
        Assert.True((await AuthorizeAsync(null)).IsFailure);
    }

    [Fact]
    public async Task The_right_password_opens_the_body_and_relocking_closes_it_again()
    {
        await LockAsync(Locker, "hunter22");

        var wrong = await UnlockAsync(OtherBrowser, "hunter23");
        Assert.Equal(LockErrors.WrongPasswordCode, wrong.Error.Code);
        Assert.True((await AuthorizeAsync(OtherBrowser)).IsFailure);

        var opened = await UnlockAsync(OtherBrowser, "hunter22");
        Assert.True(opened.IsSuccess);
        Assert.True((await AuthorizeAsync(OtherBrowser)).IsSuccess);

        await SendAsync<RelockItem, bool>(OtherBrowser, new RelockItem(Item));
        Assert.True((await AuthorizeAsync(OtherBrowser)).IsFailure);

        // Relocking one session leaves the other alone.
        Assert.True((await AuthorizeAsync(Locker)).IsSuccess);
    }

    [Fact]
    public async Task A_credential_that_cannot_hold_an_unlock_is_told_so()
    {
        await LockAsync(Locker, "hunter22");

        var refused = await UnlockAsync(null, "hunter22");

        Assert.Equal(LockErrors.CredentialCannotUnlockCode, refused.Error.Code);
    }

    [Fact]
    public async Task An_expired_unlock_no_longer_opens_the_body()
    {
        await LockAsync(Locker, "hunter22");
        await ExecuteAsMigratorAsync(
            $"UPDATE item_unlock SET expires_at = now() - interval '1 second' WHERE credential_id = {Literal(Locker)}");

        Assert.Null((await StateAsync(Locker)).UnlockedUntil);
        Assert.True((await AuthorizeAsync(Locker)).IsFailure);
    }

    /// <summary>
    /// Without this, anybody who could edit the item could replace the password and read the body.
    /// </summary>
    [Fact]
    public async Task A_second_lock_needs_the_current_password_and_changing_it_closes_every_other_session()
    {
        await LockAsync(Locker, "hunter22");
        await UnlockAsync(OtherBrowser, "hunter22");

        var blind = await LockAsync(OtherBrowser, "takeover", currentPassword: null);
        Assert.Equal(LockErrors.AlreadyLockedCode, blind.Error.Code);

        var guessed = await LockAsync(OtherBrowser, "takeover", currentPassword: "wrong!");
        Assert.Equal(LockErrors.WrongPasswordCode, guessed.Error.Code);

        Assert.True((await LockAsync(Locker, "rotated!", currentPassword: "hunter22")).IsSuccess);

        Assert.True((await AuthorizeAsync(OtherBrowser)).IsFailure);
        Assert.True((await AuthorizeAsync(Locker)).IsSuccess);
        Assert.Equal(LockErrors.WrongPasswordCode, (await UnlockAsync(OtherBrowser, "hunter22")).Error.Code);
        Assert.True((await UnlockAsync(OtherBrowser, "rotated!")).IsSuccess);
    }

    [Fact]
    public async Task Removing_a_lock_needs_its_password_and_opens_the_body_to_everybody()
    {
        await LockAsync(Locker, "hunter22");

        var refused = await SendAsync<RemoveItemLock, bool>(Locker, new RemoveItemLock(Item, "nope"));
        Assert.Equal(LockErrors.WrongPasswordCode, refused.Error.Code);

        Assert.True((await SendAsync<RemoveItemLock, bool>(Locker, new RemoveItemLock(Item, "hunter22"))).IsSuccess);

        Assert.False((await StateAsync(OtherBrowser)).Locked);
        Assert.True((await AuthorizeAsync(null)).IsSuccess);

        var again = await SendAsync<RemoveItemLock, bool>(Locker, new RemoveItemLock(Item, "hunter22"));
        Assert.Equal(LockErrors.NotLockedCode, again.Error.Code);
    }

    [Fact]
    public async Task Removal_cannot_use_a_verifier_read_before_a_password_change_committed()
    {
        Assert.True((await LockAsync(Locker, "old-password")).IsSuccess);
        await using var remover = await BeginAsync(OtherBrowser);
        var locks = remover.Resolve<IItemLocks>();
        var verified = await locks.FindVerifierAsync(Item, Cancellation);
        Assert.NotNull(verified);

        Assert.True((await LockAsync(Locker, "new-password", "old-password")).IsSuccess);

        Assert.False(await locks.RemoveAsync(Item, verified, Cancellation));
        await remover.CommitAsync(Cancellation);
        Assert.True((await StateAsync(OtherBrowser)).Locked);
        Assert.True((await SendAsync<RemoveItemLock, bool>(Locker, new RemoveItemLock(Item, "new-password"))).IsSuccess);
    }

    [Fact]
    public async Task A_password_outside_the_accepted_length_is_refused()
    {
        var refused = await LockAsync(Locker, "abc");

        Assert.Equal(LockErrors.PasswordInvalidCode, refused.Error.Code);
        Assert.False((await StateAsync(Locker)).Locked);
    }

    /// <summary>
    /// Nothing may be done to the lock of an item the caller cannot see, and the refusal is the
    /// same "not found" an item read gives - not a lock-shaped answer that confirms it exists.
    /// </summary>
    [Fact]
    public async Task Another_tenant_can_neither_read_nor_set_the_lock()
    {
        await LockAsync(Locker, "hunter22");

        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            work.Resolve<CredentialSessionContext>().Set(OtherBrowser);
            var dispatcher = work.Resolve<NixDispatcher>();

            var read = await dispatcher.QueryAsync<GetItemLock, Result<ItemLockState>>(new GetItemLock(Item), Cancellation);
            var unlock = await dispatcher.SendAsync<UnlockItem, DateTimeOffset>(new UnlockItem(Item, "hunter22"), Cancellation);

            Assert.Equal(LockErrors.NotFoundCode, read.Error.Code);
            Assert.Equal(LockErrors.NotFoundCode, unlock.Error.Code);
        }
    }

    [Fact]
    public async Task The_stored_verifier_is_not_the_password()
    {
        await LockAsync(Locker, "hunter22");

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var stored = await RawSql.TextAsync(connection, transaction: null, "SELECT password_hash FROM item_lock");

            Assert.NotNull(stored);
            Assert.DoesNotContain("hunter22", stored, StringComparison.Ordinal);
            Assert.StartsWith("pbkdf2-sha256$", stored, StringComparison.Ordinal);
        }
    }

    /// <summary>
    /// Matching is a read: a search that found a locked note for a word would disclose the body a
    /// word at a time. Not relaxed for a session that has it open.
    /// </summary>
    [Fact]
    public async Task A_locked_body_never_matches_a_search()
    {
        Assert.Contains(await SearchAsync("note body"), hit => hit.Id == Item);

        await LockAsync(Locker, "hunter22");

        Assert.DoesNotContain(await SearchAsync("note body"), hit => hit.Id == Item);
    }

    /// <summary>An edge is extracted from its source's body, so a locked source draws none.</summary>
    [Fact]
    public async Task A_locked_body_contributes_no_backlinks()
    {
        Assert.Single(await BacklinksAsync());

        await LockAsync(Locker, "hunter22");

        Assert.Empty(await BacklinksAsync());
    }

    [Fact]
    public async Task A_subtree_is_locked_when_its_root_or_anything_under_it_is()
    {
        Assert.False(await AnyInSubtreeAsync());

        await LockAsync(Locker, "hunter22");

        Assert.True(await AnyInSubtreeAsync());
    }

    /// <summary>
    /// The collaboration service needs to know which items are locked and nothing more; a
    /// compromise of it must not yield a verifier to attack offline.
    /// </summary>
    [Fact]
    public async Task The_collaboration_role_can_see_which_items_are_locked_and_never_the_verifier()
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var readable = await RawSql.TextListAsync(
                connection,
                $"""
                SELECT column_name FROM information_schema.column_privileges
                WHERE table_schema = 'public' AND table_name = '{NixTables.ItemLock}'
                  AND grantee = '{NixDatabaseRoles.Collaboration}' AND privilege_type = 'SELECT'
                ORDER BY column_name
                """);
            Assert.Equal(["item_id", NixTables.TenantIdColumn], readable);

            var unlocks = await RawSql.TextListAsync(
                connection,
                $"""
                SELECT privilege_type FROM information_schema.column_privileges
                WHERE table_schema = 'public' AND table_name = '{NixTables.ItemUnlock}'
                  AND grantee = '{NixDatabaseRoles.Collaboration}'
                """);
            Assert.Empty(unlocks);
        }
    }

    /// <summary>A file item's bytes are its body: metadata, downloads and replacements all wait for an unlock.</summary>
    [Fact]
    public async Task A_locked_file_is_withheld_from_every_session_that_has_not_unlocked_it()
    {
        await LockAsync(Locker, "hunter22");

        var closed = await BeginAsync(OtherBrowser);
        await using (closed.ConfigureAwait(false))
        {
            var files = closed.Resolve<IFileStore>();
            Assert.Null(await files.GetAsync(Item, Cancellation));
            Assert.Null(await files.AuthorizeDownloadAsync(Item, null, Cancellation));
            Assert.Null(await files.AuthorizeVersionHistoryAsync(Item, Cancellation));
        }

        var open = await BeginAsync(Locker);
        await using (open.ConfigureAwait(false))
        {
            var files = open.Resolve<IFileStore>();
            Assert.NotNull(await files.GetAsync(Item, Cancellation));
            Assert.NotNull(await files.AuthorizeDownloadAsync(Item, null, Cancellation));
        }
    }

    /// <summary>
    /// A grant is issued only against the verifier the password was checked with, so a lock whose
    /// password changed - or that was removed - during the check issues nothing.
    /// </summary>
    [Fact]
    public async Task A_grant_against_a_verifier_that_has_since_changed_writes_nothing()
    {
        await LockAsync(Locker, "hunter22");

        var work = await BeginAsync(OtherBrowser);
        await using (work.ConfigureAwait(false))
        {
            var locks = work.Resolve<IItemLocks>();
            var stale = LockPasswordHasher.Hash("hunter22");

            Assert.False(await locks.GrantAsync(Item, stale, DateTimeOffset.UtcNow.AddMinutes(15), Cancellation));
            Assert.False(await locks.MayReadBodyAsync(Item, Cancellation));
        }

        await SendAsync<RemoveItemLock, bool>(Locker, new RemoveItemLock(Item, "hunter22"));
        var afterRemoval = await BeginAsync(OtherBrowser);
        await using (afterRemoval.ConfigureAwait(false))
        {
            // No foreign-key failure: with no lock, there is simply nothing to grant against.
            Assert.False(await afterRemoval.Resolve<IItemLocks>()
                .GrantAsync(Item, LockPasswordHasher.Hash("hunter22"), DateTimeOffset.UtcNow.AddMinutes(15), Cancellation));
        }
    }

    /// <summary>
    /// A template carries a copy that outlives its source and is applied unlocked, so a capture that
    /// would include a locked body - a note's text or a file's bytes - is refused before staging.
    /// </summary>
    [Fact]
    public async Task A_template_cannot_be_captured_from_a_locked_item()
    {
        await LockAsync(Locker, "hunter22");

        var work = await BeginAsync(Locker);
        await using (work.ConfigureAwait(false))
        {
            // The seed carries one transfer of its own; what matters is that the capture adds none.
            var transfersBefore = work.DbContext.TemplateFileTransfers.Count();
            var begun = await work.Resolve<TemplateStore>().BeginCaptureAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                Item,
                "Locked template",
                null,
                includeBody: true,
                includeChildren: true,
                "capture-locked",
                Cancellation);

            Assert.True(begun.IsFailure);
            Assert.Equal(TemplateErrors.SourceLockedCode, begun.Error.Code);
            Assert.Equal(transfersBefore, work.DbContext.TemplateFileTransfers.Count());
        }
    }

    [Fact]
    public async Task A_template_owned_item_cannot_be_locked()
    {
        await ExecuteAsMigratorAsync(
            $"UPDATE item SET template_id = (SELECT template_id FROM workspace_template WHERE tenant_id = {Literal(M0SchemaSeed.Alpha.TenantId)} LIMIT 1), template_source_id = gen_random_uuid() WHERE id = {Literal(M0SchemaSeed.Alpha.ItemId)}");

        var refused = await LockAsync(Locker, "hunter22");

        Assert.Equal(LockErrors.NotFoundCode, refused.Error.Code);
    }

    private async Task<Result<bool>> LockAsync(Guid? credential, string password, string? currentPassword = null) =>
        await SendAsync<LockItem, bool>(credential, new LockItem(Item, password, currentPassword));

    private async Task<Result<DateTimeOffset>> UnlockAsync(Guid? credential, string password) =>
        await SendAsync<UnlockItem, DateTimeOffset>(credential, new UnlockItem(Item, password));

    private async Task<Result<TResult>> SendAsync<TCommand, TResult>(Guid? credential, TCommand command)
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

    private async Task<ItemLockState> StateAsync(Guid? credential)
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetItemLock, Result<ItemLockState>>(new GetItemLock(Item), Cancellation);
            Assert.True(result.IsSuccess);
            return result.Value;
        }
    }

    private async Task<Result<ItemAuthorization>> AuthorizeAsync(Guid? credential)
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>()
                .QueryAsync<GetItemAuthorization, Result<ItemAuthorization>>(new GetItemAuthorization(Item), Cancellation);
        }
    }

    private async Task<IReadOnlyList<ItemDigest>> SearchAsync(string query)
    {
        var work = await BeginAsync(Locker);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<SearchItems, Result<SearchResults>>(new SearchItems(query, SearchItemsHandler.DefaultLimit), Cancellation);
            Assert.True(result.IsSuccess);
            return result.Value.Hits;
        }
    }

    private async Task<IReadOnlyList<Backlink>> BacklinksAsync()
    {
        var work = await BeginAsync(Locker);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetBacklinks, Result<BacklinkResults>>(new GetBacklinks(Item, 25), Cancellation);
            Assert.True(result.IsSuccess);
            return result.Value.Backlinks;
        }
    }

    private async Task<bool> AnyInSubtreeAsync()
    {
        var work = await BeginAsync(null);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<IItemLocks>().AnyInSubtreeAsync(Item, Cancellation);
        }
    }

    private async Task<NixUnitOfWork> BeginAsync(Guid? credential)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        if (credential is { } id)
        {
            work.Resolve<CredentialSessionContext>().Set(id);
        }

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
