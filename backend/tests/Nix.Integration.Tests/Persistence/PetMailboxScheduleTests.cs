using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Nix.Abstractions;
using Nix.Abstractions.Automations;
using Nix.Abstractions.Connections;
using Nix.Abstractions.PetRuns;
using Nix.Abstractions.Scheduling;
using Nix.Authentication;
using Nix.Domain.Automations;
using Nix.Domain.Items;
using Nix.Domain.Scheduling;
using Nix.Features.Automations;
using Nix.Features.Items;
using Nix.Features.Pets;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Scheduling;
using Nix.Workers;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class PetMailboxScheduleTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly NixSessionContext Owner = TestTenants.AlphaContext;
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [InlineData("gmail", "google", "gmail-label", "gmail.checkpoint", "gmail.list-changes", "gmail.get-message")]
    [InlineData("outlook-mail", "microsoft", "folder", "outlook-mail.poll-folder", "outlook-mail.poll-folder", "outlook-mail.get-message")]
    public async Task The_schedule_saves_provider_checkpoints_and_queues_each_message_once(
        string mailbox, string provider, string resourceKind, string baselineAction, string changeAction, string readMessage)
    {
        var gmail = mailbox == "gmail";
        using var worker = new MailboxStub(provider, resourceKind, baselineAction, changeAction, gmail);
        using var serverServices = new ServiceCollection().AddLogging().AddOptions().BuildServiceProvider();
        using var server = new TestServer(serverServices);
        using var endpoints = new CompositeEndpointDataSource([]);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Nix:PetRuns:Enabled"] = "true",
            ["Nix:PetRuns:AllowedWorkspaces:0"] = TestTenants.AlphaWorkspace.ToString("D"),
            ["Nix:InternalSecret"] = "fixture-secret",
            ["Nix:Pets:WorkerUrl"] = "https://companion.test/",
        }).Build();
        await using var host = NixPersistenceHost.Create(fixture.ApplicationConnectionString, configuration: config,
            configureServices: services =>
            {
                services.AddSingleton<IDataProtectionProvider>(new EphemeralDataProtectionProvider());
                services.AddSingleton<EndpointDataSource>(endpoints);
                services.AddSingleton<IServer>(server);
                services.AddSingleton<SelfIssuedTokenService>();
                services.AddSingleton<WorkerLoopbackClient>();
                services.AddHttpClient("ConnectorWorkerClient").ConfigurePrimaryHttpMessageHandler(() => worker);
            });
        var first = new DateTimeOffset(DateTime.UtcNow.Date.AddDays(-5).AddHours(10), TimeSpan.Zero);
        host.Clock.Pin(first);
        var workspace = Owner.WorkspaceId!.Value;
        ItemId taskId;
        ConnectorGrant grant;
        var ruleId = Guid.NewGuid();
        var repeat = new ScheduleTrigger(ScheduleFrequency.Daily, 1, [], new TimeOnly(10, 0), "Etc/UTC",
            DateOnly.FromDateTime(first.UtcDateTime));
        await using (var work = await host.BeginUnitOfWorkAsync(Owner, Cancellation))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var settings = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), Cancellation);
            var petId = Guid.NewGuid();
            Assert.True((await dispatcher.SendAsync<SavePetSettings, PetSettingsResponse>(new(settings.Revision,
                new PetSettings(true, petId, [new PetProfile(petId, "Owl", "owl", "")])), Cancellation)).IsSuccess);
            var item = await dispatcher.SendAsync<CreateItem, Item>(new(workspace, "note", "Mail triage", null, null), Cancellation);
            Assert.True(item.IsSuccess);
            taskId = item.Value.Id;
            var store = work.Resolve<IConnectorStore>();
            var protectedCredential = work.Resolve<IDataProtectionProvider>().CreateProtector("Nix.PetConnectors.Credential.v1")
                .Protect("""{"accessToken":"fixture-provider-token"}""");
            var actions = new[] { baselineAction, changeAction, readMessage }.Distinct(StringComparer.Ordinal).ToArray();
            const string resource = "Mailbox_1";
            Assert.True(await store.SaveScopedAsync(workspace, provider, resourceKind, resource, actions, protectedCredential, Cancellation));
            grant = Assert.Single(await store.ListAsync(workspace, Cancellation));
            var watch = new PollPetMailboxAction(mailbox, grant.Id, grant.Revision, resource, "Draft the next triage step.", IncludeTargetText: false);
            Assert.Equal(AutomationRuleWrite.Written, await work.Resolve<IAutomationRuleStore>().InsertAsync(new AutomationRule
            {
                Id = ruleId,
                TenantId = Owner.TenantId,
                WorkspaceId = workspace,
                OwnerPrincipalId = Owner.PrincipalId,
                Name = "Watch mailbox",
                Enabled = true,
                ScopeItemId = taskId,
                TriggerType = "schedule",
                Trigger = AutomationTriggerJson.Write(repeat).ToJsonString(),
                Conditions = "[]",
                Actions = AutomationActionJson.WriteAll([watch]).ToJsonString(),
                SchemaVersion = 1,
                Revision = 1,
                ConsecutiveFailures = 0,
                CreatedAt = first,
                UpdatedAt = first,
            }, Cancellation));
            await work.CommitAsync(Cancellation);
        }

        await FireAsync(host, ruleId, repeat, first);
        if (worker.ReceivedCursors.Count == 0)
        {
            await using var connection = await fixture.OpenMigratorConnectionAsync();
            var outcomes = await RawSql.TextListAsync(connection, $"""
                SELECT 'trigger ' || status || ' ' || coalesce(detail::text, '') FROM scheduled_trigger WHERE rule_id = '{ruleId:D}'
                UNION ALL
                SELECT 'run ' || status || ' ' || coalesce(detail::text, '') FROM automation_run WHERE rule_id = '{ruleId:D}'
                """);
            Assert.Fail($"Mailbox baseline did not reach the provider. Worker requests [{string.Join(", ", worker.Operations)}]. {string.Join(" | ", outcomes)}");
        }
        Assert.Single(worker.ReceivedCursors);
        Assert.Empty(await ListRunsAsync(host, taskId));
        await FireAsync(host, ruleId, repeat, first.AddDays(1));
        var once = Assert.Single(await ListRunsAsync(host, taskId));
        Assert.Equal("queued", once.Status);
        Assert.Equal(["connection.action", "task.comment"], once.Abilities);
        Assert.Contains("message-new", once.Brief, StringComparison.Ordinal);
        Assert.DoesNotContain("body-secret", once.Brief, StringComparison.Ordinal);
        Assert.Empty(once.SourceItemIds);
        Assert.False(once.WorkspaceScope);
        Assert.False(once.State.GetProperty("includeTargetText").GetBoolean());

        // A new dispatcher opens a fresh scope. The new provider page repeats the same message
        // under a different checkpoint and adds a second message.
        await FireAsync(host, ruleId, repeat, first.AddDays(2));
        var twice = await ListRunsAsync(host, taskId);
        Assert.Equal(2, twice.Count);
        Assert.Contains(twice, run => run.Id == once.Id);
        Assert.Contains(twice, run => run.Brief.Contains("message-other", StringComparison.Ordinal));
        await FireAsync(host, ruleId, repeat, first.AddDays(3));
        Assert.Equal(2, (await ListRunsAsync(host, taskId)).Count);
        (string? Cursor, string? PageToken)[] expectedCursors = gmail
            ? [(null, null), ("100", null), ("100", "page-2"), ("104", null)]
            : [(null, null), ("baseline", null), ("cursor-2", null), ("cursor-3", null)];
        Assert.Equal(expectedCursors, worker.ReceivedCursors);

        await using (var work = await host.BeginUnitOfWorkAsync(Owner, Cancellation))
        {
            Assert.True(await work.Resolve<IConnectorStore>().DisconnectAsync(workspace, grant.Id, Cancellation));
            await work.CommitAsync(Cancellation);
        }
        await FireAsync(host, ruleId, repeat, first.AddDays(4));
        Assert.Equal(4, worker.ReceivedCursors.Count);
        Assert.Equal(2, (await ListRunsAsync(host, taskId)).Count);
    }

    private static async Task FireAsync(NixPersistenceHost host, Guid ruleId, ScheduleTrigger repeat, DateTimeOffset at)
    {
        host.Clock.Pin(at);
        var workspace = Owner.WorkspaceId!.Value;
        await using (var work = await host.BeginUnitOfWorkAsync(Owner, Cancellation))
        {
            var desired = AutomationPlanning.ScheduleTriggers(Owner.TenantId, workspace, Owner.PrincipalId,
                ruleId, repeat, "Etc/UTC", new PlanWindow(at, at.AddMinutes(1))).Where(trigger => trigger.FireAt == at).TakeLast(1).ToArray();
            Assert.Single(desired);
            Assert.Equal(1, await work.Resolve<IScheduledTriggerStore>().UpsertPendingAsync(
                TriggerKind.Automation, AutomationPlanning.ScheduleSource, desired, Cancellation));
            await work.CommitAsync(Cancellation);
        }
        await using var scope = host.CreateUnscopedScope();
        var logger = new ScheduledFixtureLogger();
        using var dispatcher = new ScheduleDispatcher(
            scope.ServiceProvider.GetRequiredService<IScheduledTriggerLeaseStore>(),
            scope.ServiceProvider.GetRequiredService<IRetentionStore>(),
            scope.ServiceProvider.GetRequiredService<IServiceScopeFactory>(), host.Clock, logger);
        Assert.True(await dispatcher.DispatchOnceAsync(Cancellation) > 0);
        Assert.Null(logger.Exception?.ToString());
    }

    private static async Task<IReadOnlyList<PetRunRecord>> ListRunsAsync(NixPersistenceHost host, ItemId task)
    {
        await using var work = await host.BeginUnitOfWorkAsync(Owner, Cancellation);
        return await work.Resolve<IPetRunStore>().ListAsync(Owner.WorkspaceId!.Value, task, Cancellation);
    }

    private sealed class ScheduledFixtureLogger : ILogger<ScheduleDispatcher>
    {
        internal Exception? Exception { get; private set; }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Exception ??= exception;
    }

    private sealed class MailboxStub(string provider, string kind, string baselineAction, string changeAction, bool gmail) : HttpMessageHandler
    {
        internal List<(string? Cursor, string? PageToken)> ReceivedCursors { get; } = [];
        internal List<string> Operations { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert.Equal("https://companion.test/v1/sani/connectors", request.RequestUri!.AbsoluteUri);
            using var message = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            var payload = message.RootElement;
            var operation = payload.GetProperty("operation").GetString();
            Operations.Add(operation ?? "missing");
            const string hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            object result = operation switch
            {
                "catalog" => new
                {
                    actions = new[] { baselineAction, changeAction }.Distinct(StringComparer.Ordinal).Select(id => new
                    {
                        id,
                        provider,
                        kind = "read",
                        resourceKind = kind,
                        description = "Read mailbox changes",
                        schema = new { },
                        schemaHash = hash,
                    }).ToArray(),
                },
                "prepare" => new { arguments = payload.GetProperty("args"), schemaHash = hash },
                "execute" => Execute(payload),
                _ => throw new InvalidOperationException(operation),
            };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(result)) };
        }

        private object Execute(JsonElement payload)
        {
            Assert.Equal("fixture-provider-token", payload.GetProperty("accessToken").GetString());
            Assert.Equal("Mailbox_1", payload.GetProperty("resourceId").GetString());
            var args = payload.GetProperty("args");
            var cursor = args.TryGetProperty(gmail ? "after" : "cursor", out var stored) ? stored.GetString() : null;
            var page = args.TryGetProperty("pageToken", out var continuation) ? continuation.GetString() : null;
            ReceivedCursors.Add((cursor, page));
            if (gmail && cursor is null)
            {
                return new { result = new { historyId = "100" } };
            }
            var messages = (cursor, page) switch
            {
                (null, null) => new[] { new { id = "baseline-only", text = "body-secret" } },
                ("100" or "baseline", null) => new[] { new { id = "message-new", text = "body-secret" } },
                ("100", "page-2") or ("cursor-2", null) => new[] { new { id = "message-new", text = "body-secret" }, new { id = "message-other", text = "body-secret" } },
                ("104" or "cursor-3", null) => Array.Empty<object>(),
                _ => throw new InvalidOperationException(cursor),
            };
            if (gmail)
            {
                return cursor == "100" && page is null
                    ? new { result = new { status = "ready", historyId = "100", nextPageToken = "page-2", messages } }
                    : new { result = new { status = "ready", historyId = "104", messages } };
            }
            var next = cursor is null ? "baseline" : cursor == "baseline" ? "cursor-2" : "cursor-3";
            return new { result = new { cursor = next, hasMore = false, messages } };
        }
    }
}
