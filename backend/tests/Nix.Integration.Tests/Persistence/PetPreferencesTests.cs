using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Nix.Abstractions;
using Nix.Domain.Content;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Features.Items;
using Nix.Features.Locks;
using Nix.Features.Pets;
using Nix.Features.Workspaces;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Workspaces;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class PetPreferencesTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // These tests exercise first-write behavior, unlike the fully populated schema fixture.
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM pet_preferences");
        }
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Preferences_survive_a_new_request_and_refuse_stale_writes()
    {
        await SaveInitialAsync();
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var saved = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), Cancellation);
            Assert.Equal(1, saved.Revision);
            Assert.Equal("Owl", Assert.Single(saved.Settings.Profiles).Name);
            var conflict = await dispatcher.SendAsync<SavePetSettings, PetSettingsResponse>(new(0, saved.Settings), Cancellation);
            Assert.True(conflict.IsFailure);
            Assert.Equal("pets.settings_conflict", conflict.Error.Code);
            var updated = await dispatcher.SendAsync<SavePetSettings, PetSettingsResponse>(new(1, saved.Settings with { Motion = "reduced" }), Cancellation);
            Assert.True(updated.IsSuccess);
            Assert.Equal(2, updated.Value.Revision);
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Rls_hides_other_tenants_and_other_principals_even_from_unfiltered_queries()
    {
        await SaveInitialAsync();
        foreach (var context in new[] { TestTenants.BetaContext,
            TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, TestTenants.BetaPrincipal) })
        {
            var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                Assert.Empty(await work.DbContext.Set<PetPreferences>().AsNoTracking().ToListAsync(Cancellation));
                var store = work.Resolve<IPetPreferencesStore>();
                Assert.Null(await store.FindAsync(TestTenants.AlphaContext.TenantId, TestTenants.AlphaContext.PrincipalId, Cancellation));
            }
        }
    }

    [Fact]
    public async Task Rls_refuses_a_forged_owner_on_insert()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var error = await Assert.ThrowsAsync<PostgresException>(() => work.Resolve<IPetPreferencesStore>().SaveAsync(new PetPreferences
            {
                TenantId = TestTenants.BetaContext.TenantId,
                PrincipalId = TestTenants.BetaContext.PrincipalId,
                SettingsJson = "{}",
                Revision = 1,
            }, 0, Cancellation));
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, error.SqlState);
        }
    }

    private async Task SaveInitialAsync(bool enabled = false)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var id = Guid.NewGuid();
            var settings = new PetSettings(enabled, id, "system", [new(id, "Owl", "owl", "calm", "balanced", "")]);
            Result<PetSettingsResponse> saved = await work.Resolve<NixDispatcher>()
                .SendAsync<SavePetSettings, PetSettingsResponse>(new(0, settings), Cancellation);
            Assert.True(saved.IsSuccess);
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Companion_gateway_refuses_cross_tenant_workspaces_before_contacting_worker()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            using var handler = new RecordingWorker();
            using var http = new HttpClient(handler);
            var gateway = Gateway(work, http);
            foreach (var operation in new[] { "read", "send", "tool_claim", "tool_result" })
            {
                var result = await gateway.ExecuteAsync(new(operation, TestTenants.BetaWorkspace, Guid.NewGuid(), Guid.NewGuid(), "Test", ToolId: "tool-one"), Cancellation);
                Assert.True(result.IsFailure);
                Assert.Equal("pets.not_found", result.Error.Code);
            }
            Assert.Equal(0, handler.Calls);
        }
    }

    [Fact]
    public async Task Companion_gateway_derives_identity_and_saved_instructions_from_Core()
    {
        await SaveInitialAsync();
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            using var handler = new RecordingWorker();
            using var http = new HttpClient(handler);
            var dispatcher = work.Resolve<NixDispatcher>();
            var saved = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), Cancellation);
            var gateway = Gateway(work, http);
            var result = await gateway.ExecuteAsync(new("read", TestTenants.AlphaWorkspace, saved.Settings.ActivePetId), Cancellation);
            Assert.True(result.IsSuccess);
            Assert.Equal(1, handler.Calls);
            using var body = JsonDocument.Parse(handler.Body);
            Assert.Equal(TestTenants.Alpha.ToString(), body.RootElement.GetProperty("tenantId").GetString());
            Assert.Equal(TestTenants.AlphaPrincipal.ToString(), body.RootElement.GetProperty("principalId").GetString());
            Assert.Contains("calm", body.RootElement.GetProperty("instructions").GetString(), StringComparison.Ordinal);
            Assert.False(body.RootElement.TryGetProperty("rootItemId", out _));
            Assert.False(body.RootElement.TryGetProperty("readOnly", out _));
            Assert.Equal("test-secret", handler.Secret);
            var disabled = await gateway.ExecuteAsync(new("send", TestTenants.AlphaWorkspace, saved.Settings.ActivePetId, Guid.NewGuid(), "Hello"), Cancellation);
            Assert.True(disabled.IsFailure);
            Assert.Equal(1, handler.Calls);
        }
    }

    [Fact]
    public async Task Saved_memories_reach_the_worker_only_while_memory_is_on()
    {
        await SaveInitialAsync();
        foreach (var off in new[] { false, true })
        {
            var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var dispatcher = work.Resolve<NixDispatcher>();
                var saved = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), Cancellation);
                var settings = saved.Settings with { Memories = [new(Guid.NewGuid(), "Prefers metric units.", DateTimeOffset.UnixEpoch)], MemoryMode = off ? PetMemoryModes.Off : PetMemoryModes.Ask };
                Assert.True((await dispatcher.SendAsync<SavePetSettings, PetSettingsResponse>(new(saved.Revision, settings), Cancellation)).IsSuccess);
                using var handler = new RecordingWorker();
                using var http = new HttpClient(handler);
                Assert.True((await Gateway(work, http).ExecuteAsync(new("read", TestTenants.AlphaWorkspace, settings.ActivePetId), Cancellation)).IsSuccess);
                using var body = JsonDocument.Parse(handler.Body);
                var instructions = body.RootElement.GetProperty("instructions").GetString();
                Assert.Equal(!off, instructions?.Contains("- Prefers metric units.", StringComparison.Ordinal));
                await work.CommitAsync(Cancellation);
            }
        }
    }

    [Fact]
    public async Task A_save_that_carries_no_memories_keeps_the_stored_ones()
    {
        await SaveInitialAsync();
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var saved = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), Cancellation);
            var remembered = saved.Settings with { Memories = [new(Guid.NewGuid(), "Prefers metric units.", DateTimeOffset.UnixEpoch)] };
            var first = await dispatcher.SendAsync<SavePetSettings, PetSettingsResponse>(new(saved.Revision, remembered), Cancellation);
            // An older client knows nothing of memories and sends none.
            var older = await dispatcher.SendAsync<SavePetSettings, PetSettingsResponse>(new(first.Value.Revision, remembered with { Memories = null, Motion = "reduced" }), Cancellation);
            Assert.True(older.IsSuccess);
            var reread = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), Cancellation);
            Assert.Equal("reduced", reread.Settings.Motion);
            Assert.Equal(["Prefers metric units."], reread.Settings.Memories?.Select(memory => memory.Text));
            // An empty list is the owner forgetting them all.
            var cleared = await dispatcher.SendAsync<SavePetSettings, PetSettingsResponse>(new(reread.Revision, reread.Settings with { Memories = [] }), Cancellation);
            Assert.Empty(cleared.Value.Settings.Memories ?? [new(Guid.Empty, "x", default)]);
        }
    }

    [Fact]
    public async Task Note_conversations_refuse_missing_foreign_and_wrong_workspace_roots_before_contacting_worker()
    {
        await SaveInitialAsync();
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var otherWorkspace = await dispatcher.SendAsync<CreateWorkspace, WorkspaceSnapshot>(new("Other workspace"), Cancellation);
            Assert.True(otherWorkspace.IsSuccess);
            var otherItem = await dispatcher.SendAsync<CreateItem, Item>(
                new(otherWorkspace.Value.Id, "note", "Other note", null, null), Cancellation);
            Assert.True(otherItem.IsSuccess);

            using var handler = new RecordingWorker();
            using var http = new HttpClient(handler);
            var gateway = Gateway(work, http);
            var settings = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), Cancellation);
            foreach (var root in new[] { Guid.NewGuid(), M0SchemaSeed.Beta.ItemId, otherItem.Value.Id.Value })
            {
                await AssertScopedOperationsRefusedAsync(gateway, settings.Settings.ActivePetId!.Value, root);
            }
            Assert.Equal(0, handler.Calls);
        }
    }

    [Fact]
    public async Task Note_conversations_forward_scope_read_only_and_the_existing_shared_item_title()
    {
        await SaveInitialAsync(enabled: true);
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            using var handler = new RecordingWorker();
            using var http = new HttpClient(handler);
            var dispatcher = work.Resolve<NixDispatcher>();
            var gateway = Gateway(work, http);
            var settings = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), Cancellation);
            var root = M0SchemaSeed.Alpha.ItemId;
            var item = await dispatcher.QueryAsync<GetItem, Result<Item>>(new(ItemId.From(root)), Cancellation);
            var result = await gateway.ExecuteAsync(new("send", TestTenants.AlphaWorkspace, settings.Settings.ActivePetId,
                Guid.NewGuid(), "Explain this note", ItemId: root, SharedText: "Selected text",
                WorkspaceMap: [new(Guid.NewGuid(), "Outside context", "note")], RootItemId: root, ReadOnly: true), Cancellation);

            Assert.True(result.IsSuccess);
            using (var body = JsonDocument.Parse(handler.Body))
            {
                Assert.Equal(root, body.RootElement.GetProperty("rootItemId").GetGuid());
                Assert.True(body.RootElement.GetProperty("readOnly").GetBoolean());
                Assert.Equal(JsonValueKind.Null, body.RootElement.GetProperty("workspaceMap").ValueKind);
                Assert.Equal(ItemProperties.ReadTitle(item.Value.Properties), body.RootElement.GetProperty("itemTitle").GetString());
                Assert.Equal("Selected text", body.RootElement.GetProperty("sharedText").GetString());
            }

            var watch = await gateway.ExecuteWatchAsync(TestTenants.AlphaWorkspace, settings.Settings.ActivePetId!.Value,
                "chat", 42, Cancellation, root);
            Assert.True(watch.IsSuccess);
            using var watchedBody = JsonDocument.Parse(handler.Body);
            Assert.Equal(root, watchedBody.RootElement.GetProperty("rootItemId").GetGuid());
            Assert.Equal(42, watchedBody.RootElement.GetProperty("after").GetInt64());
            Assert.Equal(2, handler.Calls);
        }
    }

    [Fact]
    public async Task Closed_root_and_ancestor_locks_withhold_note_conversations_and_history_but_open_credentials_can_read()
    {
        await SaveInitialAsync();
        var locker = Guid.NewGuid();
        var root = M0SchemaSeed.Alpha.ItemId;
        Guid child;
        var setup = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (setup.ConfigureAwait(false))
        {
            setup.Resolve<CredentialSessionContext>().Set(locker);
            var dispatcher = setup.Resolve<NixDispatcher>();
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new(new(TestTenants.AlphaWorkspace), "note", "Child", ItemId.From(root), null), Cancellation);
            Assert.True(created.IsSuccess);
            child = created.Value.Id.Value;
            var locked = await dispatcher.SendAsync<LockItem, bool>(new(ItemId.From(root), "hunter22", null), Cancellation);
            Assert.True(locked.IsSuccess);
            await setup.CommitAsync(Cancellation);
        }

        foreach (var credential in new[] { Guid.NewGuid(), locker })
        {
            var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                work.Resolve<CredentialSessionContext>().Set(credential);
                using var handler = new RecordingWorker();
                using var http = new HttpClient(handler);
                var dispatcher = work.Resolve<NixDispatcher>();
                var gateway = Gateway(work, http);
                var settings = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), Cancellation);
                foreach (var scopedRoot in new[] { root, child })
                {
                    if (credential != locker)
                    {
                        await AssertScopedOperationsRefusedAsync(gateway, settings.Settings.ActivePetId!.Value, scopedRoot);
                        Assert.Equal(0, handler.Calls);
                    }
                    else
                    {
                        var read = await gateway.ExecuteAsync(new("read", TestTenants.AlphaWorkspace,
                            settings.Settings.ActivePetId, RootItemId: scopedRoot), Cancellation);
                        Assert.True(read.IsSuccess);
                        var watch = await gateway.ExecuteWatchAsync(TestTenants.AlphaWorkspace,
                            settings.Settings.ActivePetId!.Value, "chat", 0, Cancellation, scopedRoot);
                        Assert.True(watch.IsSuccess);
                    }
                }
                Assert.Equal(credential == locker ? 4 : 0, handler.Calls);
            }
        }
    }

    private static async Task AssertScopedOperationsRefusedAsync(PetWorkerClient gateway, Guid petId, Guid root)
    {
        foreach (var operation in new[] { "read", "send", "interrupt", "reset", "tool_claim", "tool_result", "history", "read_history", "delete_history", "rename", "resume_history" })
        {
            var result = await gateway.ExecuteAsync(new(operation, TestTenants.AlphaWorkspace, petId, Guid.NewGuid(), "Test",
                ToolId: "tool-one", HistoryId: Guid.NewGuid(), RootItemId: root), Cancellation);
            Assert.True(result.IsFailure);
            Assert.Equal("pets.not_found", result.Error.Code);
        }
        var watch = await gateway.ExecuteWatchAsync(TestTenants.AlphaWorkspace, petId, "chat", 0, Cancellation, root);
        Assert.True(watch.IsFailure);
        Assert.Equal("pets.not_found", watch.Error.Code);
    }

    private static PetWorkerClient Gateway(NixUnitOfWork work, HttpClient http) => new(http,
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Nix:Pets:WorkerUrl"] = "http://worker:8301",
            ["Nix:InternalSecret"] = "test-secret",
        }).Build(), work.Resolve<INixSessionContextAccessor>(), work.Resolve<NixDispatcher>(),
        work.Resolve<IPermissionResolver>(), work.Resolve<IPetProviderCredentialStore>(),
        new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

    private sealed class RecordingWorker : HttpMessageHandler
    {
        public int Calls { get; private set; }
        public string Body { get; private set; } = "";
        public string Secret { get; private set; } = "";

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            Body = await request.Content!.ReadAsStringAsync(cancellationToken);
            Secret = request.Headers.GetValues("X-Nix-Internal-Secret").Single();
            return new(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"provider\":\"chatgpt\",\"status\":\"connected\",\"reason\":\"Connected\",\"canConnect\":false,\"messages\":[]}", System.Text.Encoding.UTF8, "application/json"),
            };
        }
    }
}
