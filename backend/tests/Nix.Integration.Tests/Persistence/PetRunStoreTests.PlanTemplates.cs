using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Items;
using Nix.Domain.Templates;
using Nix.Features.Pets;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Templates;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

public sealed partial class PetRunStoreTests
{
    [Theory]
    [Trait("Category", "PetPlanTemplate")]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task Template_continuations_bind_the_exact_parent_body_and_generated_stage_before_publishing(bool withBody, bool reviseBeforeBegin)
    {
        var prepared = await CreatePreparedTemplateAsync(withBody);
        using var adapter = new TemplatePlanAdapter(prepared);
        await using var host = CreateTemplatePlanHost(adapter);
        adapter.Host = host;
        var browser = await SignInAsync(host);
        var route = $"/api/v1/workspaces/{AlphaWorkspace.Value:D}/pet-plans/{prepared.Run.Id:D}";
        var review = await WaitForRunAsync(host, browser, route, "waiting_for_approval");
        using (var approved = await host.SendAsync(HttpMethod.Post, route + $"/plans/{prepared.PlanId:D}/decision", browser,
            new { expectedRunRevision = review.GetProperty("revision").GetInt64(), planVersion = 1, reviewDigest = prepared.Digest, approve = true, requestId = Guid.NewGuid() }))
        {
            approved.EnsureSuccessStatusCode();
        }
        var outer = await adapter.Outer.WaitAsync(TimeSpan.FromSeconds(15), Cancellation);
        if (reviseBeforeBegin)
        {
            var before = await CountTemplateChildrenAsync(prepared.Parent);
            await AdvancePreparedTemplateRevisionAsync(prepared);
            using var refused = await SendTemplateContinuationAsync(host, outer.Token, HttpMethod.Post,
                "/internal/templates/applications/begin", prepared.Body);
            Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
            Assert.Equal("templates.conflict", await SiteHttpHost.ProblemCodeAsync(refused));
            Assert.Equal(before, await CountTemplateChildrenAsync(prepared.Parent));
            adapter.CompletionState = "refused";
            await adapter.CompleteAsync(outer, await refused.Content.ReadAsStringAsync(Cancellation), 409);
            var held = await WaitForRunAsync(host, browser, route, "review_required");
            Assert.Equal("refused", held.GetProperty("plan").GetProperty("steps")[0].GetProperty("status").GetString());
            Assert.Equal(1, adapter.ExecutionCalls);
            Assert.Equal(0, adapter.ModelCalls);
            return;
        }
        var changedParent = JsonNode.Parse(prepared.Body)!.AsObject();
        changedParent["parentItemId"] = M0SchemaSeed.Alpha.ItemId;
        await AssertTemplateRefusedAsync(host, outer.Token, HttpMethod.Post, "/internal/templates/applications/begin", changedParent.ToJsonString());
        var changedBody = JsonNode.Parse(prepared.Body)!.AsObject();
        changedBody["title"] = "A title outside the reviewed application";
        await AssertTemplateRefusedAsync(host, outer.Token, HttpMethod.Post, "/internal/templates/applications/begin", changedBody.ToJsonString());
        var changedRevision = JsonNode.Parse(prepared.Body)!.AsObject();
        changedRevision["expectedRevision"] = 2;
        await AssertTemplateRefusedAsync(host, outer.Token, HttpMethod.Post, "/internal/templates/applications/begin", changedRevision.ToJsonString());
        await AssertTemplateRefusedAsync(host, outer.Token, HttpMethod.Post,
            $"/internal/templates/applications/{Guid.NewGuid():D}/finalize", "{\"writtenTargetItemIds\":[]}");

        JsonElement begun;
        using (var response = await SendTemplateContinuationAsync(host, outer.Token, HttpMethod.Post,
            "/internal/templates/applications/begin", prepared.Body))
        {
            response.EnsureSuccessStatusCode();
            using var body = await SiteHttpHost.JsonAsync(response);
            begun = body.RootElement.Clone();
        }
        var operation = begun.GetProperty("applicationId").GetGuid();
        var target = ItemId.From(begun.GetProperty("targetItemId").GetGuid());
        var copies = begun.GetProperty("bodyCopies").EnumerateArray().ToArray();
        Assert.Equal(withBody ? 1 : 0, copies.Length);
        Assert.Null(await ReadVisibleTemplateTargetAsync(target));
        if (!withBody)
        {
            await AdvancePreparedTemplateRevisionAsync(prepared);
        }
        await AssertTemplateRefusedAsync(host, outer.Token, HttpMethod.Post, "/internal/templates/applications/begin", prepared.Body);
        await AssertTemplateRefusedAsync(host, outer.Token, HttpMethod.Get,
            $"/internal/template-operations/{Guid.NewGuid():D}/items/{target.Value:D}/authorization");
        await AssertTemplateRefusedAsync(host, outer.Token, HttpMethod.Get,
            $"/internal/template-operations/{operation:D}/items/{prepared.Parent.Value:D}/authorization");
        if (withBody)
        {
            var source = Assert.Single(copies).GetProperty("sourceItemId").GetGuid();
            using (var authorized = await SendTemplateContinuationAsync(host, outer.Token, HttpMethod.Get,
                $"/internal/template-operations/{operation:D}/items/{source:D}/authorization"))
            {
                authorized.EnsureSuccessStatusCode();
                using var body = await SiteHttpHost.JsonAsync(authorized);
                Assert.True(body.RootElement.GetProperty("isSource").GetBoolean());
                Assert.False(body.RootElement.GetProperty("canWrite").GetBoolean());
            }
            using (var authorized = await SendTemplateContinuationAsync(host, outer.Token, HttpMethod.Get,
                $"/internal/template-operations/{operation:D}/items/{target.Value:D}/authorization"))
            {
                authorized.EnsureSuccessStatusCode();
                using var body = await SiteHttpHost.JsonAsync(authorized);
                Assert.True(body.RootElement.GetProperty("isTarget").GetBoolean());
                Assert.True(body.RootElement.GetProperty("canWrite").GetBoolean());
            }
        }
        var written = copies.Select(copy => copy.GetProperty("targetItemId").GetGuid()).ToArray();
        var finalize = JsonSerializer.Serialize(new { writtenTargetItemIds = written });
        await AssertTemplateRefusedAsync(host, outer.Token, HttpMethod.Post,
            $"/internal/templates/applications/{Guid.NewGuid():D}/finalize", finalize);
        await AssertTemplateRefusedAsync(host, outer.Token, HttpMethod.Post,
            $"/internal/templates/applications/{operation:D}/finalize", JsonSerializer.Serialize(new { writtenTargetItemIds = written.Append(prepared.Parent.Value) }));
        await AssertTemplateRefusedAsync(host, outer.Token, HttpMethod.Post,
            $"/internal/templates/applications/{operation:D}/finalize", JsonSerializer.Serialize(new { writtenTargetItemIds = written, externalReferenceTargets = Array.Empty<Guid>() }));
        if (withBody)
        {
            await SeedTemplateBodyAsync(target);
        }
        string receipt;
        using (var response = await SendTemplateContinuationAsync(host, outer.Token, HttpMethod.Post,
            $"/internal/templates/applications/{operation:D}/finalize", finalize))
        {
            response.EnsureSuccessStatusCode();
            receipt = await response.Content.ReadAsStringAsync(Cancellation);
            using var body = JsonDocument.Parse(receipt);
            Assert.Equal(target.Value, body.RootElement.GetProperty("targetItemId").GetGuid());
        }
        var applied = await ReadVisibleTemplateTargetAsync(target);
        Assert.NotNull(applied);
        Assert.Equal(prepared.Parent, applied.ParentId);
        Assert.Equal("Reviewed applied template", ItemProperties.ReadTitle(applied.Properties));
        await AssertTemplateRefusedAsync(host, outer.Token, HttpMethod.Post,
            $"/internal/templates/applications/{operation:D}/finalize", finalize);
        await AssertTemplateRefusedAsync(host, outer.Token, HttpMethod.Get,
            $"/internal/template-operations/{operation:D}/items/{target.Value:D}/authorization");
        await adapter.CompleteAsync(outer, receipt);
        var completed = await WaitForRunAsync(host, browser, route, "completed");
        var step = Assert.Single(completed.GetProperty("plan").GetProperty("steps").EnumerateArray());
        Assert.Equal("applied", step.GetProperty("status").GetString());
        Assert.Equal(receipt, step.GetProperty("receipt").GetString());
        Assert.Equal(1, adapter.ExecutionCalls);
        Assert.Equal(0, adapter.ModelCalls);
    }

