using System.Collections.Immutable;
using System.Data.Common;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Authorization;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Features.Tokens;
using Nix.Features.Views;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class PublicFormSubmissionConcurrencyTests(NixPostgresFixture fixture, ITestOutputHelper output) : IAsyncLifetime
{
    private const string SigningKey = "a-test-signing-key-that-is-at-least-thirty-two-bytes";
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_tracked_public_submission_records_its_form()
    {
        var link = await CreatePublishedFormAsync();
        await using (var setup = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var result = await setup.Resolve<NixDispatcher>().SendAsync<SetItemSchema, PropertySchema>(
                new(link.ItemId, PropertySchema.Empty with
                {
                    Properties = [new("nix_submission_form", "Submission form", PropertyType.Text, [], false)],
                }), Cancellation);
            Assert.True(result.IsSuccess);
            await setup.CommitAsync(Cancellation);
        }

        using var response = await SubmitAsync(link, new SubmissionLockInterceptor(pauseAfterLock: false), Cancellation);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var saved = await work.DbContext.Items.SingleAsync(item => item.ParentId == link.ItemId, Cancellation);
        using var properties = JsonDocument.Parse(Assert.IsType<string>(saved.Properties));
        Assert.Equal(link.ViewId, properties.RootElement.GetProperty("nix_submission_form").GetString());
    }

    [Fact]
    public async Task A_submission_waits_for_an_in_flight_mode_change_and_does_not_save_a_temporary_form()
    {
        var link = await CreatePublishedFormAsync();
        await using var editor = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        Assert.True((await editor.Resolve<NixDispatcher>().SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
            new(link.ItemId, [Form("temporary")], "form"), Cancellation)).IsSuccess);

        var observer = new SubmissionLockInterceptor(pauseAfterLock: false);
        using var submitCancellation = CancellationTokenSource.CreateLinkedTokenSource(Cancellation);
        var submit = SubmitAsync(link, observer, submitCancellation.Token);
        try
        {
            try
            {
                await observer.Arrived.Task.WaitAsync(TimeSpan.FromSeconds(20), Cancellation);
                await WaitForBlockedBackendAsync(observer.BackendPid);
                Assert.False(submit.IsCompleted);
            }
            finally
            {
                await editor.CommitAsync(Cancellation);
            }
            var response = await submit.WaitAsync(TimeSpan.FromSeconds(20), Cancellation);

            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            await AssertSavedResponsesAsync(link.ItemId, 0);
        }
        finally
        {
            await submitCancellation.CancelAsync();
            try
            {
                using var response = await submit;
            }
            catch (OperationCanceledException)
            {
            }
        }
    }

    [Fact]
    public async Task A_mode_change_waits_until_an_already_locked_submission_has_committed()
    {
        var link = await CreatePublishedFormAsync();
        var observer = new SubmissionLockInterceptor(pauseAfterLock: true);
        using var submitCancellation = CancellationTokenSource.CreateLinkedTokenSource(Cancellation);
        var submit = SubmitAsync(link, observer, submitCancellation.Token);
        try
        {
            await observer.Locked.Task.WaitAsync(TimeSpan.FromSeconds(20), Cancellation);
            await using var editor = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            var connection = Assert.IsType<NpgsqlConnection>(editor.DbContext.Database.GetDbConnection());
            var change = editor.Resolve<NixDispatcher>().SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
                new(link.ItemId, [Form("temporary")], "form"), Cancellation).AsTask();
            bool modeChanged;
            try
            {
                await WaitForBlockedBackendAsync(connection.ProcessID);
                Assert.False(change.IsCompleted);
            }
            finally
            {
                observer.Release.TrySetResult();
                modeChanged = (await change).IsSuccess;
            }

            var response = await submit.WaitAsync(TimeSpan.FromSeconds(20), Cancellation);
            Assert.Equal(HttpStatusCode.Created, response.StatusCode);
            Assert.True(modeChanged);
            await editor.CommitAsync(Cancellation);
            await AssertSavedResponsesAsync(link.ItemId, 1);
            await using var verify = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            var item = await verify.Resolve<IItemTree>().FindAsync(link.ItemId, Cancellation);
            Assert.Equal("temporary", ViewDefinitionsJson.Read(Assert.IsType<Item>(item).Views).Views[0].Mode);
        }
        finally
        {
            observer.Release.TrySetResult();
            await submitCancellation.CancelAsync();
            try
            {
                using var response = await submit;
            }
            catch (OperationCanceledException)
            {
            }
        }
    }

    [Fact]
    public async Task The_submission_lock_is_tenant_scoped_and_uses_a_point_index_on_a_realistic_corpus()
    {
        await SeedCorpusAsync();
        var link = await CreatePublishedFormAsync();
        var observer = new SubmissionLockInterceptor(pauseAfterLock: false, explain: true);
        await using var application = NixPersistenceHost.Create(fixture.ApplicationConnectionString, observer);
        await using (var work = await application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            Assert.True(await work.Resolve<IPublicFormStore>().LockSubmissionAsync(link, Cancellation));
            var plan = Assert.IsType<string>(observer.Plan);
            output.WriteLine(plan);
            Assert.Contains("Index Scan", plan, StringComparison.Ordinal);
            Assert.DoesNotContain("Seq Scan", plan, StringComparison.Ordinal);
            Assert.Contains("Buffers:", plan, StringComparison.Ordinal);
        }
        await using var foreign = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        Assert.False(await foreign.Resolve<IPublicFormStore>().LockSubmissionAsync(link, Cancellation));
    }

    private async Task<PublicFormLink> CreatePublishedFormAsync()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var dispatcher = work.Resolve<NixDispatcher>();
        var created = await dispatcher.SendAsync<CreateItem, Item>(
            new(WorkspaceId.From(TestTenants.AlphaWorkspace), "note", "Public calculator", null, null), Cancellation);
        Assert.True(created.IsSuccess);
        Assert.True((await dispatcher.SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
            new(created.Value.Id, [Form("saved")], "form"), Cancellation)).IsSuccess);
        var principalId = PrincipalId.Create();
        var link = new PublicFormLink
        {
            Id = Guid.CreateVersion7(),
            TenantId = TestTenants.AlphaContext.TenantId,
            WorkspaceId = created.Value.WorkspaceId,
            ItemId = created.Value.Id,
            ViewId = "form",
            Nonce = "public-form-concurrency",
            SubmissionPrincipalId = principalId,
            PublishedBy = TestTenants.AlphaContext.PrincipalId,
            PublishedAt = DateTimeOffset.UtcNow,
        };
        var store = work.Resolve<IPublicFormStore>();
        store.Add(link, new Principal
        {
            Id = principalId,
            TenantId = link.TenantId,
            ExternalSubject = $"nix:public-form:{link.Id:D}",
            Kind = PrincipalKind.Service,
            DisplayName = "Public form",
            Status = PrincipalStatus.Active,
        }, new WorkspaceMember
        {
            WorkspaceId = link.WorkspaceId,
            TenantId = link.TenantId,
            SubjectType = SubjectType.Principal,
            SubjectId = principalId.Value,
            Role = WorkspaceRoles.ToText(WorkspaceRole.Editor),
            GrantedBy = link.PublishedBy,
            GrantedAt = link.PublishedAt,
        });
        await store.SaveAsync(Cancellation);
        await work.CommitAsync(Cancellation);
        return link;
    }

    private static ViewDefinition Form(string mode) => new(
        "form", "Form", ViewKind.InteractiveForm, [], null, [], null, null, false, Mode: mode,
        InteractiveForm: new InteractiveFormDefinition(
            [new FormPage("page", "Page", null, [], [new FormBlock("intro", "paragraph", null, "Calculate here", null, false, null, [])])],
            "generated", null, "Thanks", "Done"));

    private static Uri FormPath(PublicFormLink link)
    {
        var tokens = new PublicFormTokenService(new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { [PublicFormTokenService.SigningKeyConfiguration] = SigningKey }).Build());
        return new Uri($"/public/v1/forms/{tokens.Create(link.TenantId, link.Id, link.SubmissionPrincipalId, link.Nonce)}", UriKind.Relative);
    }

    private async Task<HttpResponseMessage> SubmitAsync(PublicFormLink link, SubmissionLockInterceptor observer, CancellationToken cancellation)
    {
        await using var factory = Host(observer);
        using var client = factory.CreateClient();
        using var content = new StringContent("""{"answers":{}}""", Encoding.UTF8, "application/json");
        return await client.PostAsync(FormPath(link), content, cancellation);
    }

    private WebApplicationFactory<Program> Host(SubmissionLockInterceptor observer)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        return new FormApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = fixture.ApplicationConnectionString,
            [PublicFormTokenService.SigningKeyConfiguration] = SigningKey,
            [InternalBoundaryMiddleware.SecretConfigurationKey] = "public-form-test-internal-secret",
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.public-form.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "public-form-test-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = key.ExportECPrivateKeyPem(),
            ["Nix:Collaboration:BaseUrl"] = "http://127.0.0.1:8100",
            ["Nix:ObjectStorage:Endpoint"] = "http://127.0.0.1:7070",
            ["Nix:ObjectStorage:Region"] = "us-east-1",
            ["Nix:ObjectStorage:Bucket"] = "nix-objects",
            ["Nix:ObjectStorage:AccessKey"] = "form-access",
            ["Nix:ObjectStorage:SecretKey"] = "form-secret",
        }, observer);
    }

    private async Task WaitForBlockedBackendAsync(int backendPid)
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(Cancellation);
        deadline.CancelAfter(TimeSpan.FromSeconds(20));
        await using var command = new NpgsqlCommand("SELECT cardinality(pg_blocking_pids(@pid)) > 0", connection);
        command.Parameters.AddWithValue("pid", backendPid);
        while (!(bool)(await command.ExecuteScalarAsync(deadline.Token))!)
        {
            await Task.Delay(10, deadline.Token);
        }
    }

    private async Task AssertSavedResponsesAsync(ItemId parent, int count)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        Assert.Equal(count, await work.DbContext.Items.CountAsync(item => item.ParentId == parent, Cancellation));
        // Runtime audit access is insert-only; verification uses the schema owner, never extra grants.
        await using var auditConnection = await fixture.OpenMigratorConnectionAsync();
        await using var audit = new NpgsqlCommand(
            "SELECT count(*) FROM audit_event WHERE tenant_id = @tenant_id AND action = 'public_form.response_created'",
            auditConnection);
        audit.Parameters.AddWithValue("tenant_id", TestTenants.Alpha);
        Assert.Equal((long)count, Assert.IsType<long>(await audit.ExecuteScalarAsync(Cancellation)));
    }

    private async Task SeedCorpusAsync()
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        foreach (var seed in new[] { M0SchemaSeed.Alpha, M0SchemaSeed.Beta })
        {
            await RawSql.ExecuteAsync(connection, null, $$"""
                INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                    lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
                SELECT gen_random_uuid(), '{{seed.TenantId}}'::uuid, '{{seed.WorkspaceId}}'::uuid,
                    'note', NULL, 900000 + n, jsonb_build_object('title', 'Public form corpus ' || n),
                    'active', '{{seed.PrincipalId}}'::uuid, '{{seed.PrincipalId}}'::uuid, now(), now()
                FROM generate_series(1, 3200) n;
                """);
        }
        await RawSql.ExecuteAsync(connection, null, "ANALYZE item;");
    }

    private sealed class FormApplicationFactory(
        Dictionary<string, string?> settings, SubmissionLockInterceptor observer) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Testing");
            foreach (var (key, value) in settings)
            {
                builder.UseSetting(key, value);
            }
            builder.ConfigureServices(services => services.AddDbContext<NixDbContext>(
                (_, options) => options.AddInterceptors(observer)));
        }
    }

    private sealed class SubmissionLockInterceptor(bool pauseAfterLock, bool explain = false) : DbCommandInterceptor
    {
        internal TaskCompletionSource Arrived { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Locked { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal int BackendPid { get; private set; }
        internal string? Plan { get; private set; }

        private static bool IsSubmissionLock(DbCommand command) => command.CommandText.Contains("FOR UPDATE", StringComparison.Ordinal);

        public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result,
            CancellationToken cancellationToken = default)
        {
            if (!IsSubmissionLock(command))
            {
                return result;
            }
            var connection = Assert.IsType<NpgsqlConnection>(command.Connection);
            BackendPid = connection.ProcessID;
            Arrived.TrySetResult();
            if (explain)
            {
                // Capture the fixed EF statement and parameter values under the runtime RLS session.
#pragma warning disable CA2100
                await using var plan = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS) " + command.CommandText,
                    connection, Assert.IsType<NpgsqlTransaction>(command.Transaction));
#pragma warning restore CA2100
                foreach (DbParameter parameter in command.Parameters)
                {
                    var source = Assert.IsType<NpgsqlParameter>(parameter);
                    var copy = new NpgsqlParameter { ParameterName = source.ParameterName, Value = source.Value };
                    if (source.NpgsqlDbType != NpgsqlDbType.Unknown)
                    {
                        copy.NpgsqlDbType = source.NpgsqlDbType;
                    }
                    else
                    {
                        copy.DbType = source.DbType;
                    }
                    plan.Parameters.Add(copy);
                }
                var text = new StringBuilder();
                await using var reader = await plan.ExecuteReaderAsync(cancellationToken);
                while (await reader.ReadAsync(cancellationToken))
                {
                    text.AppendLine(reader.GetString(0));
                }
                Plan = text.ToString();
            }
            return result;
        }

        public override async ValueTask<DbDataReader> ReaderExecutedAsync(
            DbCommand command, CommandExecutedEventData eventData, DbDataReader result,
            CancellationToken cancellationToken = default)
        {
            if (IsSubmissionLock(command))
            {
                Locked.TrySetResult();
                if (pauseAfterLock)
                {
                    await Release.Task.WaitAsync(cancellationToken);
                }
            }
            return result;
        }
    }
}
