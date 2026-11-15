using Microsoft.AspNetCore.DataProtection;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Identity;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>The local sign-in functions over real Postgres: the pause, single-use links, codes and challenges.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class LocalSignInStoreTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly PrincipalId Alpha = PrincipalId.From(TestTenants.AlphaPrincipal);
    private static readonly PrincipalId Beta = PrincipalId.From(TestTenants.BetaPrincipal);

    private NpgsqlDataSource _dataSource = null!;
    private LocalAccountStore _accounts = null!;
    private LocalCredentialStore _credentials = null!;
    private LocalAccountLinkStore _links = null!;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _dataSource = NpgsqlDataSource.Create(fixture.ApplicationConnectionString);

        // Only the pre-tenant methods are exercised here; creation needs a unit of work and is covered by the HTTP lane.
        _accounts = new LocalAccountStore(_dataSource, null!, null!, null!);
        _credentials = new LocalCredentialStore(_dataSource, new EphemeralDataProtectionProvider());
        _links = new LocalAccountLinkStore(_dataSource);

        Assert.True(await CreateAccountAsync(Alpha, "alpha@example.test"));
    }

    public async ValueTask DisposeAsync() => await _dataSource.DisposeAsync();

    [Fact]
    public async Task An_account_is_found_by_email_across_tenants_and_emails_are_unique_install_wide()
    {
        var found = await _accounts.FindByEmailAsync("alpha@example.test", Cancellation);

        Assert.NotNull(found);
        Assert.Equal(Alpha, found.PrincipalId);
        Assert.True(await _accounts.AnyAsync(Cancellation));
        Assert.False(await CreateAccountAsync(Beta, "alpha@example.test"));
        Assert.Null(await _accounts.FindByEmailAsync("nobody@example.test", Cancellation));
    }

    [Fact]
    public async Task Ten_failures_pause_the_account_and_a_password_change_lifts_the_pause()
    {
        for (var i = 0; i < 9; i++)
        {
            Assert.Null(await _accounts.RegisterFailureAsync(Alpha, Cancellation));
        }

        var until = await _accounts.RegisterFailureAsync(Alpha, Cancellation);

        Assert.NotNull(until);
        Assert.True(until > DateTimeOffset.UtcNow.AddMinutes(4));
        Assert.True((await _accounts.FindByEmailAsync("alpha@example.test", Cancellation))!.IsPaused(DateTimeOffset.UtcNow));

        Assert.True(await _accounts.SetPasswordAsync(Alpha, "$argon2id$stub", changed: true, Cancellation));
        Assert.False((await _accounts.FindByEmailAsync("alpha@example.test", Cancellation))!.IsPaused(DateTimeOffset.UtcNow));
    }

    [Fact]
    public async Task The_hash_mix_counts_carried_over_bcrypt_and_setup_refuses_an_install_with_two_tenants()
    {
        Assert.True(await _accounts.SetPasswordAsync(Alpha, "$2a$14$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW", changed: true, Cancellation));

        var mix = await _accounts.HashMixAsync(Cancellation);

        Assert.Equal((1, 14), (mix.Bcrypt, mix.BcryptCost));
        Assert.Null(await _accounts.FindSessionAsync(BrowserSessionId.From(Guid.NewGuid()), Cancellation));
        await using var command = _dataSource.CreateCommand("SELECT nix_local_setup_tenant()");
        Assert.Equal(DBNull.Value, await command.ExecuteScalarAsync(Cancellation));
    }

    [Fact]
    public async Task A_link_works_once_and_a_newer_link_replaces_an_unused_one()
    {
        var first = LocalLinkToken.Mint();
        var second = LocalLinkToken.Mint();
        var expires = DateTimeOffset.UtcNow.AddHours(1);
        Assert.True(await _links.CreateAsync(Alpha, LocalLinkPurpose.Setup, first.Hash, expires, null, Cancellation));
        Assert.True(await _links.CreateAsync(Alpha, LocalLinkPurpose.Reset, second.Hash, expires, null, Cancellation));

        Assert.Null(await _links.FindAsync(first.Hash, Cancellation));
        Assert.Equal(LocalLinkPurpose.Reset, (await _links.FindAsync(second.Hash, Cancellation))!.Purpose);
        Assert.NotNull(await _links.ConsumeAsync(second.Hash, Cancellation));
        Assert.Null(await _links.ConsumeAsync(second.Hash, Cancellation));
        Assert.Null(await _links.FindAsync(second.Hash, Cancellation));
    }

    [Fact]
    public async Task An_expired_link_is_unknown()
    {
        var token = LocalLinkToken.Mint();
        Assert.True(await _links.CreateAsync(Alpha, LocalLinkPurpose.Reset, token.Hash, DateTimeOffset.UtcNow.AddSeconds(-1), null, Cancellation));

        Assert.Null(await _links.FindAsync(token.Hash, Cancellation));
        Assert.Null(await _links.ConsumeAsync(token.Hash, Cancellation));
    }

    [Fact]
    public async Task An_authenticator_code_step_is_accepted_once_and_only_in_order()
    {
        Assert.True(await _credentials.SetPendingTotpAsync(Alpha, [1, 2, 3, 4], Cancellation));
        Assert.False(await _credentials.UseTotpStepAsync(Alpha, 100, Cancellation));

        Assert.True(await _credentials.ConfirmTotpAsync(Alpha, 100, Cancellation));
        Assert.False(await _credentials.UseTotpStepAsync(Alpha, 100, Cancellation));
        Assert.False(await _credentials.UseTotpStepAsync(Alpha, 99, Cancellation));
        Assert.True(await _credentials.UseTotpStepAsync(Alpha, 101, Cancellation));

        var stored = await _credentials.GetTotpAsync(Alpha, Cancellation);
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, stored!.Secret.ToArray());
        Assert.Equal(101, stored.LastUsedStep);
    }

    [Fact]
    public async Task A_challenge_is_taken_once_and_five_wrong_answers_end_it()
    {
        var id = Guid.CreateVersion7();
        Assert.True(await _links.CreateAsync(id, LocalChallengeKind.SecondStep, Alpha, "state", "/home", null, DateTimeOffset.UtcNow.AddMinutes(5), Cancellation));

        Assert.NotNull(await _links.GetAsync(id, LocalChallengeKind.SecondStep, Cancellation));
        Assert.Null(await _links.GetAsync(id, LocalChallengeKind.PasskeySignIn, Cancellation));
        for (var i = 0; i < 5; i++)
        {
            await _links.BumpAsync(id, Cancellation);
        }

        Assert.Null(await _links.TakeAsync(id, LocalChallengeKind.SecondStep, Cancellation));

        var other = Guid.CreateVersion7();
        Assert.True(await _links.CreateAsync(other, LocalChallengeKind.PasskeySignIn, null, "{}", null, null, DateTimeOffset.UtcNow.AddMinutes(5), Cancellation));
        Assert.NotNull(await _links.TakeAsync(other, LocalChallengeKind.PasskeySignIn, Cancellation));
        Assert.Null(await _links.TakeAsync(other, LocalChallengeKind.PasskeySignIn, Cancellation));
    }

    [Fact]
    public async Task Passkeys_are_found_by_credential_id_and_removed_by_their_owner_only()
    {
        var passkey = new LocalPasskeyRecord(
            Guid.CreateVersion7(), new byte[] { 9, 9, 9 }, new byte[] { 1 }, 0, null, ["internal"], "nix.example", LocalPasskeyKind.Passkey, "Laptop", DateTimeOffset.UtcNow, null);
        Assert.True(await _credentials.AddPasskeyAsync(Alpha, passkey, Cancellation));
        Assert.False(await _credentials.AddPasskeyAsync(Alpha, passkey with { Id = Guid.CreateVersion7() }, Cancellation));

        var owner = await _credentials.FindPasskeyAsync(new byte[] { 9, 9, 9 }, Cancellation);
        Assert.Equal(Alpha, owner!.PrincipalId);

        Assert.False(await _credentials.RemovePasskeyAsync(Beta, passkey.Id, Cancellation));
        Assert.True(await _credentials.RemovePasskeyAsync(Alpha, passkey.Id, Cancellation));
    }

    private async Task<bool> CreateAccountAsync(PrincipalId principal, string email)
    {
        var connection = await fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand("SELECT nix_local_create_account(@principal, @email, NULL)", connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddWithValue("principal", principal.Value);
                command.Parameters.AddWithValue("email", email);
                return (bool)(await command.ExecuteScalarAsync(Cancellation))!;
            }
        }
    }
}
