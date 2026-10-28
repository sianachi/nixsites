using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Pets;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Features.Locks;
using Nix.Features.Pets;
using Nix.Features.Workspaces;
using Nix.Messaging;
using Nix.Persistence;
using Nix.Persistence.Workspaces;
using Nix.Tests.Harness;

namespace Nix.Tests.Features.Pets;

public sealed class PetWorkerClientModeTests(ContractHostFactory factory) : IClassFixture<ContractHostFactory>
{
    private static readonly Guid WorkspaceGuid = new("44444444-4444-4444-8444-444444444444");
    private static readonly Guid PetGuid = new("55555555-5555-4555-8555-555555555555");
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData("anthropic", "credit_balance.400", "pets.provider_credit_balance")]
    [InlineData("anthropic", "authentication.401", "pets.provider_authentication")]
    [InlineData("anthropic", "permission.403", "pets.provider_permission")]
    [InlineData("anthropic", "models_rejected.400", "pets.provider_models_rejected")]
    [InlineData("openrouter", "credit_balance.402", "pets.provider_credit_balance")]
    [InlineData("openrouter", "rate_limited.429", "pets.provider_rate_limited")]
    public async Task Known_provider_failures_reach_models_and_send_as_safe_503_problems(string provider, string token, string code)
    {
        using var handler = new ProviderErrorWorker(HttpStatusCode.BadGateway, [$"{provider}.{token}"]);
        using var http = new HttpClient(handler);
        var logger = new CapturingLogger<PetWorkerClient>();
        var gateway = KeyedGateway(http, provider, logger);
        using var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services => services.AddSingleton(gateway)));
        using var client = host.CreateClient();

        foreach (var operation in new[] { "models", "send" })
        {
            using var response = await client.PostAsJsonAsync(new Uri("/api/v1/me/pets/runtime", UriKind.Relative),
                new PetRuntimeRequest(operation, WorkspaceGuid, PetGuid, Guid.NewGuid(), "Private draft text"), Cancellation);

            Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
            var text = await response.Content.ReadAsStringAsync(Cancellation);
            using var problem = JsonDocument.Parse(text);
            Assert.Equal(code, problem.RootElement.GetProperty("code").GetString());
            Assert.StartsWith(provider == "anthropic" ? "Claude " : "OpenRouter ", problem.RootElement.GetProperty("detail").GetString(), StringComparison.Ordinal);
            Assert.DoesNotContain("private-worker-response", text, StringComparison.Ordinal);
            Assert.DoesNotContain("Private draft text", text, StringComparison.Ordinal);
        }

        Assert.All(logger.Messages, message =>
        {
            Assert.Contains(code, message, StringComparison.Ordinal);
            Assert.DoesNotContain("private-worker-response", message, StringComparison.Ordinal);
            Assert.DoesNotContain("Private draft text", message, StringComparison.Ordinal);
        });
    }

    [Theory]
    [InlineData(HttpStatusCode.BadGateway, "openrouter.credit_balance.402")]
    [InlineData(HttpStatusCode.BadGateway, "anthropic.credit_balance.401")]
    [InlineData(HttpStatusCode.BadGateway, "anthropic.unknown.400")]
    [InlineData(HttpStatusCode.BadGateway, "credit_balance.400")]
    [InlineData(HttpStatusCode.BadGateway, "anthropic.credit_balance.400,anthropic.permission.403")]
    [InlineData(HttpStatusCode.BadGateway, "anthropic.credit_balance.400", true)]
    [InlineData(HttpStatusCode.Unauthorized, "anthropic.authentication.401")]
    public async Task Unrecognized_mismatched_or_repeated_worker_error_metadata_retains_generic_failure(HttpStatusCode status, string token, bool repeated = false)
    {
        using var handler = new ProviderErrorWorker(status, repeated ? [token, token] : [token]);
        using var http = new HttpClient(handler);
        var gateway = KeyedGateway(http, "anthropic");

        var result = await gateway.ExecuteAsync(new("models", PetId: PetGuid), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.unavailable", result.Error.Code);
        Assert.DoesNotContain("private-worker-response", result.Error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Inline_provider_credit_rejection_is_a_safe_503_problem()
    {
        using var handler = new ProviderErrorWorker(HttpStatusCode.BadGateway, ["anthropic.credit_balance.400"]);
        using var http = new HttpClient(handler);
        var gateway = KeyedGateway(http, "anthropic");
        using var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.AddSingleton(gateway);
            services.AddSingleton(Dispatcher("anthropic", inlineWriting: true));
            services.AddSingleton<INixSessionContextAccessor>(Session());
            services.AddSingleton<IItemLocks>(new OpenLocks());
        }));
        using var client = host.CreateClient();

        using var response = await client.PostAsJsonAsync(new Uri("/api/v1/me/pets/inline", UriKind.Relative),
            new PetInlineRequest(WorkspaceGuid, Guid.NewGuid(), Guid.NewGuid(), "improve", "Private inline text"), Cancellation);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var text = await response.Content.ReadAsStringAsync(Cancellation);
        using var problem = JsonDocument.Parse(text);
        Assert.Equal("pets.provider_credit_balance", problem.RootElement.GetProperty("code").GetString());
        Assert.Equal("Claude reports that this API key has insufficient credit. Check API billing for the key, then try again.", problem.RootElement.GetProperty("detail").GetString());
        Assert.DoesNotContain("private-worker-response", text, StringComparison.Ordinal);
        Assert.DoesNotContain("Private inline text", text, StringComparison.Ordinal);
    }

    private static PetWorkerClient KeyedGateway(HttpClient http, string provider, ILogger<PetWorkerClient>? logger = null)
    {
        var session = Session();
        var context = session.Current!.Value;
        var protector = new PetProviderKeyProtector(new EphemeralDataProtectionProvider());
        var credentials = new SavedCredentials(new PetProviderCredential
        {
            TenantId = context.TenantId,
            PrincipalId = context.PrincipalId,
            Provider = provider,
            ProtectedKey = protector.Protect("test-provider-key-not-real"),
            KeyHint = "real",
            SavedAt = DateTimeOffset.UtcNow,
        });
        return new(http, Configuration(), session, Dispatcher(provider, inlineWriting: true), new StubPermissions(), credentials, protector, logger);
    }

    [Theory]
    [InlineData("anthropic", false, true)]
    [InlineData("anthropic", true, true)]
    [InlineData("openrouter", false, true)]
    [InlineData("openrouter", true, true)]
    [InlineData("anthropic", false, false)]
    [InlineData("anthropic", true, false)]
    public async Task Missing_key_reads_and_watches_report_disconnected_after_permission_checks(string provider, bool watch, bool canRead)
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        IPermissionResolver permissions = canRead ? new StubPermissions() : new DenyReadPermissions();
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(provider), permissions, new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = watch
            ? await gateway.ExecuteWatchAsync(WorkspaceGuid, PetGuid, "", 0, Cancellation)
            : await gateway.ExecuteAsync(new("read", WorkspaceGuid, PetGuid), Cancellation);

        Assert.Equal(0, handler.Calls);
        if (!canRead)
        {
            Assert.True(result.IsFailure);
            Assert.Equal("pets.not_found", result.Error.Code);
            return;
        }

        Assert.True(result.IsSuccess);
        Assert.Equal(provider, result.Value.Provider);
        Assert.Equal("disconnected", result.Value.Status);
        Assert.False(result.Value.CanConnect);
        Assert.Empty(result.Value.Messages!);
        Assert.Contains("API key", result.Value.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Model_tool_support_reaches_the_browser_and_defaults_true_for_older_worker_models()
    {
        using var handler = new ModelCatalogWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteAsync(new("models", PetId: PetGuid), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.False(result.Value.Models![0].SupportsTools);
        Assert.True(result.Value.Models[1].SupportsTools);
        using var serialized = JsonDocument.Parse(JsonSerializer.Serialize(result.Value));
        Assert.False(serialized.RootElement.GetProperty("Models")[0].GetProperty("SupportsTools").GetBoolean());
    }

    [Theory]
    [InlineData("status", "anthropic")]
    [InlineData("models", "anthropic")]
    [InlineData("send", "anthropic")]
    [InlineData("status", "openrouter")]
    [InlineData("models", "openrouter")]
    [InlineData("send", "openrouter")]
    public async Task A_saved_pet_routes_connection_models_and_chat_to_its_key_provider(string operation, string provider)
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var session = Session();
        var context = session.Current!.Value;
        var protector = new PetProviderKeyProtector(new EphemeralDataProtectionProvider());
        const string key = "test-provider-key-for-routing-only";
        var credentials = new SavedCredentials(new PetProviderCredential
        {
            TenantId = context.TenantId,
            PrincipalId = context.PrincipalId,
            Provider = provider,
            ProtectedKey = protector.Protect(key),
            KeyHint = "only",
            SavedAt = DateTimeOffset.UtcNow,
        });
        var gateway = new PetWorkerClient(http, Configuration(), session, Dispatcher(provider), new StubPermissions(), credentials, protector);

        var result = await gateway.ExecuteAsync(new(operation, WorkspaceGuid, PetGuid, Guid.NewGuid(), "Hello"), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, handler.Calls);
        using var body = JsonDocument.Parse(handler.Body);
        Assert.Equal(provider, body.RootElement.GetProperty("provider").GetString());
        Assert.Equal(key, body.RootElement.GetProperty("apiKey").GetString());
        Assert.DoesNotContain(key, JsonSerializer.Serialize(result.Value), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("status")]
    [InlineData("connect")]
    [InlineData("disconnect")]
    [InlineData("models")]
    public async Task An_unknown_selected_pet_does_not_fall_back_to_ChatGPT(string operation)
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteAsync(new(operation, PetId: Guid.NewGuid()), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.invalid_request", result.Error.Code);
        Assert.Equal(0, handler.Calls);
    }

    [Theory]
    [InlineData("chatgpt", false)]
    [InlineData("anthropic", true)]
    [InlineData("openrouter", true)]
    [InlineData("anthropic", false)]
    [InlineData("openrouter", false)]
    public async Task Inline_writing_uses_the_saved_active_pet_provider_and_requires_its_key(string provider, bool hasKey)
    {
        using var handler = new RecordingWorker(inline: true);
        using var http = new HttpClient(handler);
        var session = Session();
        var context = session.Current!.Value;
        var dispatcher = Dispatcher(provider, inlineWriting: true);
        var protector = new PetProviderKeyProtector(new EphemeralDataProtectionProvider());
        const string key = "test-inline-provider-key-for-routing";
        var credentials = new SavedCredentials(hasKey ? new PetProviderCredential
        {
            TenantId = context.TenantId,
            PrincipalId = context.PrincipalId,
            Provider = provider,
            ProtectedKey = protector.Protect(key),
            KeyHint = "ting",
            SavedAt = DateTimeOffset.UtcNow,
        } : null);
        var gateway = new PetWorkerClient(http, Configuration(), session, dispatcher, new StubPermissions(), credentials, protector);
        using var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.AddSingleton(gateway);
            services.AddSingleton(dispatcher);
            services.AddSingleton<INixSessionContextAccessor>(session);
            services.AddSingleton<IItemLocks>(new OpenLocks());
        }));
        using var client = host.CreateClient();

        using var response = await client.PostAsJsonAsync(new Uri("/api/v1/me/pets/inline", UriKind.Relative),
            new PetInlineRequest(WorkspaceGuid, Guid.NewGuid(), Guid.NewGuid(), "improve", "Selected text"), Cancellation);

        if (provider != "chatgpt" && !hasKey)
        {
            Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
            using var problem = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
            Assert.Equal("pets.no_provider_key", problem.RootElement.GetProperty("code").GetString());
            Assert.Equal(0, handler.Calls);
            return;
        }

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal(1, handler.Calls);
        using var body = JsonDocument.Parse(handler.Body);
        Assert.Equal(PetGuid, body.RootElement.GetProperty("petId").GetGuid());
        Assert.Equal("inline", body.RootElement.GetProperty("operation").GetString());
        if (provider == "chatgpt")
        {
            Assert.False(body.RootElement.TryGetProperty("provider", out _));
            Assert.False(body.RootElement.TryGetProperty("apiKey", out _));
        }
        else
        {
            Assert.Equal(provider, body.RootElement.GetProperty("provider").GetString());
            Assert.Equal(key, body.RootElement.GetProperty("apiKey").GetString());
            Assert.DoesNotContain(key, await response.Content.ReadAsStringAsync(Cancellation), StringComparison.Ordinal);
        }
    }

    [Theory]
    [InlineData("rename", "  Sprint review ", true, true)]
    [InlineData("rename", "Sprint review", false, true)]
    [InlineData("resume_history", "", true, true)]
    [InlineData("rename", "   ", true, false)]
    [InlineData("rename", "a\nb", true, false)]
    [InlineData("resume_history", "", false, false)]
    public async Task Rename_and_resume_history_forward_text_and_archive_or_are_refused_before_the_worker(string operation, string text, bool withHistoryId, bool allowed)
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));
        var archive = Guid.NewGuid();

        var result = await gateway.ExecuteAsync(new(operation, WorkspaceGuid, PetGuid, Text: text, HistoryId: withHistoryId ? archive : null), Cancellation);

        if (!allowed)
        {
            Assert.True(result.IsFailure);
            Assert.Equal("pets.invalid_request", result.Error.Code);
            Assert.Equal(0, handler.Calls);
            return;
        }

        Assert.True(result.IsSuccess);
        using var body = JsonDocument.Parse(handler.Body);
        Assert.Equal(operation, body.RootElement.GetProperty("operation").GetString());
        Assert.Equal(text, body.RootElement.GetProperty("text").GetString());
        Assert.Equal(withHistoryId ? archive.ToString() : "", body.RootElement.GetProperty("historyId").GetString());
    }

    [Fact]
    public async Task The_note_runtime_route_requires_a_root_before_contacting_worker()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));
        using var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services => services.AddSingleton(gateway)));
        using var client = host.CreateClient();

        using var response = await client.PostAsJsonAsync(new Uri("/api/v1/me/pets/runtime/note", UriKind.Relative),
            new PetRuntimeRequest("read", WorkspaceGuid, PetGuid), Cancellation);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        Assert.Equal(0, handler.Calls);
    }

    [Theory]
    [InlineData(false, HttpStatusCode.BadRequest)]
    [InlineData(true, HttpStatusCode.UnprocessableEntity)]
    public async Task The_note_watch_route_requires_a_nonempty_root_before_contacting_worker(bool hasRoot, HttpStatusCode status)
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));
        using var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services => services.AddSingleton(gateway)));
        using var client = host.CreateClient();
        var path = $"/api/v1/me/pets/runtime/note/watch?workspaceId={WorkspaceGuid}&petId={PetGuid}"
            + (hasRoot ? $"&rootItemId={Guid.Empty}" : "");

        using var response = await client.GetAsync(new Uri(path, UriKind.Relative), Cancellation);

        Assert.Equal(status, response.StatusCode);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task An_unknown_mode_is_refused_as_pets_invalid_request()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteAsync(new("status", Mode: "design"), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.invalid_request", result.Error.Code);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task An_empty_root_item_is_refused_before_reaching_the_worker()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteAsync(new("read", WorkspaceGuid, PetGuid, RootItemId: Guid.Empty), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.invalid_request", result.Error.Code);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task A_note_conversation_refuses_shared_item_context_outside_its_root()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Explain this note",
            ItemId: Guid.NewGuid(), RootItemId: Guid.NewGuid()), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.invalid_request", result.Error.Code);
        Assert.Equal(0, handler.Calls);
    }

    private static readonly Guid ItemA = new("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    private static readonly Guid ItemB = new("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    private static readonly Guid ItemC = new("cccccccc-cccc-4ccc-8ccc-cccccccccccc");

    private static PetWorkerClient SendGateway(HttpClient http, Guid? unreadable = null, Guid? locked = null, string? title = null) =>
        new(http, Configuration(), Session(), Dispatcher(unreadableItem: unreadable, lockedItem: locked, itemTitle: title), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

    [Fact]
    public async Task Several_attached_items_are_deduplicated_and_forwarded_with_the_first_as_the_current_item()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = SendGateway(http);

        var result = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Compare",
            ItemId: ItemA, ItemIds: [ItemA, ItemB, ItemC, ItemB], SharedText: "selected"), Cancellation);

        Assert.True(result.IsSuccess);
        using var body = JsonDocument.Parse(handler.Body);
        Assert.Equal(ItemA.ToString(), body.RootElement.GetProperty("itemId").GetString());
        var items = body.RootElement.GetProperty("items");
        Assert.Equal([ItemA.ToString(), ItemB.ToString(), ItemC.ToString()], items.EnumerateArray().Select(item => item.GetProperty("id").GetString()!).ToArray());
    }

    [Theory]
    [InlineData(300, false)]
    [InlineData(239, true)]
    public async Task A_long_item_title_is_clipped_to_the_workers_limit_without_splitting_an_emoji(int length, bool emojiStraddles)
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        // 239 letters then a surrogate pair puts the pair across the 240-unit limit.
        var title = new string('a', length) + (emojiStraddles ? "\U0001F600tail" : string.Empty);
        var gateway = SendGateway(http, title: title);

        var result = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Explain", ItemIds: [ItemA]), Cancellation);

        Assert.True(result.IsSuccess);
        using var body = JsonDocument.Parse(handler.Body);
        var sent = body.RootElement.GetProperty("items")[0].GetProperty("title").GetString()!;
        Assert.True(sent.Length <= 240);
        Assert.False(char.IsHighSurrogate(sent[^1]));
        Assert.Equal(emojiStraddles ? 239 : 240, sent.Length);
        Assert.Equal(sent, body.RootElement.GetProperty("itemTitle").GetString());
    }

    [Fact]
    public async Task One_item_in_the_list_alone_is_still_the_current_item()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = SendGateway(http);

        var result = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Explain", ItemIds: [ItemB]), Cancellation);

        Assert.True(result.IsSuccess);
        using var body = JsonDocument.Parse(handler.Body);
        Assert.Equal(ItemB.ToString(), body.RootElement.GetProperty("itemId").GetString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task One_unreadable_or_locked_item_rejects_the_whole_send(bool locked)
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = SendGateway(http, unreadable: locked ? null : ItemB, locked: locked ? ItemB : null);

        var result = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Compare", ItemIds: [ItemA, ItemB]), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.not_found", result.Error.Code);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task More_than_the_cap_of_distinct_items_is_refused_but_duplicates_do_not_count()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = SendGateway(http);
        var many = Enumerable.Range(0, PetWorkerClient.MaxSharedItems + 1).Select(_ => Guid.NewGuid()).ToList();

        var over = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Compare", ItemIds: many), Cancellation);
        Assert.True(over.IsFailure);
        Assert.Equal("pets.invalid_request", over.Error.Code);
        Assert.Equal(0, handler.Calls);

        var fit = many.Take(PetWorkerClient.MaxSharedItems).ToList();
        var repeated = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Compare", ItemIds: [.. fit, .. fit]), Cancellation);
        Assert.True(repeated.IsSuccess);
    }

    [Fact]
    public async Task A_note_conversation_refuses_an_item_list_that_names_anything_but_its_root()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = SendGateway(http);

        var result = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Explain", RootItemId: ItemA, ItemIds: [ItemA, ItemB]), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.invalid_request", result.Error.Code);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task Replace_from_message_is_forwarded_on_a_send_and_refused_elsewhere()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = SendGateway(http);
        var replaced = Guid.NewGuid();

        var sent = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Again", ReplaceFromMessageId: replaced), Cancellation);
        Assert.True(sent.IsSuccess);
        using (var body = JsonDocument.Parse(handler.Body))
        {
            Assert.Equal(replaced.ToString(), body.RootElement.GetProperty("replaceFromMessageId").GetString());
        }

        var calls = handler.Calls;
        foreach (var request in new[]
        {
            new PetRuntimeRequest("read", WorkspaceGuid, PetGuid, ReplaceFromMessageId: replaced),
            new PetRuntimeRequest("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Again", ReplaceFromMessageId: Guid.Empty),
        })
        {
            var refused = await gateway.ExecuteAsync(request, Cancellation);
            Assert.True(refused.IsFailure);
            Assert.Equal("pets.invalid_request", refused.Error.Code);
        }

        Assert.Equal(calls, handler.Calls);
    }

    [Fact]
    public async Task A_worker_400_for_a_replace_target_is_an_invalid_request_not_an_outage()
    {
        using var handler = new ProviderErrorWorker(HttpStatusCode.BadRequest, []);
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Again", ReplaceFromMessageId: Guid.NewGuid()), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.invalid_request", result.Error.Code);
    }

    [Fact]
    public async Task Consult_is_forwarded_to_the_worker()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Design a habit tracker", Mode: "consult"), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, handler.Calls);
        using var body = JsonDocument.Parse(handler.Body);
        Assert.Equal("consult", body.RootElement.GetProperty("mode").GetString());
    }

    [Fact]
    public async Task A_watch_operation_posted_through_ExecuteAsync_is_refused_before_reaching_the_worker()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteAsync(new("watch", WorkspaceGuid, PetGuid), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.invalid_request", result.Error.Code);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task ExecuteWatchAsync_reaches_the_worker_with_the_watch_operation_and_after_value()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteWatchAsync(WorkspaceGuid, PetGuid, "chat", 42, Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, handler.Calls);
        using var body = JsonDocument.Parse(handler.Body);
        Assert.Equal("watch", body.RootElement.GetProperty("operation").GetString());
        Assert.Equal("chat", body.RootElement.GetProperty("mode").GetString());
        Assert.Equal(42, body.RootElement.GetProperty("after").GetInt64());
    }

    [Fact]
    public async Task ExecuteWatchAsync_is_refused_exactly_like_read_for_a_foreign_workspace()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new DenyReadPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteWatchAsync(WorkspaceGuid, PetGuid, "chat", 0, Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.not_found", result.Error.Code);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task A_429_from_the_worker_is_mapped_to_pets_too_many_watches_and_HTTP_429()
    {
        using var handler = new StatusWorker(HttpStatusCode.TooManyRequests);
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteWatchAsync(WorkspaceGuid, PetGuid, "chat", 0, Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.too_many_watches", result.Error.Code);
    }

    [Fact]
    public async Task A_409_from_the_worker_is_mapped_to_pets_busy_and_HTTP_409()
    {
        using var handler = new StatusWorker(HttpStatusCode.Conflict);
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Design a habit tracker"), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.busy", result.Error.Code);
    }

    [Fact]
    public async Task A_worker_failure_is_logged_with_its_operation_and_status_but_no_content()
    {
        using var handler = new StatusWorker(HttpStatusCode.ServiceUnavailable);
        using var http = new HttpClient(handler);
        var logger = new CapturingLogger<PetWorkerClient>();
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()), logger);

        var result = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "private message text"), Cancellation);

        Assert.True(result.IsFailure);
        var message = Assert.Single(logger.Messages);
        Assert.Contains("send", message, StringComparison.Ordinal);
        Assert.Contains("HTTP 503", message, StringComparison.Ordinal);
        Assert.Contains("pets.unavailable", message, StringComparison.Ordinal);
        Assert.DoesNotContain("private message text", message, StringComparison.Ordinal);
        Assert.DoesNotContain(WorkspaceGuid.ToString(), message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_worker_response_over_the_four_mebibyte_cap_is_refused_as_pets_unavailable()
    {
        using var handler = new OversizedWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteAsync(new("status"), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.unavailable", result.Error.Code);
    }

    [Fact]
    public async Task A_send_forwards_the_owner_date_zone_and_workspace_map_to_the_worker()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));
        var container = Guid.NewGuid();

        var result = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "What is due?",
            Today: "2026-10-09", TimeZone: "Europe/London",
            WorkspaceMap: [new(container, "Tasks", "note", ["board", "calendar"])]), Cancellation);

        Assert.True(result.IsSuccess);
        using var body = JsonDocument.Parse(handler.Body);
        Assert.Equal("2026-10-09", body.RootElement.GetProperty("today").GetString());
        Assert.Equal("Europe/London", body.RootElement.GetProperty("timeZone").GetString());
        var entry = Assert.Single(body.RootElement.GetProperty("workspaceMap").EnumerateArray());
        Assert.Equal(container, entry.GetProperty("id").GetGuid());
        Assert.Equal("Tasks", entry.GetProperty("title").GetString());
        Assert.Equal(2, entry.GetProperty("viewKinds").GetArrayLength());
    }

    [Fact]
    public async Task A_tool_result_forwards_locked_content_and_the_conversation_mark_comes_back()
    {
        using var handler = new LockedReadWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteAsync(new("tool_result", WorkspaceGuid, PetGuid, Guid.NewGuid(),
            ToolId: "read-1", ToolResult: "body", ToolSuccess: true, ToolLockedContent: true), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.True(result.Value.LockedRead);
        using var body = JsonDocument.Parse(handler.Body);
        Assert.True(body.RootElement.GetProperty("toolLockedContent").GetBoolean());
    }

    [Fact]
    public async Task A_tool_result_picture_is_forwarded_and_left_out_when_there_is_none()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = SendGateway(http);

        Assert.True((await gateway.ExecuteAsync(new("tool_result", WorkspaceGuid, PetGuid, Guid.NewGuid(),
            ToolId: "read-1", ToolResult: "{}", ToolSuccess: true, ToolImage: "data:image/jpeg;base64,/9j/AA=="), Cancellation)).IsSuccess);
        using (var body = JsonDocument.Parse(handler.Body))
        {
            Assert.Equal("data:image/jpeg;base64,/9j/AA==", body.RootElement.GetProperty("toolImage").GetString());
        }

        Assert.True((await gateway.ExecuteAsync(new("tool_result", WorkspaceGuid, PetGuid, Guid.NewGuid(),
            ToolId: "read-1", ToolResult: "{}", ToolSuccess: true), Cancellation)).IsSuccess);
        using (var body = JsonDocument.Parse(handler.Body))
        {
            Assert.False(body.RootElement.TryGetProperty("toolImage", out _));
        }
    }

    [Theory]
    [InlineData("send", "data:image/jpeg;base64,/9j/AA==")]
    [InlineData("tool_result", "data:image/png;base64,iVBO")]
    [InlineData("tool_result", "data:image/jpeg;base64,/9j/\nAA")]
    [InlineData("tool_result", "https://example.com/a.jpg")]
    [InlineData("tool_result", "data:image/jpeg;base64,")]
    public async Task A_picture_that_is_not_a_jpeg_data_url_on_a_tool_result_never_reaches_the_worker(string operation, string image)
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = SendGateway(http);

        var result = await gateway.ExecuteAsync(new(operation, WorkspaceGuid, PetGuid, Guid.NewGuid(), operation == "send" ? "Hi" : "",
            ToolId: "read-1", ToolResult: "{}", ToolSuccess: true, ToolImage: image), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task A_picture_longer_than_the_bound_never_reaches_the_worker()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = SendGateway(http);

        var result = await gateway.ExecuteAsync(new("tool_result", WorkspaceGuid, PetGuid, Guid.NewGuid(), ToolId: "read-1", ToolResult: "{}",
            ToolImage: "data:image/jpeg;base64," + new string('A', PetWorkerClient.MaxToolImageLength)), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task A_message_from_the_worker_carries_no_actions_member()
    {
        // An older worker still writes an actions array; Core's contract no longer has one, so
        // nothing of it reaches the browser.
        using var handler = new LegacyActionsWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteAsync(new("read", WorkspaceGuid, PetGuid), Cancellation);

        Assert.True(result.IsSuccess);
        var message = Assert.Single(result.Value.Messages!);
        Assert.Equal("Done.", message.Text);
        Assert.Null(typeof(PetMessage).GetProperty("Actions"));
    }

    public static TheoryData<string, string, int> InvalidTurnContexts => new()
    {
        { "tomorrow", "", 0 },
        { "2026-02-30", "", 0 },
        { "", "Europe/London; drop the rules", 0 },
        { "", new string('a', 65), 0 },
        { "", "", 41 },
    };

    [Theory]
    [MemberData(nameof(InvalidTurnContexts))]
    public async Task An_invalid_date_zone_or_oversized_map_is_refused_before_reaching_the_worker(string today, string timeZone, int mapEntries)
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));
        var map = mapEntries == 0 ? null : Enumerable.Range(0, mapEntries).Select(_ => new PetWorkspaceMapEntry(Guid.NewGuid(), "Tasks", "note")).ToList();

        var result = await gateway.ExecuteAsync(new("send", WorkspaceGuid, PetGuid, Guid.NewGuid(), "Hi",
            Today: today, TimeZone: timeZone, WorkspaceMap: map), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.invalid_request", result.Error.Code);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task A_workspace_map_is_refused_on_any_operation_but_send()
    {
        using var handler = new RecordingWorker();
        using var http = new HttpClient(handler);
        var gateway = new PetWorkerClient(http, Configuration(), Session(), Dispatcher(), new StubPermissions(), new NoCredentials(), new PetProviderKeyProtector(new EphemeralDataProtectionProvider()));

        var result = await gateway.ExecuteAsync(new("read", WorkspaceGuid, PetGuid,
            WorkspaceMap: [new(Guid.NewGuid(), "Tasks", "note")]), Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("pets.invalid_request", result.Error.Code);
        Assert.Equal(0, handler.Calls);
    }

    private static IConfiguration Configuration() => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
    {
        ["Nix:Pets:WorkerUrl"] = "http://worker:8301",
        ["Nix:InternalSecret"] = "test-secret",
    }).Build();

    private static ScopedNixSessionContextAccessor Session()
    {
        var session = new ScopedNixSessionContextAccessor();
        session.Set(new NixSessionContext(TenantId.Create(), null, PrincipalId.Create()));
        return session;
    }

    private static NixDispatcher Dispatcher(string provider = PetProviders.ChatGpt, bool inlineWriting = false, Guid? unreadableItem = null, Guid? lockedItem = null, string? itemTitle = null)
    {
        var services = new ServiceCollection();
        services.AddSingleton<IQueryHandler<GetWorkspace, WorkspaceSnapshot?>>(new FakeGetWorkspaceHandler());
        services.AddSingleton<IQueryHandler<GetPetSettings, PetSettingsResponse>>(new FakeGetPetSettingsHandler(provider, inlineWriting));
        services.AddSingleton<IQueryHandler<GetItem, Result<Item>>>(new FakeGetItemHandler(unreadableItem, itemTitle));
        services.AddSingleton<IQueryHandler<GetItemLock, Result<ItemLockState>>>(new FakeGetItemLockHandler(lockedItem));
        return new NixDispatcher(services.BuildServiceProvider());
    }

    private sealed class FakeGetWorkspaceHandler : IQueryHandler<GetWorkspace, WorkspaceSnapshot?>
    {
        public ValueTask<WorkspaceSnapshot?> HandleAsync(GetWorkspace query, CancellationToken cancellationToken) =>
            ValueTask.FromResult<WorkspaceSnapshot?>(new(query.WorkspaceId, "Workspace", 30, 0, DateTimeOffset.UtcNow,
                null, false, false, false, false, null, "active", null, false, true));
    }

    private sealed class FakeGetPetSettingsHandler(string provider, bool inlineWriting) : IQueryHandler<GetPetSettings, PetSettingsResponse>
    {
        public ValueTask<PetSettingsResponse> HandleAsync(GetPetSettings query, CancellationToken cancellationToken) =>
            ValueTask.FromResult(new PetSettingsResponse(0, new(true, PetGuid, "system",
                [new(Guid.NewGuid(), "Other pet", "owl", "calm", "balanced", ""),
                    new(PetGuid, "Nix", "owl", "playful", "balanced", "Explain clearly.", Provider: provider)], inlineWriting)));
    }

    private sealed class FakeGetItemLockHandler(Guid? locked) : IQueryHandler<GetItemLock, Result<ItemLockState>>
    {
        public ValueTask<Result<ItemLockState>> HandleAsync(GetItemLock query, CancellationToken cancellationToken) =>
            ValueTask.FromResult(Result.Success(new ItemLockState(query.ItemId.Value == locked, null, null, query.ItemId.Value == locked)));
    }

    private sealed class FakeGetItemHandler(Guid? unreadable = null, string? title = null) : IQueryHandler<GetItem, Result<Item>>
    {
        public ValueTask<Result<Item>> HandleAsync(GetItem query, CancellationToken cancellationToken) => query.ItemId.Value == unreadable
            ? ValueTask.FromResult(Result.Failure<Item>(new("items.not_found", "Not found")))
            : ValueTask.FromResult(Result.Success(new Item
            {
                Id = query.ItemId,
                TenantId = TenantId.Create(),
                WorkspaceId = new(WorkspaceGuid),
                Type = "note",
                Seq = 1,
                LifecycleState = ItemLifecycleState.Active,
                CreatedBy = PrincipalId.Create(),
                LastModifiedBy = PrincipalId.Create(),
                CreatedAt = DateTimeOffset.UtcNow,
                LastModifiedAt = DateTimeOffset.UtcNow,
                Properties = title is null ? null : JsonSerializer.Serialize(new Dictionary<string, string> { [ItemProperties.TitleKey] = title }),
            }));
    }

    private sealed class OpenLocks : IItemLocks
    {
        public ValueTask<IReadOnlySet<ItemId>> LockedAmongAsync(IReadOnlyList<ItemId> itemIds, CancellationToken cancellationToken) => ValueTask.FromResult<IReadOnlySet<ItemId>>(new HashSet<ItemId>());
        public ValueTask<ItemLockState> GetStateAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> MayReadBodyAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> AnyInSubtreeAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<string?> FindVerifierAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> LockAsync(ItemId itemId, string verifier, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> ChangeVerifierAsync(ItemId itemId, string expected, string verifier, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> RemoveAsync(ItemId itemId, string expected, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> GrantAsync(ItemId itemId, string verifier, DateTimeOffset expiresAt, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> IsLockedAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask RevokeAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();
    }

    private sealed class StubPermissions : IPermissionResolver
    {
        public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(true);
        public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(true);
        public ValueTask<bool> CanManageWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(true);
        public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(CancellationToken cancellationToken) => ValueTask.FromResult<IReadOnlyList<WorkspaceId>>([]);
        public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) => ValueTask.FromResult(false);
    }

    /// <summary>Denies workspace read: proves watch is refused through the same permission
    /// check "read" goes through, exactly like a foreign workspace or a caller with no access.</summary>
    private sealed class DenyReadPermissions : IPermissionResolver
    {
        public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);
        public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);
        public ValueTask<bool> CanManageWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);
        public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(CancellationToken cancellationToken) => ValueTask.FromResult<IReadOnlyList<WorkspaceId>>([]);
        public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) => ValueTask.FromResult(false);
    }

    private sealed class RecordingWorker(bool inline = false) : HttpMessageHandler
    {
        public int Calls { get; private set; }
        public string Body { get; private set; } = "";

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            Body = await request.Content!.ReadAsStringAsync(cancellationToken);
            return new(HttpStatusCode.OK)
            {
                Content = inline
                    ? new StringContent("event: done\ndata: {\"text\":\"Improved text\"}\n\n", System.Text.Encoding.UTF8, "text/event-stream")
                    : new StringContent("{\"provider\":\"chatgpt\",\"status\":\"connected\",\"reason\":\"Connected\",\"canConnect\":false,\"messages\":[]}", System.Text.Encoding.UTF8, "application/json"),
            };
        }
    }

    private sealed class LockedReadWorker : HttpMessageHandler
    {
        public string Body { get; private set; } = "";

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Body = await request.Content!.ReadAsStringAsync(cancellationToken);
            return new(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"provider\":\"chatgpt\",\"status\":\"connected\",\"reason\":\"Connected\",\"canConnect\":false,\"messages\":[],\"lockedRead\":true}",
                    System.Text.Encoding.UTF8, "application/json"),
            };
        }
    }

    private sealed class ModelCatalogWorker : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                "{\"provider\":\"chatgpt\",\"status\":\"connected\",\"reason\":\"Connected\",\"canConnect\":false,\"messages\":[],\"models\":[{\"id\":\"plain\",\"name\":\"Plain\",\"default\":true,\"supportsTools\":false},{\"id\":\"older\",\"name\":\"Older\",\"default\":false}]}",
                System.Text.Encoding.UTF8, "application/json"),
        });
    }

    private sealed class LegacyActionsWorker : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"provider\":\"chatgpt\",\"status\":\"connected\",\"reason\":\"Connected\",\"canConnect\":false,"
                    + "\"messages\":[{\"id\":\"m1\",\"role\":\"assistant\",\"text\":\"Done.\",\"actions\":[{\"kind\":\"create_item\",\"itemId\":\"\",\"title\":\"Plan\"}]}]}",
                    System.Text.Encoding.UTF8, "application/json"),
            });
    }

    /// <summary>Answers with a fixed non-success status and no body, standing in for the worker's
    /// own backpressure (429) and single-flight contention (409) refusals.</summary>
    private sealed class StatusWorker(HttpStatusCode statusCode) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(statusCode));
    }

    private sealed class ProviderErrorWorker(HttpStatusCode status, string[] tokens) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var response = new HttpResponseMessage(status)
            {
                Content = new StringContent("private-worker-response"),
            };
            response.Headers.TryAddWithoutValidation("X-Nix-Provider-Error", tokens);
            return Task.FromResult(response);
        }
    }

    /// <summary>Answers 200 with a body one byte over <see cref="PetWorkerClient"/>'s four
    /// mebibyte cap, proving the cap is enforced while streaming rather than after buffering.</summary>
    private sealed class OversizedWorker : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            const int capBytes = 4 * 1024 * 1024;
            var padding = new string('a', capBytes + 1);
            var body = $"{{\"provider\":\"chatgpt\",\"status\":\"connected\",\"reason\":\"{padding}\",\"canConnect\":false,\"messages\":[]}}";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter) => Messages.Add(formatter(state, exception));
    }

    private sealed class NoCredentials : IPetProviderCredentialStore
    {
        public ValueTask<PetProviderCredential?> FindAsync(TenantId tenantId, PrincipalId principalId, string provider, CancellationToken cancellationToken) => ValueTask.FromResult<PetProviderCredential?>(null);

        public ValueTask<IReadOnlyList<PetProviderCredential>> ListAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) => ValueTask.FromResult<IReadOnlyList<PetProviderCredential>>([]);

        public Task SaveAsync(PetProviderCredential credential, CancellationToken cancellationToken) => Task.CompletedTask;

        public Task<bool> RemoveAsync(TenantId tenantId, PrincipalId principalId, string provider, CancellationToken cancellationToken) => Task.FromResult(false);
    }

    private sealed class SavedCredentials(PetProviderCredential? credential) : IPetProviderCredentialStore
    {
        public ValueTask<PetProviderCredential?> FindAsync(TenantId tenantId, PrincipalId principalId, string provider, CancellationToken cancellationToken) =>
            ValueTask.FromResult(credential is not null && credential.TenantId == tenantId && credential.PrincipalId == principalId && credential.Provider == provider ? credential : null);

        public ValueTask<IReadOnlyList<PetProviderCredential>> ListAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task SaveAsync(PetProviderCredential credential, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<bool> RemoveAsync(TenantId tenantId, PrincipalId principalId, string provider, CancellationToken cancellationToken) => throw new NotSupportedException();
    }
}
