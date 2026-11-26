using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Nix.Features.Pets;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

public sealed partial class PetRunStoreTests
{
    [Theory]
    [Trait("Category", "PetPlanReadBatch")]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Read_batches_respect_the_read_preference_and_never_dispatch_the_deferred_write(bool readWithoutAsking)
    {
        var prepared = await CreatePreparedPairAsync();
        using var adapter = new ReadBatchAdapter(prepared.First.Value, prepared.Second.Value, readWithoutAsking, readOnly: false, mixed: true);
        await using var host = CreateReadPlanHost(adapter);
        adapter.Host = host;
        var browser = await SignInAsync(host);
        var route = await StartReadBatchAsync(host, browser, adapter, prepared.Run.State.GetProperty("petId").GetGuid());
        if (!readWithoutAsking)
        {
            var review = await WaitForRunAsync(host, browser, route, "waiting_for_approval");
            var plan = review.GetProperty("plan");
            var steps = plan.GetProperty("steps").EnumerateArray().ToArray();
            Assert.Single(steps, step => step.GetProperty("status").GetString() == "pending");
            Assert.Equal("workspace.read_item", steps[0].GetProperty("capability").GetString());
            Assert.Equal("cancelled", steps[1].GetProperty("status").GetString());
            Assert.Equal(0, adapter.ReadCalls);
            Assert.Equal("Second prepared note", await ReadPreparedTitleAsync(prepared.Second));
            using (var stale = await host.SendAsync(HttpMethod.Post, route + $"/plans/{plan.GetProperty("id").GetGuid():D}/decision", browser,
                new
                {
                    expectedRunRevision = review.GetProperty("revision").GetInt64(),
                    planVersion = plan.GetProperty("version").GetInt32(),
                    reviewDigest = "wrong-read-review",
                    approve = true,
                    requestId = Guid.NewGuid()
                }))
            {
                Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
            }
            Assert.Equal(0, adapter.ReadCalls);
            using var accepted = await host.SendAsync(HttpMethod.Post, route + $"/plans/{plan.GetProperty("id").GetGuid():D}/decision", browser,
                new
                {
                    expectedRunRevision = review.GetProperty("revision").GetInt64(),
                    planVersion = plan.GetProperty("version").GetInt32(),
                    reviewDigest = plan.GetProperty("reviewDigest").GetString(),
                    approve = true,
                    requestId = Guid.NewGuid()
                });
            accepted.EnsureSuccessStatusCode();
        }
        var completed = await WaitForRunAsync(host, browser, route, "completed");
        var finalPlan = completed.GetProperty("plan");
        Assert.Equal("applied", finalPlan.GetProperty("steps")[0].GetProperty("status").GetString());
        Assert.Equal("cancelled", finalPlan.GetProperty("steps")[1].GetProperty("status").GetString());
        if (readWithoutAsking)
        {
            Assert.Equal(JsonValueKind.Null, finalPlan.GetProperty("decision").ValueKind);
        }
        Assert.Equal(1, adapter.ReadCalls);
        Assert.Equal(0, adapter.WriteDispatches);
        Assert.Equal(0, adapter.ModelCalls);
        Assert.Equal("Test target note", await ReadPreparedTitleAsync(prepared.First));
        Assert.Equal("Second prepared note", await ReadPreparedTitleAsync(prepared.Second));
        Assert.Equal(2, adapter.Resolutions.Count);
        Assert.Contains(adapter.Resolutions, result => result.GetProperty("binding").GetProperty("toolId").GetString() == "read-source"
            && result.GetProperty("success").GetBoolean() && result.GetProperty("sourceItemIds").EnumerateArray().Any(id => id.GetGuid() == prepared.First.Value));
        Assert.Contains(adapter.Resolutions, result => result.GetProperty("binding").GetProperty("toolId").GetString() == "deferred-write"
            && !result.GetProperty("success").GetBoolean());
    }

