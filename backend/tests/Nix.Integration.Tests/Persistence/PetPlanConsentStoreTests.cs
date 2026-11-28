using System.Text.Json;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Pets;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class PetPlanConsentStoreTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;
    private static readonly NixSessionContext OwnerContext = NixSessionContext.ForTenant(TenantId.From(TestTenants.Alpha), PrincipalId.From(TestTenants.AlphaPrincipal));
    private static readonly WorkspaceId Workspace = WorkspaceId.From(TestTenants.AlphaWorkspace);
    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Owner_retention_covers_handoffs_across_workspaces()
    {
        var now = DateTimeOffset.UtcNow;
        var other = WorkspaceId.Create();
        await using (var connection = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO workspace(workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                    storage_quota_bytes, created_at, lifecycle_state)
                VALUES('{other.Value:D}','{TestTenants.Alpha:D}','Other fixture workspace',30,0,1073741824,now(),'active');
                INSERT INTO workspace_member(workspace_id,subject_type,subject_id,tenant_id,role,granted_by,granted_at)
                VALUES('{other.Value:D}','principal','{TestTenants.AlphaPrincipal:D}','{TestTenants.Alpha:D}',
                    'editor','{TestTenants.AlphaPrincipal:D}',now());
                """);
        }
        var firstRun = await CreateRun(now);
        var secondRun = await CreateRun(now, other);
        var contexts = Enumerable.Range(0, 150).Select(index => new PetPlanDecisionContextRecord(Guid.NewGuid(),
            index % 2 == 0 ? Workspace : other, index % 2 == 0 ? firstRun : secondRun, Guid.NewGuid(), 1, "fixture-review",
            Guid.NewGuid(), "Fixture CLI", true, index.ToString("x64", System.Globalization.CultureInfo.InvariantCulture), now.AddMinutes(4))).ToArray();
        await InSession(OwnerContext, async store =>
        {
            foreach (var context in contexts)
            {
                Assert.True(await store.CreateContextAsync(context, Cancellation));
                await store.CleanupAsync(now, Cancellation);
            }
            var retainedContexts = 0;
            foreach (var context in contexts)
            {
                if (await store.ReadContextAsync(context.Id, Cancellation) is not null)
                {
                    retainedContexts++;
                }
            }
            Assert.Equal(100, retainedContexts);
            return true;
        });
    }

    [Fact]
    public async Task Every_sequential_and_concurrent_key_replacement_has_a_distinct_persisted_revision()
    {
        var suppliedAt = new DateTimeOffset(2026, 1, 2, 3, 4, 5, TimeSpan.Zero);
        async Task<PetProviderCredential> Replace(string hint)
        {
            await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            var store = work.Resolve<IPetProviderCredentialStore>();
            var value = new PetProviderCredential
            {
                TenantId = TenantId.From(TestTenants.Alpha),
                PrincipalId = PrincipalId.From(TestTenants.AlphaPrincipal),
                Provider = "anthropic",
                ProtectedKey = System.Text.Encoding.UTF8.GetBytes("fixture-protected-" + hint),
                KeyHint = hint,
                SavedAt = suppliedAt,
            };
            await store.SaveAsync(value, Cancellation);
            var persisted = await store.FindAsync(value.TenantId, value.PrincipalId, value.Provider, Cancellation);
            Assert.NotNull(persisted);
            Assert.Equal(hint, persisted.KeyHint);
            Assert.True(value.ProtectedKey.Span.SequenceEqual(persisted.ProtectedKey.Span));
            await work.CommitAsync(Cancellation);
            return persisted;
        }
        var first = await Replace("one");
        var second = await Replace("two");
        Assert.Equal(suppliedAt, first.SavedAt);
        Assert.True(second.SavedAt > first.SavedAt);
        var raced = await Task.WhenAll(Replace("left"), Replace("right"));
        Assert.NotEqual(raced[0].SavedAt, raced[1].SavedAt);
        Assert.All(raced, value => Assert.True(value.SavedAt > second.SavedAt));
    }

    [Fact]
    public async Task Exact_delegation_is_pending_until_browser_authority_and_is_atomically_one_use()
    {
        var now = DateTimeOffset.UtcNow;
        var run = await CreateRun(now);
        var credential = Guid.NewGuid();
        var context = new PetPlanDecisionContextRecord(Guid.NewGuid(), Workspace, run, Guid.NewGuid(), 2,
            "review-digest", credential, "Fixture CLI", true, new string('c', 64), now.AddMinutes(4));
        Assert.True(await InSession(OwnerContext, store => store.CreateContextAsync(context, Cancellation)));
        var request = Guid.NewGuid();
        Task<PetPlanDecisionContextRecord?> Consume(Guid requestId, Guid? grantee = null, int version = 2, string digest = "review-digest", bool approve = true, DateTimeOffset? at = null) =>
            InSession(OwnerContext, store => store.ConsumeContextAsync(context.SecretHash, Workspace,
                run, context.PlanId, version, digest, approve, grantee ?? credential, requestId, at ?? now, Cancellation));
        Assert.Null(await Consume(request));
        Assert.True(await InSession(OwnerContext, store => store.AuthorizeContextAsync(context, Guid.NewGuid(), now, Cancellation)));
        Assert.Null(await Consume(request, grantee: Guid.NewGuid()));
        Assert.Null(await Consume(request, version: 1));
        Assert.Null(await Consume(request, digest: "changed"));
        Assert.Null(await Consume(request, approve: false));
        Assert.Null(await Consume(request, at: now.AddMinutes(5)));
        var raced = await Task.WhenAll(Consume(request), Consume(Guid.NewGuid()));
        var winner = Assert.Single(raced, result => result is not null)!;
        Assert.NotNull(winner.AuthorityId);
        Assert.NotNull(await Consume(winner.ConsumedRequestId!.Value));
        Assert.Null(await Consume(Guid.NewGuid()));
        Assert.Null(await InSession(TestTenants.BetaContext, store => store.ReadContextAsync(context.Id, Cancellation)));
    }

    [Fact]
    public async Task Revocation_stops_an_authorized_context()
    {
        var now = DateTimeOffset.UtcNow;
        var run = await CreateRun(now);
        var context = new PetPlanDecisionContextRecord(Guid.NewGuid(), Workspace, run, Guid.NewGuid(), 1,
            "digest", Guid.NewGuid(), "Fixture CLI", true, new string('d', 64), now.AddMinutes(4));
        Assert.True(await InSession(OwnerContext, store => store.CreateContextAsync(context, Cancellation)));
        Assert.True(await InSession(OwnerContext, store => store.AuthorizeContextAsync(context, Guid.NewGuid(), now, Cancellation)));
        Assert.True(await InSession(OwnerContext, store => store.RevokeContextAsync(context.Id, now, Cancellation)));
        Assert.Null(await InSession(OwnerContext, store => store.ConsumeContextAsync(context.SecretHash, Workspace,
            run, context.PlanId, 1, "digest", true, context.GranteeCredentialId, Guid.NewGuid(), now, Cancellation)));
    }

    private async Task<Guid> CreateRun(DateTimeOffset now, WorkspaceId? workspaceId = null)
    {
        using var state = JsonDocument.Parse("{}");
        var target = workspaceId ?? Workspace;
        var run = new PetRunRecord(Guid.NewGuid(), target == Workspace ? ItemId.From(M0SchemaSeed.Alpha.ItemId) : (ItemId?)null, target,
            TenantId.From(TestTenants.Alpha), PrincipalId.From(TestTenants.AlphaPrincipal), "Fixture plan", [], false, [],
            "queued", 1, state.RootElement, now, now);
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(OwnerContext, Cancellation);
        Assert.True(await work.Resolve<IPetRunStore>().CreateAsync(run, Cancellation));
        await work.CommitAsync(Cancellation);
        return run.Id;
    }

    private async Task<T> InSession<T>(NixSessionContext context, Func<IPetPlanConsentStore, Task<T>> operation)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        var result = await operation(work.Resolve<IPetPlanConsentStore>());
        await work.CommitAsync(Cancellation);
        return result;
    }
}
