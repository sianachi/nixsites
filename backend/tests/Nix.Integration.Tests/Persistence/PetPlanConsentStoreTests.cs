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
    private static readonly Guid Pet = Guid.NewGuid();
    private static readonly string ScopeDigest = new('a', 64);
    private static readonly string RecipientRevision = new('b', 64);
    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_question_is_inert_and_old_approval_cannot_undo_a_later_refusal()
    {
        var now = DateTimeOffset.UtcNow;
        var approval = NewConsent(Pet, now);
        var first = await InSession(OwnerContext, store => store.PrepareQuestionAsync(Workspace, Pet, ScopeDigest, RecipientRevision, now, Cancellation));
        Assert.Null(await Find(Pet));
        var repeated = await InSession(OwnerContext, store => store.PrepareQuestionAsync(Workspace, Pet, ScopeDigest, RecipientRevision, now.AddMinutes(1), Cancellation));
        Assert.Equal(first, repeated);
        Assert.True(await InSession(OwnerContext, store => store.DecideAsync(approval, first.DecisionNonce, Cancellation)));
        var original = await Find(Pet);
        Assert.NotNull(original);
        Assert.True(await InSession(OwnerContext, store => store.DecideAsync(approval with
        {
            GrantedAt = now.AddMinutes(2),
            ExpiresAt = now.AddMinutes(2).AddDays(30)
        }, first.DecisionNonce, Cancellation)));
        Assert.Equal(original, await Find(Pet));
        Assert.False(await InSession(OwnerContext, store => store.DecideAsync(approval with { RevokedAt = now }, first.DecisionNonce, Cancellation)));

        var second = await InSession(OwnerContext, store => store.PrepareQuestionAsync(Workspace, Pet, ScopeDigest, RecipientRevision, now.AddMinutes(3), Cancellation));
        Assert.NotEqual(first.DecisionNonce, second.DecisionNonce);
        Assert.Equal(original, await Find(Pet));
        var refusal = NewConsent(Pet, now.AddMinutes(4)) with { RevokedAt = now.AddMinutes(4) };
        Assert.True(await InSession(OwnerContext, store => store.DecideAsync(refusal, second.DecisionNonce, Cancellation)));
        var revoked = await Find(Pet);
        Assert.NotNull(revoked);
        Assert.NotNull(revoked.RevokedAt);
        Assert.False(await InSession(OwnerContext, store => store.DecideAsync(approval, first.DecisionNonce, Cancellation)));
        Assert.Equal(revoked, await Find(Pet));
        Assert.True(await InSession(OwnerContext, store => store.DecideAsync(refusal with
        {
            GrantedAt = now.AddMinutes(5),
            ExpiresAt = now.AddMinutes(5).AddDays(30)
        }, second.DecisionNonce, Cancellation)));
        Assert.Equal(revoked, await Find(Pet));
        var third = await InSession(OwnerContext, store => store.PrepareQuestionAsync(Workspace, Pet, ScopeDigest, RecipientRevision, now.AddMinutes(6), Cancellation));
        Assert.False(await InSession(OwnerContext, store => store.DecideAsync(refusal with { RevokedAt = null }, third.DecisionNonce, Cancellation)));
        Assert.False(await InSession(OwnerContext, store => store.DecideAsync(NewConsent(Pet, now.AddMinutes(37)), third.DecisionNonce, Cancellation)));
        var renewed = await InSession(OwnerContext, store => store.PrepareQuestionAsync(Workspace, Pet, ScopeDigest, RecipientRevision, now.AddMinutes(37), Cancellation));
        Assert.NotEqual(third.DecisionNonce, renewed.DecisionNonce);
        Assert.False(await InSession(OwnerContext, store => store.DecideAsync(approval, first.DecisionNonce, Cancellation)));
        Assert.Equal(revoked, await Find(Pet));
    }

    [Fact]
    public async Task An_evicted_decision_cannot_recreate_authority_even_after_a_new_question()
    {
        var now = DateTimeOffset.UtcNow;
        var approval = NewConsent(Pet, now);
        var first = await InSession(OwnerContext, store => store.PrepareQuestionAsync(Workspace, Pet, ScopeDigest, RecipientRevision, now, Cancellation));
        Assert.True(await InSession(OwnerContext, store => store.DecideAsync(approval, first.DecisionNonce, Cancellation)));
        var second = await InSession(OwnerContext, store => store.PrepareQuestionAsync(Workspace, Pet, ScopeDigest, RecipientRevision, now.AddSeconds(1), Cancellation));
        var refusal = NewConsent(Pet, now.AddSeconds(2)) with { RevokedAt = now.AddSeconds(2) };
        Assert.True(await InSession(OwnerContext, store => store.DecideAsync(refusal, second.DecisionNonce, Cancellation)));
        await InSession(OwnerContext, async store =>
        {
            for (var index = 0; index < 100; index++)
            {
                await store.PrepareQuestionAsync(Workspace, Guid.NewGuid(), ScopeDigest, RecipientRevision, now.AddSeconds(index + 3), Cancellation);
            }
            return true;
        });
        Assert.Null(await Find(Pet));
        Assert.False(await InSession(OwnerContext, store => store.DecideAsync(approval, first.DecisionNonce, Cancellation)));
        Assert.False(await InSession(OwnerContext, store => store.DecideAsync(refusal, second.DecisionNonce, Cancellation)));
        Assert.Null(await Find(Pet));
        var replacement = await InSession(OwnerContext, store => store.PrepareQuestionAsync(Workspace, Pet, ScopeDigest, RecipientRevision, now.AddMinutes(3), Cancellation));
        Assert.NotEqual(first.Id, replacement.Id);
        Assert.NotEqual(first.DecisionNonce, replacement.DecisionNonce);
        Assert.Null(await Find(Pet));
        Assert.False(await InSession(OwnerContext, store => store.DecideAsync(approval, first.DecisionNonce, Cancellation)));
        Assert.Null(await Find(Pet));
        Assert.True(await InSession(OwnerContext, store => store.DecideAsync(NewConsent(Pet, now.AddMinutes(4)), replacement.DecisionNonce, Cancellation)));
    }

    [Fact]
    public async Task A_nonce_accepts_only_one_new_request_and_is_bound_to_the_exact_source_and_recipient()
    {
        var now = DateTimeOffset.UtcNow;
        var question = await InSession(OwnerContext, store => store.PrepareQuestionAsync(Workspace, Pet, ScopeDigest, RecipientRevision, now, Cancellation));
        var first = NewConsent(Pet, now);
        Assert.False(await InSession(OwnerContext, store => store.DecideAsync(first with { ScopeDigest = new string('e', 64) }, question.DecisionNonce, Cancellation)));
        Assert.False(await InSession(OwnerContext, store => store.DecideAsync(first with { RecipientRevision = new string('f', 64) }, question.DecisionNonce, Cancellation)));
        Assert.False(await InSession(OwnerContext, store => store.DecideAsync(first, Guid.Empty, Cancellation)));
        var second = NewConsent(Pet, now);
        var outcomes = await Task.WhenAll(
            InSession(OwnerContext, store => store.DecideAsync(first, question.DecisionNonce, Cancellation)),
            InSession(OwnerContext, store => store.DecideAsync(second, question.DecisionNonce, Cancellation)));
        Assert.Single(outcomes, accepted => accepted);
        var recorded = await Find(Pet);
        Assert.NotNull(recorded);
        Assert.Contains(recorded.RequestId, new[] { first.RequestId, second.RequestId });
    }

    [Fact]
    public async Task Owner_retention_covers_questions_and_handoffs_across_workspaces()
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
        var grants = Enumerable.Range(0, 150).Select(index => NewConsent(Guid.NewGuid(), now.AddSeconds(index))
            with
        { WorkspaceId = index % 2 == 0 ? Workspace : other }).ToArray();
        var contexts = Enumerable.Range(0, 150).Select(index => new PetPlanDecisionContextRecord(Guid.NewGuid(),
            index % 2 == 0 ? Workspace : other, index % 2 == 0 ? firstRun : secondRun, Guid.NewGuid(), 1, "fixture-review",
            Guid.NewGuid(), "Fixture CLI", true, index.ToString("x64", System.Globalization.CultureInfo.InvariantCulture), now.AddMinutes(4))).ToArray();
        await InSession(OwnerContext, async store =>
        {
            foreach (var grant in grants)
            {
                Assert.True(await GrantAsync(store, grant));
            }
            foreach (var context in contexts)
            {
                Assert.True(await store.CreateContextAsync(context, Cancellation));
                await store.CleanupAsync(now, Cancellation);
            }
            var retainedGrants = 0;
            var retainedContexts = 0;
            foreach (var grant in grants)
            {
                if (await store.FindAsync(grant.WorkspaceId, grant.PetId, ScopeDigest, RecipientRevision, Cancellation) is not null)
                {
                    retainedGrants++;
                }
            }
            foreach (var context in contexts)
            {
                if (await store.ReadContextAsync(context.Id, Cancellation) is not null)
                {
                    retainedContexts++;
                }
            }
            Assert.Equal(100, retainedGrants);
            Assert.Equal(100, retainedContexts);
            return true;
        });
    }

    [Fact]
    public async Task Concurrent_grant_transactions_preserve_the_owner_retention_bound()
    {
        var now = DateTimeOffset.UtcNow;
        var grants = Enumerable.Range(0, 150).Select(_ => new PetPlanConsentRecord(Guid.NewGuid(), Workspace,
            Guid.NewGuid(), ScopeDigest, RecipientRevision, Guid.NewGuid(), Guid.NewGuid(), now, now.AddDays(1))).ToArray();
        await Task.WhenAll(grants.Chunk(15).Select(batch => InSession(OwnerContext, async store =>
        {
            foreach (var grant in batch)
            {
                Assert.True(await GrantAsync(store, grant));
            }
            await store.CleanupAsync(now, Cancellation);
            return true;
        })));
        var retained = await InSession(OwnerContext, async store =>
        {
            var count = 0;
            foreach (var grant in grants)
            {
                if (await store.FindAsync(Workspace, grant.PetId, ScopeDigest, RecipientRevision, Cancellation) is not null)
                {
                    count++;
                }
            }
            return count;
        });
        Assert.Equal(100, retained);
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
    public async Task Consent_is_tenant_owner_and_workspace_private_and_expiry_is_bounded()
    {
        var now = DateTimeOffset.UtcNow;
        var grant = new PetPlanConsentRecord(Guid.NewGuid(), Workspace, Pet, ScopeDigest, RecipientRevision,
            Guid.NewGuid(), Guid.NewGuid(), now, now.AddDays(30));
        Assert.True(await InSession(OwnerContext, store => GrantAsync(store, grant)));
        Assert.NotNull(await InSession(OwnerContext, store => store.FindAsync(Workspace, Pet, ScopeDigest, RecipientRevision, Cancellation)));
        foreach (var context in new[] { TestTenants.BetaContext,
            TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, TestTenants.BetaPrincipal),
            TestTenants.ContextFor(TestTenants.Alpha, TestTenants.BetaWorkspace, TestTenants.AlphaPrincipal) })
        {
            Assert.Null(await InSession(context, store => store.FindAsync(Workspace, Pet, ScopeDigest, RecipientRevision, Cancellation)));
        }

        Assert.False(await InSession(OwnerContext, store => GrantAsync(store, grant with { ExpiresAt = now.AddDays(31) })));
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
    public async Task Revocation_stops_an_authorized_context_and_cleanup_bounds_retained_rows()
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
        var grants = Enumerable.Range(0, 105).Select(index => new PetPlanConsentRecord(Guid.NewGuid(), Workspace, Guid.NewGuid(),
            ScopeDigest, RecipientRevision, Guid.NewGuid(), Guid.NewGuid(), now.AddSeconds(index), now.AddSeconds(index).AddDays(1))).ToArray();
        await InSession(OwnerContext, async store =>
        {
            foreach (var grant in grants)
            {
                Assert.True(await GrantAsync(store, grant));
            }

            await store.CleanupAsync(now, Cancellation);
            return true;
        });
        var retained = 0;
        foreach (var grant in grants)
        {
            if (await InSession(OwnerContext, store => store.FindAsync(Workspace, grant.PetId, ScopeDigest, RecipientRevision, Cancellation)) is not null)
            {
                retained++;
            }
        }

        Assert.Equal(100, retained);
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

    private static PetPlanConsentRecord NewConsent(Guid petId, DateTimeOffset now) => new(Guid.NewGuid(), Workspace,
        petId, ScopeDigest, RecipientRevision, Guid.NewGuid(), Guid.NewGuid(), now, now.AddDays(30));

    private Task<PetPlanConsentRecord?> Find(Guid petId) => InSession(OwnerContext,
        store => store.FindAsync(Workspace, petId, ScopeDigest, RecipientRevision, Cancellation));

    private static async Task<bool> GrantAsync(IPetPlanConsentStore store, PetPlanConsentRecord consent)
    {
        var question = await store.PrepareQuestionAsync(consent.WorkspaceId, consent.PetId, consent.ScopeDigest,
            consent.RecipientRevision, consent.GrantedAt, Cancellation);
        return await store.DecideAsync(consent, question.DecisionNonce, Cancellation);
    }

    private async Task<T> InSession<T>(NixSessionContext context, Func<IPetPlanConsentStore, Task<T>> operation)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        var result = await operation(work.Resolve<IPetPlanConsentStore>());
        await work.CommitAsync(Cancellation);
        return result;
    }
}
