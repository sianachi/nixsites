using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Tests.Features.Query;

namespace Nix.Tests.Features.Items;

/// <summary>
/// <see cref="ItemBodyHandlers"/> authorizes a body read or write in Core, then forwards the
/// caller's own session to the collaboration service. These tests pin which requests never leave
/// Core, and that a request which does leave carries the caller's token unchanged.
/// </summary>
public sealed class ItemBodyTests
{
    private static readonly TenantId Tenant = TenantId.From(new Guid("11111111-1111-4111-8111-111111111111"));
    private static readonly WorkspaceId Workspace = WorkspaceId.From(new Guid("22222222-2222-4222-8222-222222222222"));
    private static readonly PrincipalId Principal = PrincipalId.From(new Guid("33333333-3333-4333-8333-333333333333"));
    private static readonly ItemId TheItem = ItemId.From(new Guid("44444444-4444-4444-8444-444444444444"));
    private const string Session = "session-jwt";

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Replace_forwards_the_caller_session_and_maps_the_update()
    {
        using var call = Call.Open(Note("note"), HttpStatusCode.OK, WriteJson(seq: "42", updateBytes: 18, wiki: 2));

        var result = await call.Handlers.HandleAsync(
            new WriteItemBody(TheItem, "# Hello", Append: false, Session),
            Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(TheItem.Value, result.Value.Id);
        Assert.Equal("42", result.Value.Seq);
        Assert.Equal(18, result.Value.UpdateBytes);
        Assert.Equal(2, result.Value.MarkdownChanges.UnresolvedWikiLinks);
        Assert.Equal(HttpMethod.Put, call.Probe.Method);
        Assert.Equal(BodyUri(), call.Probe.Uri);
        Assert.Equal("Bearer session-jwt", call.Probe.Authorization);
        Assert.Equal("# Hello", MarkdownSent(call.Probe));
    }

    [Fact]
    public async Task Append_posts_and_maps_every_markdown_change_count()
    {
        using var call = Call.Open(
            Note("note"),
            HttpStatusCode.OK,
            WriteJson(seq: "7", updateBytes: 4, wiki: 1, embeds: 2, local: 3, unsupported: 4, inline: 5));

        var result = await call.Handlers.HandleAsync(
            new WriteItemBody(TheItem, "Later.", Append: true, Session),
            Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(HttpMethod.Post, call.Probe.Method);
        Assert.Equal(1, result.Value.MarkdownChanges.UnresolvedWikiLinks);
        Assert.Equal(2, result.Value.MarkdownChanges.UnresolvedObsidianEmbeds);
        Assert.Equal(3, result.Value.MarkdownChanges.UnresolvedLocalImages);
        Assert.Equal(4, result.Value.MarkdownChanges.UnsupportedImageAddresses);
        Assert.Equal(5, result.Value.MarkdownChanges.InlineImagesFlattened);
        Assert.Equal("Later.", MarkdownSent(call.Probe));
    }

    [Fact]
    public async Task An_empty_replacement_is_forwarded()
    {
        using var call = Call.Open(Note("note"), HttpStatusCode.OK, WriteJson(seq: "1", updateBytes: 2));

        var result = await call.Handlers.HandleAsync(
            new WriteItemBody(TheItem, "", Append: false, Session),
            Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, call.Probe.Calls);
        Assert.Equal("", MarkdownSent(call.Probe));
    }

    [Fact]
    public async Task Markdown_past_the_ceiling_never_calls_the_body_service()
    {
        using var call = Call.Open(Note("note"), HttpStatusCode.OK, WriteJson(seq: "1", updateBytes: 1));

        var result = await call.Handlers.HandleAsync(
            new WriteItemBody(TheItem, new string('x', ItemBodyLimits.MarkdownCharacters + 1), Append: false, Session),
            Cancellation);

        Assert.Equal("items.markdown_too_large", result.Error.Code);
        Assert.Equal(0, call.Probe.Calls);
    }

    [Fact]
    public async Task A_blank_append_never_calls_the_body_service()
    {
        using var call = Call.Open(Note("note"), HttpStatusCode.OK, WriteJson(seq: "1", updateBytes: 1));

        var result = await call.Handlers.HandleAsync(
            new WriteItemBody(TheItem, " \n", Append: true, Session),
            Cancellation);

        Assert.Equal("items.markdown_invalid", result.Error.Code);
        Assert.Equal(0, call.Probe.Calls);
    }

    [Theory]
    [InlineData(false, true)]
    [InlineData(true, false)]
    public async Task An_item_the_caller_cannot_see_is_not_found_and_is_not_fetched(bool present, bool canRead)
    {
        using var call = Call.Open(present ? Note("note") : null, HttpStatusCode.OK, ReadJson("# Secret"), canRead: canRead);

        var read = await call.Handlers.HandleAsync(new ReadItemBody(TheItem, Session), Cancellation);
        var write = await call.Handlers.HandleAsync(
            new WriteItemBody(TheItem, "No", Append: false, Session),
            Cancellation);

        Assert.Equal("items.not_found", read.Error.Code);
        Assert.Equal("items.not_found", write.Error.Code);
        Assert.Equal(0, call.Probe.Calls);
    }

    [Fact]
    public async Task A_reader_can_read_the_body_and_cannot_change_it()
    {
        using var call = Call.Open(Note("note"), HttpStatusCode.OK, ReadJson("# Kept"), canWrite: false);

        var read = await call.Handlers.HandleAsync(new ReadItemBody(TheItem, Session), Cancellation);
        var write = await call.Handlers.HandleAsync(
            new WriteItemBody(TheItem, "No", Append: false, Session),
            Cancellation);

        Assert.True(read.IsSuccess);
        Assert.Equal("# Kept", read.Value.Markdown);
        Assert.Equal("items.body_read_only", write.Error.Code);
        Assert.Equal(1, call.Probe.Calls);
        Assert.Equal(HttpMethod.Get, call.Probe.Method);
    }

    [Fact]
    public async Task A_locked_body_is_refused_before_the_body_service()
    {
        using var call = Call.Open(Note("note"), HttpStatusCode.OK, ReadJson("locked"), open: false);

        var read = await call.Handlers.HandleAsync(new ReadItemBody(TheItem, Session), Cancellation);
        var write = await call.Handlers.HandleAsync(
            new WriteItemBody(TheItem, "No", Append: true, Session),
            Cancellation);

        Assert.Equal("items.locked", read.Error.Code);
        Assert.Equal("items.locked", write.Error.Code);
        Assert.Equal(0, call.Probe.Calls);
    }

    [Theory]
    [InlineData("canvas")]
    [InlineData("spreadsheet")]
    public async Task A_non_prose_body_is_refused_before_the_body_service(string type)
    {
        using var call = Call.Open(Note(type), HttpStatusCode.OK, ReadJson("no"));

        var read = await call.Handlers.HandleAsync(new ReadItemBody(TheItem, Session), Cancellation);
        var write = await call.Handlers.HandleAsync(
            new WriteItemBody(TheItem, "# No", Append: false, Session),
            Cancellation);

        Assert.Equal("items.body_not_prose", read.Error.Code);
        Assert.Equal("items.body_not_prose", write.Error.Code);
        Assert.Equal(0, call.Probe.Calls);
    }

    [Fact]
    public async Task An_unknown_body_kind_is_forwarded_as_prose()
    {
        using var call = Call.Open(Note("page"), HttpStatusCode.OK, WriteJson(seq: "3", updateBytes: 9));

        var result = await call.Handlers.HandleAsync(
            new WriteItemBody(TheItem, "Page", Append: false, Session),
            Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, call.Probe.Calls);
    }

    [Fact]
    public async Task Read_maps_markdown_losses_and_an_empty_note()
    {
        using var call = Call.Open(
            Note("note"),
            HttpStatusCode.OK,
            """
            {"markdown":"","schemaVersion":4,"empty":true,"losses":[{"kind":"underline-dropped","detail":"Underline was dropped."}]}
            """,
            canWrite: false);

        var result = await call.Handlers.HandleAsync(new ReadItemBody(TheItem, Session), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal("", result.Value.Markdown);
        Assert.Equal(4, result.Value.SchemaVersion);
        Assert.True(result.Value.Empty);
        var loss = Assert.Single(result.Value.Losses);
        Assert.Equal("underline-dropped", loss.Kind);
        Assert.Equal("Underline was dropped.", loss.Detail);
        Assert.Null(call.Probe.Body);
    }

    [Fact]
    public async Task A_collaboration_refusal_keeps_its_meaning()
    {
        Assert.Equal("items.markdown_invalid", (await Refuse(HttpStatusCode.UnprocessableEntity, "markdown_invalid")).Error.Code);
        Assert.Equal("items.locked", (await Refuse(HttpStatusCode.Forbidden, "body_locked")).Error.Code);
        Assert.Equal("items.body_rate_limited", (await Refuse(HttpStatusCode.TooManyRequests, "rate_limited")).Error.Code);
        Assert.Equal("items.body_conflict", (await Refuse(HttpStatusCode.Conflict, "document_changed")).Error.Code);
        Assert.Equal("items.body_too_large", (await Refuse(HttpStatusCode.RequestEntityTooLarge, "document_too_large")).Error.Code);
        Assert.Equal("items.not_found", (await Refuse(HttpStatusCode.NotFound, "document_not_found")).Error.Code);
        Assert.Equal("items.body_read_only", (await Refuse(HttpStatusCode.Forbidden, "read_only")).Error.Code);
        Assert.Equal("items.body_unavailable", (await Refuse(HttpStatusCode.ServiceUnavailable, "authorization_unavailable")).Error.Code);
    }

    [Fact]
    public async Task An_unreachable_body_service_is_unavailable()
    {
        using var call = Call.Throwing(Note("note"));

        var failed = await call.Handlers.HandleAsync(
            new WriteItemBody(TheItem, "Hi", Append: false, Session),
            Cancellation);

        Assert.Equal("items.body_unavailable", failed.Error.Code);
        Assert.Equal(1, call.Calls);
    }

    [Fact]
    public async Task A_missing_collaboration_origin_is_not_called()
    {
        using var call = Call.Open(Note("note"), HttpStatusCode.OK, ReadJson("x"), origin: null);

        var missing = await call.Handlers.HandleAsync(new ReadItemBody(TheItem, Session), Cancellation);

        Assert.Equal("items.body_unavailable", missing.Error.Code);
        Assert.Equal(0, call.Probe.Calls);
    }

    [Fact]
    public async Task A_garbled_success_body_is_unavailable()
    {
        using var call = Call.Open(Note("note"), HttpStatusCode.OK, """{"markdown":1}""");

        var read = await call.Handlers.HandleAsync(new ReadItemBody(TheItem, Session), Cancellation);

        Assert.Equal("items.body_unavailable", read.Error.Code);
    }

    [Fact]
    public async Task A_missing_session_is_a_pipeline_failure()
    {
        using var call = Call.Open(Note("note"), HttpStatusCode.OK, ReadJson("x"), session: false);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            call.Handlers.HandleAsync(new ReadItemBody(TheItem, Session), Cancellation).AsTask());
        Assert.Equal(0, call.Probe.Calls);
    }

    private static async Task<Result<ItemBodyWriteResponse>> Refuse(HttpStatusCode status, string code)
    {
        using var call = Call.Open(Note("note"), status, Problem(code, "Refused."));
        return await call.Handlers.HandleAsync(new WriteItemBody(TheItem, "Hi", Append: false, Session), Cancellation);
    }

    private static Item Note(string type) => new()
    {
        Id = TheItem,
        TenantId = Tenant,
        WorkspaceId = Workspace,
        Type = type,
        Seq = 1000,
        Properties = """{"title":"Notes"}""",
        LifecycleState = ItemLifecycleState.Active,
        CreatedBy = Principal,
        LastModifiedBy = Principal,
        CreatedAt = DateTimeOffset.UnixEpoch,
        LastModifiedAt = DateTimeOffset.UnixEpoch,
    };

    private static Uri BodyUri() => new($"http://127.0.0.1:8100/documents/{TheItem.Value:D}/markdown");

    private static string MarkdownSent(RecordingHandler probe)
    {
        using var document = JsonDocument.Parse(probe.Body!);
        return document.RootElement.GetProperty("markdown").GetString()!;
    }

    private static string ReadJson(string markdown) =>
        $$"""{"markdown":{{JsonSerializer.Serialize(markdown)}},"schemaVersion":1,"empty":false,"losses":[]}""";

    private static string WriteJson(
        string seq,
        int updateBytes,
        int wiki = 0,
        int embeds = 0,
        int local = 0,
        int unsupported = 0,
        int inline = 0) =>
        JsonSerializer.Serialize(new
        {
            docId = TheItem.Value,
            seq,
            snapshotWritten = true,
            updateBytes,
            markdownChanges = new
            {
                unresolvedWikiLinks = wiki,
                unresolvedObsidianEmbeds = embeds,
                unresolvedLocalImages = local,
                unsupportedImageAddresses = unsupported,
                inlineImagesFlattened = inline,
            },
        });

    private static string Problem(string code, string detail) =>
        $$"""{"type":"about:blank","title":"Request refused","status":422,"code":"{{code}}","detail":"{{detail}}"}""";

    private sealed class Call : IDisposable
    {
        private readonly HttpClient _http;
        private readonly RecordingHandler? _probe;
        private readonly ThrowingHandler? _throwing;

        private Call(ItemBodyHandlers handlers, HttpClient http, RecordingHandler? probe, ThrowingHandler? throwing)
        {
            Handlers = handlers;
            _http = http;
            _probe = probe;
            _throwing = throwing;
        }

        internal ItemBodyHandlers Handlers { get; }

        internal RecordingHandler Probe => _probe ?? throw new InvalidOperationException("This call has no recording probe.");

        internal int Calls => _throwing?.Calls ?? Probe.Calls;

        public void Dispose() => _http.Dispose();

        internal static Call Open(
            Item? item,
            HttpStatusCode status,
            string body,
            bool canRead = true,
            bool canWrite = true,
            bool open = true,
            bool session = true,
            string? origin = "http://127.0.0.1:8100")
        {
            var probe = new RecordingHandler(status, body);
            var http = new HttpClient(probe);
            return new Call(Build(item, http, canRead, canWrite, open, session, origin), http, probe, throwing: null);
        }

        internal static Call Throwing(Item item)
        {
            var throwing = new ThrowingHandler();
            var http = new HttpClient(throwing);
            return new Call(
                Build(item, http, canRead: true, canWrite: true, open: true, session: true, origin: "http://127.0.0.1:8100"),
                http,
                probe: null,
                throwing);
        }

        private static ItemBodyHandlers Build(
            Item? item,
            HttpClient http,
            bool canRead,
            bool canWrite,
            bool open,
            bool session,
            string? origin)
        {
            var values = new Dictionary<string, string?>();
            if (origin is not null)
            {
                values["Nix:Collaboration:BaseUrl"] = origin;
            }

            return new ItemBodyHandlers(
                new StubTree(item, Workspace),
                new Gate(canRead ? [Workspace] : [], canWrite ? [Workspace] : []),
                new StubLocks(open),
                new StubSession(session ? NixSessionContext.ForTenant(Tenant, Principal) : null),
                new ItemBodyClient(http, new ConfigurationBuilder().AddInMemoryCollection(values).Build()));
        }
    }

    private sealed class Gate(IReadOnlyList<WorkspaceId> readable, IReadOnlyList<WorkspaceId> writable) : IPermissionResolver
    {
        public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(readable.Contains(workspaceId));

        public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(writable.Contains(workspaceId));

        public ValueTask<bool> CanCommentWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);


        public ValueTask<bool> CanManageWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(false);

        public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(readable);

        public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(false);
    }

    private sealed class RecordingHandler(HttpStatusCode status, string body) : HttpMessageHandler
    {
        public int Calls { get; private set; }

        public HttpMethod? Method { get; private set; }

        public Uri? Uri { get; private set; }

        public string? Authorization { get; private set; }

        public string? Body { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Calls++;
            Method = request.Method;
            Uri = request.RequestUri;
            Authorization = request.Headers.Authorization?.ToString();
            Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
        }
    }

    private sealed class ThrowingHandler : HttpMessageHandler
    {
        public int Calls { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Calls++;
            throw new HttpRequestException("The collaboration service is down.");
        }
    }
}