    private async Task<PreparedTemplatePlan> CreatePreparedTemplateAsync(bool withBody)
    {
        var (parent, pet) = await CreateNoteWithPetAsync();
        TemplateImportPlan imported;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var begun = await work.Resolve<TemplateStore>().BeginImportAsync(AlphaWorkspace, "plan-template-import-" + Guid.NewGuid().ToString("N"),
                new("plan.template", "Plan template", "Synthetic template fixture", TemplateOrigin.User, null, new string('a', 64), withBody, false),
                [new(Guid.NewGuid(), null, "note", "Template root", 0, "{\"title\":\"Template root\"}", null, null, withBody)], Cancellation);
            Assert.True(begun.IsSuccess, begun.IsFailure ? begun.Error.ToString() : null);
            imported = begun.Value;
            await work.CommitAsync(Cancellation);
        }
        var templateRoot = Assert.Single(imported.ItemMappings).ItemId;
        if (withBody)
        {
            await SeedTemplateBodyAsync(templateRoot);
        }
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var saved = await work.Resolve<TemplateStore>().FinalizeOperationAsync(imported.OperationId!.Value,
                withBody ? [templateRoot] : [], Cancellation);
            Assert.True(saved.IsSuccess, saved.IsFailure ? saved.Error.ToString() : null);
            await work.CommitAsync(Cancellation);
        }
        var body = JsonSerializer.Serialize(new
        {
            templateId = imported.TemplateId.Value,
            mode = "create",
            targetItemId = (Guid?)null,
            parentItemId = parent.Value,
            title = "Reviewed applied template",
            idempotencyKey = "plan-template-apply-" + Guid.NewGuid().ToString("N"),
            inputs = new Dictionary<string, string>(),
            expectedRevision = 1
        });
        var arguments = JsonSerializer.SerializeToElement(new
        {
            operation = "apply_template",
            itemId = imported.TemplateId.Value.ToString("D"),
            parentId = parent.Value.ToString("D"),
            title = "Reviewed applied template",
            markdown = "",
            query = "",
            propertiesJson = "",
            specJson = "{}"
        });
        var snapshot = JsonSerializer.SerializeToElement(new
        {
            operation = "apply_template",
            arguments = arguments.GetRawText(),
            argumentFingerprint = arguments.GetRawText(),
            freshnessFingerprint = "{\"context\":{\"preflight\":{\"templateRevision\":1}}}",
            preview = new
            {
                headline = "Apply the reviewed template",
                destination = new { title = "Reviewed parent", path = Array.Empty<object>() },
                counts = new { items = 1, fields = 0, views = 0, entries = 0, writes = 1 },
                tree = Array.Empty<object>(),
                notes = Array.Empty<string>(),
                warnings = Array.Empty<string>(),
                problems = Array.Empty<string>(),
                neverDoes = Array.Empty<string>()
            },
            execution = "server",
            lockedRead = false,
            fields = new[] { new { id = "title", label = "Title", kind = "text", value = "Reviewed applied template", required = true } },
            targetIds = new[] { parent.Value },
            revisions = ""
        });
        var plan = Guid.NewGuid();
        var startRequestId = Guid.NewGuid();
        const string digest = "prepared-template-review";
        var state = JsonSerializer.SerializeToElement(new
        {
            petId = pet,
            provider = "chatgpt",
            proposals = Array.Empty<object>(),
            results = Array.Empty<object>(),
            answers = Array.Empty<string>(),
            turns = 1,
            planRequest = new { requestId = startRequestId, sourceScope = new { kind = "workspace" } },
            plan = new
            {
                id = plan,
                version = 1,
                summary = "Apply one reviewed template",
                reviewDigest = digest,
                scopeDigest = "prepared-template-scope",
                recipientRevision = "prepared-template-recipient",
                status = "awaiting_review",
                steps = new[] { new { id = Guid.NewGuid(), capability = "workspace.apply_template",
                    arguments, effect = new { description = "Apply the reviewed template", parameters = snapshot }, executor = "server", status = "pending", fields = Array.Empty<object>() } }
            }
        });
        var run = NewRun(parent, state) with { ItemId = null, SourceItemIds = [], WorkspaceScope = true, Abilities = ["workspace.apply_template"], RequestId = startRequestId };
        await SaveWaitingAsync(run, "waiting_for_approval");
        return new(run, plan, digest, parent, body, snapshot);
    }

    private SiteHttpHost CreateTemplatePlanHost(TemplatePlanAdapter adapter) => SiteHttpHost.Create(fixture,
        new Dictionary<string, string?>
        {
            ["Nix:Bff:PublicOrigin"] = PetOrigin,
            ["Nix:PetRuns:Enabled"] = "true",
            ["Nix:PetRuns:AllowedWorkspaces:0"] = AlphaWorkspace.Value.ToString("D"),
            ["Nix:Workers:Families:0"] = "pet-plan",
            ["Nix:Pets:WorkerUrl"] = "https://prepared-template.invalid/",
        }, services =>
        {
            services.AddHttpClient<PetWorkerClient>().ConfigurePrimaryHttpMessageHandler(() => adapter);
            services.AddHttpClient("PetRecipientMetadataClient").ConfigurePrimaryHttpMessageHandler(() => new PreparedRecipientMetadata());
        });

    private async Task<Item?> ReadVisibleTemplateTargetAsync(ItemId item)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        return await work.Resolve<IItemTree>().FindAsync(item, Cancellation);
    }

    private async Task<int> CountTemplateChildrenAsync(ItemId parent)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        return await work.DbContext.Items.IgnoreQueryFilters().CountAsync(item => item.ParentId == parent, Cancellation);
    }

    private async Task AdvancePreparedTemplateRevisionAsync(PreparedTemplatePlan prepared)
    {
        using var body = JsonDocument.Parse(prepared.Body);
        var template = TemplateId.From(body.RootElement.GetProperty("templateId").GetGuid());
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var store = work.Resolve<TemplateStore>();
        var draft = await store.BeginDraftAsync(template, "template-revision-race-" + Guid.NewGuid().ToString("N"), Cancellation);
        Assert.True(draft.IsSuccess, draft.IsFailure ? draft.Error.ToString() : null);
        var changed = await store.UpdateDraftMetadataAsync(template, draft.Value.OperationId, "Revised template fixture", null, Cancellation);
        Assert.True(changed.IsSuccess, changed.IsFailure ? changed.Error.ToString() : null);
        var saved = await store.SaveDraftAsync(template, draft.Value.OperationId, Cancellation);
        Assert.True(saved.IsSuccess, saved.IsFailure ? saved.Error.ToString() : null);
        var current = await store.DetailAsync(template, Cancellation);
        Assert.True(current.IsSuccess);
        Assert.Equal(2, current.Value.Template.Revision);
        await work.CommitAsync(Cancellation);
    }

    private async Task SeedTemplateBodyAsync(ItemId item)
    {
        var builder = new NpgsqlConnectionStringBuilder(fixture.ApplicationConnectionString)
        { Username = NixDatabaseRoles.Collaboration, Password = NixDatabaseRoles.Password };
        await using var connection = new NpgsqlConnection(builder.ConnectionString);
        await connection.OpenAsync(Cancellation);
        await using var transaction = await connection.BeginTransactionAsync(Cancellation);
        await using var command = new NpgsqlCommand("""
            SELECT set_config('nix.tenant_id', @tenant_id, true);
            INSERT INTO content_doc (doc_id, tenant_id, item_id, workspace_id, schema_version, head_seq, created_at)
              VALUES (@doc_id, @tenant_id::uuid, @item_id, @workspace_id, 1, 1, @created_at);
            INSERT INTO content_update (doc_id, seq, tenant_id, update_bytes, actor_id, client_id, created_at)
              VALUES (@doc_id, 1, @tenant_id::uuid, decode('01', 'hex'), @actor_id, 'pet-template-fixture', @created_at);
            INSERT INTO content_snapshot (doc_id, seq, tenant_id, yjs_state, prosemirror_json, plaintext, created_at)
              VALUES (@doc_id, 1, @tenant_id::uuid, decode('01', 'hex'), '{"type":"doc","content":[]}'::jsonb, '', @created_at);
            """, connection, transaction);
        command.Parameters.AddWithValue("tenant_id", TestTenants.Alpha.ToString());
        command.Parameters.AddWithValue("doc_id", Guid.NewGuid());
        command.Parameters.AddWithValue("item_id", item.Value);
        command.Parameters.AddWithValue("workspace_id", AlphaWorkspace.Value);
        command.Parameters.AddWithValue("created_at", DateTimeOffset.UtcNow);
        command.Parameters.AddWithValue("actor_id", AlphaActor.Value);
        await command.ExecuteNonQueryAsync(Cancellation);
        await transaction.CommitAsync(Cancellation);
    }

    private static async Task<HttpResponseMessage> SendTemplateContinuationAsync(SiteHttpHost host, string bearer,
        HttpMethod method, string route, string? body = null)
    {
        using var request = new HttpRequestMessage(method, route);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        request.Headers.Add("X-Nix-Internal-Secret", SiteHttpHost.InternalSecret);
        if (body is not null)
        {
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        }
        return await host.Client.SendAsync(request, Cancellation);
    }

    private static async Task AssertTemplateRefusedAsync(SiteHttpHost host, string bearer, HttpMethod method, string route, string? body = null)
    {
        using var response = await SendTemplateContinuationAsync(host, bearer, method, route, body);
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("pet_plans.dispatch_refused", await SiteHttpHost.ProblemCodeAsync(response));
    }

    private sealed record PreparedTemplatePlan(PetRunRecord Run, Guid PlanId, string Digest, ItemId Parent, string Body, JsonElement Snapshot);
    private sealed record TemplateOuterRequest(Guid RequestId, string Token);

    private sealed class TemplatePlanAdapter(PreparedTemplatePlan prepared) : HttpMessageHandler
    {
        private readonly TaskCompletionSource<TemplateOuterRequest> _outer = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<string> _receipt = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal SiteHttpHost Host { get; set; } = null!;
        internal Task<TemplateOuterRequest> Outer => _outer.Task;
        internal int ModelCalls { get; private set; }
        internal int ExecutionCalls { get; private set; }
        internal string CompletionState { get; set; } = "completed";

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            using var input = await request.Content!.ReadFromJsonAsync<JsonDocument>(cancellationToken);
            var root = input!.RootElement;
            if (request.RequestUri!.AbsolutePath != "/v1/sani/pet-workspace-plan")
            {
                ModelCalls++;
                throw new InvalidOperationException("A prepared template plan cannot call a model.");
            }
            switch (root.GetProperty("kind").GetString())
            {
                case "catalog":
                    return Json(new
                    {
                        ok = true,
                        capabilities = ClientWorkspaceAdapter.ClientCapabilityNames.Select(name =>
                        new { name = "workspace." + name, description = "Synthetic template operation", inputSchema = new { type = "object" } })
                    });
                case "prepare_flat": return Json(new { ok = true, prepared = prepared.Snapshot });
                case "execute":
                    ExecutionCalls++;
                    using (var issued = await CallbackAsync("/internal/pet-plans/requests/issue", new
                    {
                        tenantId = TestTenants.Alpha,
                        principalId = AlphaActor.Value,
                        workspaceId = AlphaWorkspace.Value,
                        binding = root.GetProperty("binding"),
                        childId = 1,
                        destination = "collab",
                        method = "POST",
                        target = "/templates/applications",
                        body = prepared.Body,
                        headers = new Dictionary<string, string>(),
                        executor = "server",
                    }))
                    {
                        issued.EnsureSuccessStatusCode();
                        using var body = await SiteHttpHost.JsonAsync(issued);
                        var outer = new TemplateOuterRequest(body.RootElement.GetProperty("requestId").GetGuid(), body.RootElement.GetProperty("token").GetString()!);
                        using var consumed = await CallbackAsync("/internal/pet-plans/requests/consume", new
                        {
                            token = outer.Token,
                            requestId = outer.RequestId,
                            method = "POST",
                            target = "/templates/applications",
                            body = prepared.Body,
                            headers = body.RootElement.GetProperty("headers"),
                        });
                        consumed.EnsureSuccessStatusCode();
                        _outer.TrySetResult(outer);
                    }
                    var receipt = await _receipt.Task.WaitAsync(cancellationToken);
                    return Json(new { ok = true, state = CompletionState, receipt });
                default: throw new InvalidOperationException("Unexpected template adapter operation.");
            }
        }

        internal async Task CompleteAsync(TemplateOuterRequest outer, string receipt, int status = 200)
        {
            using var settled = await CallbackAsync("/internal/pet-plans/requests/settle", new
            { token = outer.Token, requestId = outer.RequestId, status, headers = new Dictionary<string, string>(), body = receipt });
            settled.EnsureSuccessStatusCode();
            _receipt.TrySetResult(receipt);
        }

        private async Task<HttpResponseMessage> CallbackAsync(string route, object body)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, route) { Content = JsonContent.Create(body) };
            request.Headers.Add("X-Nix-Internal-Secret", SiteHttpHost.InternalSecret);
            return await Host.Client.SendAsync(request, Cancellation);
        }

        private static HttpResponseMessage Json(object body) => new(HttpStatusCode.OK) { Content = JsonContent.Create(body) };

        protected override void Dispose(bool disposing)
        {
            _receipt.TrySetCanceled();
            base.Dispose(disposing);
        }
    }
}
