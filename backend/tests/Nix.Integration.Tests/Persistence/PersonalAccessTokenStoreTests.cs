using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The token store against a live database: the pre-authentication resolver working without a
/// session, tenant isolation on the table, and the principal predicate keeping one person's
/// credentials out of another's reach.
/// </summary>
/// <remarks>
/// Two tenants, and inside the first tenant a second principal in the same workspace - the same
/// two boundaries the bookmark suite draws, because a token is personal state with a sharper
/// edge: a row read across either boundary here is a credential's metadata, and a revocation
/// that reaches across it would let a neighbour end somebody else's access.
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class PersonalAccessTokenStoreTests : IAsyncLifetime
{
    /// <summary>A second principal in Alpha's tenant, sharing the workspace.</summary>
    private static readonly Guid Neighbour = new("9a1a1000-4444-4444-8444-9a1a10000001");

    private readonly NixPostgresFixture _fixture;

    public PersonalAccessTokenStoreTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static NixSessionContext OwnerContext => TestTenants.AlphaContext;

    private static NixSessionContext NeighbourContext => TestTenants.ContextFor(
        M0SchemaSeed.Alpha.TenantId,
        M0SchemaSeed.Alpha.WorkspaceId,
        Neighbour);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedNeighbourAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_minted_token_resolves_for_exchange_with_no_session_established()
    {
        var minted = await MintAsync(OwnerContext, "ci-runner", [AccessTokenScopes.Read], days: 30);

        // No unit of work, no session context, no transaction: exactly the state the exchange
        // endpoint is in. Row-level security would answer nothing here; the security-definer
        // resolver is what makes this read possible, and this test is what proves that.
        var scope = _fixture.Application.CreateUnscopedScope();
        await using (scope.ConfigureAwait(false))
        {
            var tokens = scope.ServiceProvider.GetRequiredService<IPersonalAccessTokens>();
            Assert.True(PersonalAccessTokenSecret.TryReadLookup(minted.Secret, out var lookup));

            var candidate = await tokens.FindForExchangeAsync(lookup, Cancellation);

            Assert.NotNull(candidate);
            Assert.Equal(minted.Row.Id, candidate.Id);
            Assert.Equal(M0SchemaSeed.Alpha.TenantId, candidate.TenantId.Value);
            Assert.Equal(M0SchemaSeed.Alpha.PrincipalId, candidate.PrincipalId.Value);
            Assert.Equal(PrincipalStatus.Active, candidate.PrincipalStatus);
            Assert.Equal([AccessTokenScopes.Read], candidate.Scopes);
            Assert.True(PersonalAccessTokenSecret.Matches(candidate.SecretHash, minted.Secret));
        }
    }

    [Fact]
    public async Task An_unknown_lookup_resolves_to_nothing()
    {
        var scope = _fixture.Application.CreateUnscopedScope();
        await using (scope.ConfigureAwait(false))
        {
            var tokens = scope.ServiceProvider.GetRequiredService<IPersonalAccessTokens>();

            Assert.Null(await tokens.FindForExchangeAsync("aaaaaaaaaaaa", Cancellation));
        }
    }

    /// <summary>
    /// The crown jewel inside one tenant. Same tenant, same workspace - row-level security has
    /// nothing to say, and only the statement's principal predicate separates the two.
    /// </summary>
    [Fact]
    public async Task One_principal_never_lists_another_s_tokens()
    {
        await MintAsync(OwnerContext, "owners-token", [AccessTokenScopes.Read], days: 30);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(NeighbourContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var listed = await work.Resolve<IPersonalAccessTokens>().ListOwnAsync(Cancellation);

            Assert.Empty(listed);
        }
    }

    [Fact]
    public async Task Revocation_cannot_reach_another_principal_s_token()
    {
        var minted = await MintAsync(OwnerContext, "owners-token", [AccessTokenScopes.Read], days: 30);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(NeighbourContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var tokens = work.Resolve<IPersonalAccessTokens>();

            var revoked = await tokens.RevokeOwnAsync(minted.Row.Id, DateTimeOffset.UtcNow, Cancellation);

            Assert.False(revoked);
            await work.CommitAsync(Cancellation);
        }

        var state = await SessionStateAsync(OwnerContext, minted.Row.Id);
        Assert.NotNull(state);
        Assert.Null(state.RevokedAt);
    }

    [Fact]
    public async Task Revoking_your_own_token_lands_and_revoking_it_again_changes_nothing()
    {
        var minted = await MintAsync(OwnerContext, "short-lived", [AccessTokenScopes.Write], days: 7);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(OwnerContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var tokens = work.Resolve<IPersonalAccessTokens>();

            Assert.True(await tokens.RevokeOwnAsync(minted.Row.Id, DateTimeOffset.UtcNow, Cancellation));
            Assert.False(await tokens.RevokeOwnAsync(minted.Row.Id, DateTimeOffset.UtcNow, Cancellation));
            await work.CommitAsync(Cancellation);
        }

        var state = await SessionStateAsync(OwnerContext, minted.Row.Id);
        Assert.NotNull(state);
        Assert.NotNull(state.RevokedAt);
    }

    [Fact]
    public async Task The_live_count_excludes_what_is_revoked()
    {
        // The neighbour rather than the seeded principal: the schema seed already gives the
        // seeded principal one live token per tenant, and a count test wants to own its numbers.
        var keeper = await MintAsync(NeighbourContext, "keeper", [AccessTokenScopes.Read], days: 30);
        var doomed = await MintAsync(NeighbourContext, "doomed", [AccessTokenScopes.Read], days: 30);
        _ = keeper;

        var work = await _fixture.Application.BeginUnitOfWorkAsync(NeighbourContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var tokens = work.Resolve<IPersonalAccessTokens>();
            await tokens.RevokeOwnAsync(doomed.Row.Id, DateTimeOffset.UtcNow, Cancellation);

            Assert.Equal(1, await tokens.CountLiveAsync(DateTimeOffset.UtcNow, Cancellation));
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task The_list_keeps_revoked_tokens_because_it_is_an_audit()
    {
        var minted = await MintAsync(NeighbourContext, "audited", [AccessTokenScopes.Read], days: 30);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(NeighbourContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var tokens = work.Resolve<IPersonalAccessTokens>();
            await tokens.RevokeOwnAsync(minted.Row.Id, DateTimeOffset.UtcNow, Cancellation);

            var listed = await tokens.ListOwnAsync(Cancellation);

            var row = Assert.Single(listed);
            Assert.NotNull(row.RevokedAt);
            await work.CommitAsync(Cancellation);
        }
    }

    /// <summary>
    /// The cross-tenant backstop: a session established for the other tenant queries the whole
    /// table, and row-level security is the only thing left to answer with silence.
    /// </summary>
    [Fact]
    public async Task One_tenant_never_reads_another_tenant_s_tokens()
    {
        await MintAsync(OwnerContext, "alpha-token", [AccessTokenScopes.Read], days: 30);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var all = await work.Resolve<NixDbContext>().PersonalAccessTokens
                .ToListAsync(Cancellation);

            // Beta's own seeded credential and nothing else: the whole-table query is exactly
            // the read row-level security exists to answer with silence about the other tenant.
            var row = Assert.Single(all);
            Assert.Equal(M0SchemaSeed.Beta.TenantId, row.TenantId.Value);
        }
    }

    [Fact]
    public async Task Touching_records_when_the_token_last_authenticated()
    {
        var minted = await MintAsync(OwnerContext, "touched", [AccessTokenScopes.Read], days: 30);
        var at = DateTimeOffset.UtcNow;

        var work = await _fixture.Application.BeginUnitOfWorkAsync(OwnerContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            await work.Resolve<IPersonalAccessTokens>().TouchAsync(minted.Row.Id, at, Cancellation);
            await work.CommitAsync(Cancellation);
        }

        var state = await SessionStateAsync(OwnerContext, minted.Row.Id);
        Assert.NotNull(state);
        Assert.NotNull(state.LastUsedAt);
    }

    [Fact]
    public async Task The_mint_refuses_a_twenty_sixth_live_token()
    {
        for (var index = 0; index < PersonalAccessToken.MaximumLiveTokensPerPrincipal; index++)
        {
            await MintAsync(NeighbourContext, $"token-{index}", [AccessTokenScopes.Read], days: 30);
        }

        var work = await _fixture.Application.BeginUnitOfWorkAsync(NeighbourContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .SendAsync<CreateAccessToken, IssuedAccessToken>(
                    new CreateAccessToken("one-too-many", [AccessTokenScopes.Read], 30),
                    Cancellation);

            Assert.True(result.IsFailure);
            Assert.Equal(TokenErrors.LimitReachedCode, result.Error.Code);
        }
    }

    [Fact]
    public async Task Rotation_swaps_the_secret_in_place_and_restarts_the_original_lifetime()
    {
        var minted = await MintAsync(OwnerContext, "rotating", [AccessTokenScopes.Read, AccessTokenScopes.Write], days: 30);

        var rotated = await RotateAsync(OwnerContext, minted.Row.Id);

        Assert.True(rotated.IsSuccess, rotated.IsFailure ? rotated.Error.Message : string.Empty);
        Assert.Equal(minted.Row.Id, rotated.Value.Row.Id);
        Assert.Equal(minted.Row.Name, rotated.Value.Row.Name);
        Assert.Equal(minted.Row.Scopes, rotated.Value.Row.Scopes);
        Assert.NotEqual(minted.Secret, rotated.Value.Secret);
        Assert.InRange(
            (rotated.Value.Row.ExpiresAt - DateTimeOffset.UtcNow).TotalDays,
            29.9,
            30.1);

        // A second rotation measures the same 30 days, not the stretch since first issue.
        Assert.Equal(
            rotated.Value.Row.ExpiresAt - rotated.Value.Row.CreatedAt,
            minted.Row.ExpiresAt - minted.Row.CreatedAt);

        Assert.False(await ResolvesAsync(minted.Secret));
        Assert.True(await ResolvesAsync(rotated.Value.Secret));
    }

    [Fact]
    public async Task Rotation_refuses_a_revoked_token_and_another_principal_s_token()
    {
        var minted = await MintAsync(OwnerContext, "rotation-refused", [AccessTokenScopes.Read], days: 30);

        var foreign = await RotateAsync(NeighbourContext, minted.Row.Id);
        Assert.Equal(TokenErrors.NotFoundCode, foreign.Error.Code);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(OwnerContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            await work.Resolve<IPersonalAccessTokens>()
                .RevokeOwnAsync(minted.Row.Id, DateTimeOffset.UtcNow, Cancellation);
            await work.CommitAsync(Cancellation);
        }

        var revoked = await RotateAsync(OwnerContext, minted.Row.Id);
        Assert.Equal(TokenErrors.NotRotatableCode, revoked.Error.Code);
        Assert.True(await ResolvesAsync(minted.Secret));
    }

    [Fact]
    public async Task Rotation_refuses_an_expired_token()
    {
        var minted = await MintAsync(OwnerContext, "rotation-expired", [AccessTokenScopes.Read], days: 30);
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"UPDATE personal_access_token SET expires_at = now() - interval '1 minute' "
                + $"WHERE token_id = '{minted.Row.Id.Value:D}'::uuid;");
        }

        var result = await RotateAsync(OwnerContext, minted.Row.Id);

        Assert.Equal(TokenErrors.NotRotatableCode, result.Error.Code);
    }

    private async Task<Result<IssuedAccessToken>> RotateAsync(NixSessionContext context, PersonalAccessTokenId id)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .SendAsync<RotateAccessToken, IssuedAccessToken>(new RotateAccessToken(id), Cancellation);
            await work.CommitAsync(Cancellation);
            return result;
        }
    }

    /// <summary>Whether a presented token still finds a row whose hash it matches.</summary>
    private async Task<bool> ResolvesAsync(string secret)
    {
        var scope = _fixture.Application.CreateUnscopedScope();
        await using (scope.ConfigureAwait(false))
        {
            Assert.True(PersonalAccessTokenSecret.TryReadLookup(secret, out var lookup));
            var candidate = await scope.ServiceProvider.GetRequiredService<IPersonalAccessTokens>()
                .FindForExchangeAsync(lookup, Cancellation);
            return candidate is not null && PersonalAccessTokenSecret.Matches(candidate.SecretHash, secret);
        }
    }

    private async Task<IssuedAccessToken> MintAsync(
        NixSessionContext context,
        string name,
        IReadOnlyList<string> scopes,
        int days)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .SendAsync<CreateAccessToken, IssuedAccessToken>(
                    new CreateAccessToken(name, scopes, days),
                    Cancellation);

            Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
            await work.CommitAsync(Cancellation);
            return new IssuedAccessToken(result.Value.Row, result.Value.Secret);
        }
    }

    private async Task<AccessTokenSessionState?> SessionStateAsync(
        NixSessionContext context,
        PersonalAccessTokenId id)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<IPersonalAccessTokens>().FindSessionStateAsync(id, Cancellation);
        }
    }

    private async Task SeedNeighbourAsync()
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var granter = Literal(M0SchemaSeed.Alpha.PrincipalId);

        var sql = $"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status,
                 deprovisioned_at)
            VALUES ({Literal(Neighbour)}, {tenant}, 'alpha-token-neighbour', 'user', 'Neighbour',
                    'token-neighbour@example.test', 'active', NULL);

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ({workspace}, 'principal', {Literal(Neighbour)}, {tenant}, 'editor', {granter}, now());
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private static string Literal(Guid value) =>
        $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