    [Fact]
    [Trait("Category", "PetPlanReadBatch")]
    public async Task A_selected_conversation_source_cannot_be_broadened_by_a_workspace_task_request()
    {
        var prepared = await CreatePreparedPairAsync();
        using var adapter = new ReadBatchAdapter(prepared.First.Value, prepared.Second.Value, readWithoutAsking: true, readOnly: false, mixed: false, selectedSource: true);
        await using var host = CreateReadPlanHost(adapter);
        adapter.Host = host;
        var browser = await SignInAsync(host);
        var route = await StartReadBatchAsync(host, browser, adapter, prepared.Run.State.GetProperty("petId").GetGuid());
        var stopped = await WaitForRunAsync(host, browser, route, "waiting_for_input");
        var question = stopped.GetProperty("sharingQuestion");
        Assert.Equal("selected", question.GetProperty("sourceScope").GetProperty("kind").GetString());
        Assert.Equal(prepared.First.Value, Assert.Single(question.GetProperty("sourceScope").GetProperty("itemIds").EnumerateArray()).GetGuid());
        Assert.Equal(JsonValueKind.Null, stopped.GetProperty("plan").ValueKind);
        Assert.Equal(0, adapter.ReadCalls);
        Assert.Equal(0, adapter.WriteDispatches);
        Assert.Equal(0, adapter.ModelCalls);
        Assert.Equal("Second prepared note", await ReadPreparedTitleAsync(prepared.Second));
        await InSessionAsync(TestTenants.AlphaContext, async store =>
        {
            var current = (await store.ListAsync(AlphaWorkspace, null, Cancellation)).Single(run => route.EndsWith(run.Id.ToString("D"), StringComparison.Ordinal));
            var scope = current.State.GetProperty("planRequest").GetProperty("sourceScope");
            Assert.Equal("selected", scope.GetProperty("kind").GetString());
            Assert.Equal(prepared.First.Value, Assert.Single(scope.GetProperty("itemIds").EnumerateArray()).GetGuid());
            return true;
        });
        JsonElement selectedQuestion;
        using (var asked = await host.SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{AlphaWorkspace.Value:D}/pet-sharing/question", browser,
            new { petId = prepared.Run.State.GetProperty("petId").GetGuid(), sourceScope = question.GetProperty("sourceScope"), forDecision = true }))
        {
            asked.EnsureSuccessStatusCode();
            using var response = await SiteHttpHost.JsonAsync(asked);
            selectedQuestion = response.RootElement.GetProperty("question").Clone();
        }
        Assert.Equal(question.GetProperty("scopeDigest").GetString(), selectedQuestion.GetProperty("scopeDigest").GetString());
        using (var accepted = await host.SendAsync(HttpMethod.Post, route + "/sharing/decision", browser,
            new
            {
                expectedRunRevision = stopped.GetProperty("revision").GetInt64(),
                recipientRevision = selectedQuestion.GetProperty("recipientRevision").GetString(),
                scopeDigest = selectedQuestion.GetProperty("scopeDigest").GetString(),
                decisionNonce = selectedQuestion.GetProperty("decisionNonce").GetString(),
                approve = true,
                requestId = Guid.NewGuid()
            }))
        {
            accepted.EnsureSuccessStatusCode();
        }
        var completed = await WaitForRunAsync(host, browser, route, "completed");
        Assert.Equal("selected", completed.GetProperty("sourceScope").GetProperty("kind").GetString());
        Assert.Equal(prepared.First.Value, Assert.Single(completed.GetProperty("sourceScope").GetProperty("itemIds").EnumerateArray()).GetGuid());
        Assert.Equal(1, adapter.ReadCalls);
        Assert.Equal(0, adapter.WriteDispatches);
        Assert.Equal(0, adapter.ModelCalls);
        Assert.True(Assert.Single(adapter.Resolutions).GetProperty("success").GetBoolean());
    }

    [Fact]
    [Trait("Category", "PetPlanReadBatch")]
    public async Task A_read_only_source_cannot_prepare_a_write_even_before_any_read_is_approved()
    {
        var prepared = await CreatePreparedPairAsync();
        using var adapter = new ReadBatchAdapter(prepared.First.Value, prepared.Second.Value, readWithoutAsking: false, readOnly: true, mixed: false, writeOnly: true);
        await using var host = CreateReadPlanHost(adapter);
        adapter.Host = host;
        var browser = await SignInAsync(host);
        var route = await StartReadBatchAsync(host, browser, adapter, prepared.Run.State.GetProperty("petId").GetGuid());
        var stopped = await WaitForRunAsync(host, browser, route, "review_required");
        Assert.Equal(JsonValueKind.Null, stopped.GetProperty("plan").ValueKind);
        Assert.Equal("pet_plans.preview_unavailable", stopped.GetProperty("failure").GetProperty("code").GetString());
        Assert.Equal(0, adapter.WriteDispatches);
        Assert.Equal(0, adapter.ReadCalls);
        Assert.Equal(0, adapter.ModelCalls);
        Assert.Equal("Second prepared note", await ReadPreparedTitleAsync(prepared.Second));
    }

    [Fact]
    [Trait("Category", "PetPlanReadBatch")]
    public async Task Feedback_in_a_read_only_conversation_cannot_turn_its_read_review_into_a_write()
    {
        var prepared = await CreatePreparedPairAsync();
        using var adapter = new ReadBatchAdapter(prepared.First.Value, prepared.Second.Value, readWithoutAsking: false, readOnly: true, mixed: false);
        await using var host = CreateReadPlanHost(adapter);
        adapter.Host = host;
        var browser = await SignInAsync(host);
        var route = await StartReadBatchAsync(host, browser, adapter, prepared.Run.State.GetProperty("petId").GetGuid());
        var review = await WaitForRunAsync(host, browser, route, "waiting_for_approval");
        using (var feedback = await host.SendAsync(HttpMethod.Post, route + "/drafts", browser,
            new
            {
                expectedRunRevision = review.GetProperty("revision").GetInt64(),
                planVersion = review.GetProperty("plan").GetProperty("version").GetInt32(),
                feedback = "Rename the second note instead.",
                requestId = Guid.NewGuid()
            }))
        {
            feedback.EnsureSuccessStatusCode();
        }
        await WaitForRunAsync(host, browser, route, "failed");
        Assert.Equal(1, adapter.ModelCalls);
        Assert.Equal(0, adapter.WriteDispatches);
        Assert.Equal(0, adapter.ReadCalls);
        Assert.Equal("Second prepared note", await ReadPreparedTitleAsync(prepared.Second));
        await InSessionAsync(TestTenants.AlphaContext, async store =>
        {
            var current = (await store.ListAsync(AlphaWorkspace, null, Cancellation)).Single(run => route.EndsWith(run.Id.ToString("D"), StringComparison.Ordinal));
            Assert.True(current.State.GetProperty("planRequest").GetProperty("sourceReadOnly").GetBoolean());
            return true;
        });
    }

    [Fact]
    [Trait("Category", "PetPlanReadBatch")]
    public async Task Declining_an_exact_read_review_resolves_the_original_call_without_discovery()
    {
        var prepared = await CreatePreparedPairAsync();
        using var adapter = new ReadBatchAdapter(prepared.First.Value, prepared.Second.Value, readWithoutAsking: false, readOnly: true, mixed: false);
        await using var host = CreateReadPlanHost(adapter);
        adapter.Host = host;
        var browser = await SignInAsync(host);
        var route = await StartReadBatchAsync(host, browser, adapter, prepared.Run.State.GetProperty("petId").GetGuid());
        var review = await WaitForRunAsync(host, browser, route, "waiting_for_approval");
        var plan = review.GetProperty("plan");
        using (var declined = await host.SendAsync(HttpMethod.Post, route + $"/plans/{plan.GetProperty("id").GetGuid():D}/decision", browser,
            new
            {
                expectedRunRevision = review.GetProperty("revision").GetInt64(),
                planVersion = plan.GetProperty("version").GetInt32(),
                reviewDigest = plan.GetProperty("reviewDigest").GetString(),
                approve = false,
                requestId = Guid.NewGuid()
            }))
        {
            declined.EnsureSuccessStatusCode();
        }
        var cancelled = await WaitForRunAsync(host, browser, route, "cancelled");
        Assert.False(cancelled.GetProperty("plan").GetProperty("decision").GetProperty("approve").GetBoolean());
        Assert.Equal(0, adapter.ReadCalls);
        Assert.Equal(0, adapter.WriteDispatches);
        Assert.Equal(0, adapter.ModelCalls);
        Assert.False(Assert.Single(adapter.Resolutions).GetProperty("success").GetBoolean());
    }

    private SiteHttpHost CreateReadPlanHost(ReadBatchAdapter adapter) => SiteHttpHost.Create(fixture,
        new Dictionary<string, string?>
        {
            ["Nix:Bff:PublicOrigin"] = PetOrigin,
            ["Nix:Pets:WorkerUrl"] = "https://read-plan-adapter.invalid/",
            ["Nix:PetRuns:Enabled"] = "true",
            ["Nix:PetRuns:AllowedWorkspaces:0"] = AlphaWorkspace.Value.ToString("D"),
            ["Nix:Workers:Families:0"] = "pet-plan",
        }, services =>
        {
            services.AddSingleton(PetTestKeys.Protector);
            services.AddHttpClient<PetWorkerClient>().ConfigurePrimaryHttpMessageHandler(() => adapter);
        });

    private static async Task<string> StartReadBatchAsync(SiteHttpHost host, string browser, ReadBatchAdapter adapter, Guid pet, bool approveSharing = true)
    {
        JsonElement created;
        using (var response = await host.SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{AlphaWorkspace.Value:D}/pet-plans", browser,
            new
            {
                petId = pet,
                brief = "Read the shared source before preparing changes.",
                sourceScope = new { kind = "workspace" },
                requestId = Guid.NewGuid(),
                chatSource = new { conversationId = "synthetic-read-conversation", turnId = Guid.NewGuid(), toolCallIds = adapter.ToolIds }
            }))
        {
            response.EnsureSuccessStatusCode();
            using var body = await SiteHttpHost.JsonAsync(response);
            created = body.RootElement.Clone();
        }
        var route = $"/api/v1/workspaces/{AlphaWorkspace.Value:D}/pet-plans/{created.GetProperty("id").GetGuid():D}";
        var sharing = created.GetProperty("sharingQuestion");
        using var accepted = await host.SendAsync(HttpMethod.Post, route + "/sharing/decision", browser,
            new
            {
                expectedRunRevision = created.GetProperty("revision").GetInt64(),
                recipientRevision = sharing.GetProperty("recipientRevision").GetString(),
                scopeDigest = sharing.GetProperty("scopeDigest").GetString(),
                decisionNonce = sharing.GetProperty("decisionNonce").GetString(),
                approve = approveSharing,
                requestId = Guid.NewGuid()
            });
        accepted.EnsureSuccessStatusCode();
        return route;
    }

    private sealed class ReadBatchAdapter(Guid source, Guid writeTarget, bool readWithoutAsking, bool readOnly, bool mixed, bool writeOnly = false, bool selectedSource = false) : HttpMessageHandler
    {
        private readonly Dictionary<string, JsonElement> _bindings = new(StringComparer.Ordinal);
        private readonly TaskCompletionSource _inspectionEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _inspectionRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal SiteHttpHost Host { get; set; } = null!;
        internal string[] ToolIds => writeOnly ? ["deferred-write"] : mixed ? ["read-source", "deferred-write"] : ["read-source"];
        internal ConcurrentQueue<JsonElement> Resolutions { get; } = new();
        internal ConcurrentQueue<JsonElement> Supersessions { get; } = new();
        internal Guid[] RevisedWriteTargets { get; set; } = [];
        internal string? WriteOutcome { get; set; }
        internal ConcurrentQueue<string> WrittenReceipts { get; } = new();
        internal ConcurrentQueue<JsonElement> Cancellations { get; } = new();
        internal bool HoldInspection { get; set; }
        internal Task InspectionEntered => _inspectionEntered.Task;
        internal int InspectionCalls { get; private set; }
        internal void ReleaseInspection() => _inspectionRelease.TrySetResult();
        internal int ReadCalls { get; private set; }
        internal int WriteDispatches { get; private set; }
        internal int ModelCalls { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            using var input = await request.Content!.ReadFromJsonAsync<JsonDocument>(cancellationToken);
            var root = input!.RootElement;
            if (request.RequestUri!.AbsolutePath == "/v1/companion")
            {
                switch (root.GetProperty("operation").GetString())
                {
                    case "plan_tools_inspect":
                        InspectionCalls++;
                        using (var requested = JsonDocument.Parse(root.GetProperty("planPayload").GetString()!))
                        {
                            Assert.Equal(ToolIds, requested.RootElement.GetProperty("toolIds").EnumerateArray().Select(id => id.GetString()));
                        }
                        if (HoldInspection && _bindings.Count == 0)
                        {
                            _inspectionEntered.TrySetResult();
                            await _inspectionRelease.Task.WaitAsync(cancellationToken);
                        }
                        return Json(new
                        {
                            turnId = root.GetProperty("requestId").GetString(),
                            readOnly,
                            readWithoutAsking,
                            lockedRead = false,
                            sourceScope = selectedSource ? (object)new { kind = "selected", itemIds = new[] { source } } : new { kind = "workspace" },
                            contextSourceItemIds = Array.Empty<Guid>(),
                            contextUnbounded = false,
                            contextProtected = false,
                            tools = ToolIds.Select(id => new
                            {
                                id,
                                status = _bindings.ContainsKey(id) ? "adopted" : "planned",
                                arguments = FlatArguments(id == "read-source" ? "read_item" : "rename_item").GetRawText(),
                                planBinding = _bindings.TryGetValue(id, out var binding) ? binding : (JsonElement?)null
                            })
                        });
                    case "plan_tools_adopt":
                    case "plan_tools_supersede":
                        using (var payload = JsonDocument.Parse(root.GetProperty("planPayload").GetString()!))
                        {
                            if (root.GetProperty("operation").ValueEquals("plan_tools_supersede"))
                            {
                                Supersessions.Enqueue(payload.RootElement.Clone());
                            }
                            foreach (var entry in payload.RootElement.GetProperty("bindings").EnumerateArray())
                            {
                                var binding = entry.TryGetProperty("next", out var next) ? next : entry;
                                if (entry.TryGetProperty("previous", out var previous))
                                {
                                    var toolId = previous.GetProperty("toolId").GetString()!;
                                    Assert.True(_bindings.TryGetValue(toolId, out var stored));
                                    Assert.True(JsonElement.DeepEquals(stored, previous));
                                    Assert.Equal(toolId, binding.GetProperty("toolId").GetString());
                                    Assert.Equal(previous.GetProperty("planVersion").GetInt32() + 1, binding.GetProperty("planVersion").GetInt32());
                                }
                                _bindings[binding.GetProperty("toolId").GetString()!] = binding.Clone();
                            }
                        }
                        return Json(new { adopted = true, superseded = true });
                    case "plan_tools_resolve":
                        using (var payload = JsonDocument.Parse(root.GetProperty("planPayload").GetString()!))
                        {
                            Resolutions.Enqueue(payload.RootElement.Clone());
                        }
                        return Json(new { resolved = true });
                    case "plan_tools_cancel":
                        using (var payload = JsonDocument.Parse(root.GetProperty("planPayload").GetString()!))
                        {
                            Cancellations.Enqueue(payload.RootElement.Clone());
                        }
                        return Json(new { cancelled = true });
                    case "plan_task_step":
                        ModelCalls++;
                        if (RevisedWriteTargets.Length > 0)
                        {
                            return PlanningResult(JsonSerializer.Serialize(new
                            {
                                kind = "plan",
                                summary = "Revised independent target titles",
                                steps = RevisedWriteTargets.Select((target, index) => new
                                {
                                    capability = "workspace.rename_item",
                                    arguments = new { itemId = target, title = $"Reviewed revision {index + 1}" }
                                })
                            }));
                        }
                        return PlanningResult(JsonSerializer.Serialize(new
                        {
                            kind = "plan",
                            summary = "Attempted write after owner feedback",
                            steps = new[] { new { capability = "workspace.rename_item", arguments = new { itemId = writeTarget, title = "Unapproved feedback rename" } } }
                        }));
                    default:
                        throw new InvalidOperationException("Unexpected model request in a synthetic read batch.");
                }
            }
            if (request.RequestUri.AbsolutePath != "/v1/sani/pet-workspace-plan")
            {
                throw new InvalidOperationException("The read adapter cannot leave its private RPC route.");
            }
            switch (root.GetProperty("kind").GetString())
            {
                case "catalog":
                    return Json(new
                    {
                        ok = true,
                        capabilities = ClientWorkspaceAdapter.ClientCapabilityNames.Select(name =>
                        new { name = "workspace." + name, description = "Synthetic workspace operation", inputSchema = new { type = "object" } })
                    });
                case "prepare_flat":
                    using (var flat = JsonDocument.Parse(root.GetProperty("arguments").GetString()!))
                    {
                        return Prepared(flat.RootElement);
                    }
                case "prepare":
                    var native = root.GetProperty("arguments");
                    return Prepared(JsonSerializer.SerializeToElement(new
                    {
                        operation = root.GetProperty("capability").GetString()!["workspace.".Length..],
                        itemId = native.GetProperty("itemId").GetString(),
                        parentId = "",
                        title = native.TryGetProperty("title", out var title) ? title.GetString() : "",
                        markdown = "",
                        query = "",
                        propertiesJson = "",
                        specJson = "",
                    }));
                case "discover":
                    using (var read = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/items/{source:D}"))
                    {
                        read.Headers.Authorization = new AuthenticationHeaderValue("Bearer", root.GetProperty("token").GetString());
                        using var response = await Host.Client.SendAsync(read, cancellationToken);
                        response.EnsureSuccessStatusCode();
                        var body = await response.Content.ReadAsStringAsync(cancellationToken);
                        ReadCalls++;
                        return Json(new
                        {
                            ok = true,
                            state = "completed",
                            receipt = body,
                            lockedContent = false,
                            sourceItemIds = new[] { source },
                            unboundedSourceProvenance = false
                        });
                    }
                case "execute":
                    WriteDispatches++;
                    if (WriteOutcome is null)
                    {
                        throw new InvalidOperationException("A read phase must never dispatch a write.");
                    }
                    using (var arguments = JsonDocument.Parse(root.GetProperty("prepared").GetProperty("arguments").GetString()!))
                    {
                        var target = arguments.RootElement.GetProperty("itemId").GetGuid();
                        var targetRoute = $"/api/v1/items/{target:D}";
                        var body = JsonSerializer.Serialize(new { title = arguments.RootElement.GetProperty("title").GetString() });
                        using var issued = await CallbackAsync("/internal/pet-plans/requests/issue", new
                        {
                            tenantId = TestTenants.Alpha,
                            principalId = AlphaActor.Value,
                            workspaceId = AlphaWorkspace.Value,
                            binding = root.GetProperty("binding"),
                            childId = 1,
                            destination = "core",
                            method = "PATCH",
                            target = targetRoute,
                            body,
                            headers = new Dictionary<string, string>(),
                            executor = "server",
                        });
                        issued.EnsureSuccessStatusCode();
                        using var permit = await SiteHttpHost.JsonAsync(issued);
                        using var write = new HttpRequestMessage(HttpMethod.Patch, targetRoute) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
                        write.Headers.Authorization = new AuthenticationHeaderValue("Bearer", permit.RootElement.GetProperty("token").GetString());
                        foreach (var header in permit.RootElement.GetProperty("headers").EnumerateObject())
                        {
                            write.Headers.TryAddWithoutValidation(header.Name, header.Value.GetString());
                        }
                        using var response = await Host.Client.SendAsync(write, cancellationToken);
                        response.EnsureSuccessStatusCode();
                        var receipt = await response.Content.ReadAsStringAsync(cancellationToken);
                        WrittenReceipts.Enqueue(receipt);
                        return Json(new { ok = true, state = WriteOutcome, receipt, sourceItemIds = new[] { target }, unboundedSourceProvenance = false });
                    }
                default:
                    throw new InvalidOperationException("Unexpected trusted read RPC.");
            }
        }

        private async Task<HttpResponseMessage> CallbackAsync(string route, object body)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, route) { Content = JsonContent.Create(body) };
            request.Headers.Add("X-Nix-Internal-Secret", SiteHttpHost.InternalSecret);
            return await Host.Client.SendAsync(request, Cancellation);
        }

        private JsonElement FlatArguments(string operation) => JsonSerializer.SerializeToElement(new
        {
            operation,
            itemId = (operation == "read_item" ? source : writeTarget).ToString("D"),
            parentId = "",
            title = operation == "rename_item" ? "Unapproved deferred rename" : "",
            markdown = "",
            query = "",
            propertiesJson = "",
            specJson = "",
        });
        private static HttpResponseMessage Prepared(JsonElement args)
        {
            var operation = args.GetProperty("operation").GetString();
            return Json(new
            {
                ok = true,
                prepared = new
                {
                    operation,
                    arguments = args.GetRawText(),
                    argumentFingerprint = args.GetRawText(),
                    freshnessFingerprint = "synthetic-read-context",
                    preview = new
                    {
                        headline = operation == "read_item" ? "Read the selected source" : "Rename the selected target to " + args.GetProperty("title").GetString(),
                        destination = new { title = "Selected source", path = Array.Empty<object>() },
                        counts = new { items = 0, fields = 0, views = 0, entries = 0, writes = operation == "read_item" ? 0 : 1 },
                        tree = Array.Empty<object>(),
                        notes = Array.Empty<string>(),
                        warnings = Array.Empty<string>(),
                        problems = Array.Empty<string>(),
                        neverDoes = Array.Empty<string>()
                    },
                    execution = "server",
                    lockedRead = false,
                    fields = Array.Empty<object>(),
                    targetIds = new[] { args.GetProperty("itemId").GetGuid() },
                    revisions = ""
                }
            });
        }
        private static HttpResponseMessage Json(object value) => new(HttpStatusCode.OK) { Content = JsonContent.Create(value) };
    }
}
