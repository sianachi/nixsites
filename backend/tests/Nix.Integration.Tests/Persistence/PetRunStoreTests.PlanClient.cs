using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Features.Pets;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

public sealed partial class PetRunStoreTests
{
    [Fact]
    [Trait("Category", "PetPlanClient")]
    public async Task A_client_memory_step_waits_reconnects_to_its_existing_intent_and_saves_only_the_verified_fact()
    {
        var prepared = await CreatePreparedMemoryAsync();
        await using var client = await OpenClientPlanAsync(prepared);
        await ApproveClientPlanAsync(client, prepared);
        var waiting = await WaitForRunAsync(client.Host, client.Browser, client.Route, "waiting_for_handoff");
        Assert.Equal(0, client.Adapter.ExecutionCalls);
        Assert.Equal(0, await MemoryCountAsync());
        Assert.Equal(JsonValueKind.Null, (await ClientIntentAsync(client)).ValueKind);

        var claim = await ClaimClientPlanAsync(client, waiting);
        await WaitForRunAsync(client.Host, client.Browser, client.Route, "waiting_for_handoff");
        var intent = await ClientIntentAsync(client);
        Assert.Equal("GET", intent.GetProperty("method").GetString());
        Assert.Equal("/api/v1/me/pets/settings", intent.GetProperty("target").GetString());
        Assert.Equal(1, client.Adapter.ExecutionCalls);
        using (var forged = await ReportClientIoAsync(client, intent, 200, "{\"revision\":99,\"settings\":{}}"))
        {
            Assert.Equal(HttpStatusCode.UnprocessableEntity, forged.StatusCode);
        }

        var reconnected = await ClaimClientPlanAsync(client, waiting);
        Assert.Equal(claim.GetProperty("claimId").GetGuid(), reconnected.GetProperty("claimId").GetGuid());
        Assert.Equal(claim.GetProperty("executionId").GetGuid(), reconnected.GetProperty("executionId").GetGuid());
        Assert.Equal(intent.GetProperty("requestId").GetGuid(), (await ClientIntentAsync(client)).GetProperty("requestId").GetGuid());
        Assert.Equal(1, client.Adapter.ExecutionCalls);
        using (var reconnectedBrowser = new HttpClient(client.Host.CreateLoopbackHandler()) { BaseAddress = client.Host.Client.BaseAddress })
        {
            reconnectedBrowser.DefaultRequestHeaders.Add("Cookie", client.Host.Client.DefaultRequestHeaders.GetValues("Cookie"));
            reconnectedBrowser.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", client.Browser);
            using var response = await reconnectedBrowser.GetAsync(new Uri(client.Route + "/io", UriKind.Relative), Cancellation);
            response.EnsureSuccessStatusCode();
            using var existingIntent = await SiteHttpHost.JsonAsync(response);
            Assert.Equal(intent.GetProperty("requestId").GetGuid(), existingIntent.RootElement.GetProperty("requestId").GetGuid());
        }

        var read = await DispatchClientIntentAsync(client, intent);
        Assert.Equal(HttpStatusCode.OK, read.Status);
        using (var forged = await ReportClientIoAsync(client, intent, 200, "{\"revision\":100,\"settings\":{}}"))
        {
            Assert.Equal(HttpStatusCode.UnprocessableEntity, forged.StatusCode);
        }
        using (var recorded = await ReportClientIoAsync(client, intent, (int)read.Status, read.Body))
        {
            recorded.EnsureSuccessStatusCode();
        }
        var writeId = await client.Adapter.IssueMemoryWriteAsync(intent.GetProperty("requestId").GetGuid());
        var write = await ClientIntentAsync(client);
        Assert.Equal(writeId, write.GetProperty("requestId").GetGuid());
        Assert.Equal("PUT", write.GetProperty("method").GetString());
        Assert.Equal(0, await MemoryCountAsync());

        using (var inventedReceipt = await client.Host.SendAsync(HttpMethod.Post,
            client.Route + $"/plans/{prepared.PlanId:D}/steps/{prepared.StepId:D}/result", client.Browser,
            new
            {
                planVersion = 1,
                reviewDigest = prepared.Digest,
                claimId = claim.GetProperty("claimId").GetGuid(),
                executionId = claim.GetProperty("executionId").GetGuid(),
                status = "applied",
                receipt = "The browser says the fact was saved."
            }))
        {
            Assert.Equal(HttpStatusCode.UnprocessableEntity, inventedReceipt.StatusCode);
        }
        var saved = await DispatchClientIntentAsync(client, write);
        Assert.Equal(HttpStatusCode.OK, saved.Status);
        using (var forged = await ReportClientIoAsync(client, write, 200, "{\"invented\":true}"))
        {
            Assert.Equal(HttpStatusCode.UnprocessableEntity, forged.StatusCode);
        }
        using (var recorded = await ReportClientIoAsync(client, write, (int)saved.Status, saved.Body))
        {
            recorded.EnsureSuccessStatusCode();
        }
        await client.Adapter.CompleteMemoryAsync(writeId);
        var completed = await WaitForRunAsync(client.Host, client.Browser, client.Route, "completed");
        Assert.Equal("applied", completed.GetProperty("plan").GetProperty("steps")[0].GetProperty("status").GetString());
        Assert.Contains(PreparedMemoryFact, completed.GetProperty("plan").GetProperty("steps")[0].GetProperty("receipt").GetString(), StringComparison.Ordinal);
        Assert.Equal(new[] { PreparedMemoryFact }, await MemoryTextsAsync());
        Assert.Equal(JsonValueKind.Null, (await ClientIntentAsync(client)).ValueKind);
        var replay = await DispatchClientIntentAsync(client, write);
        Assert.Equal(HttpStatusCode.Conflict, replay.Status);
        Assert.Equal(new[] { PreparedMemoryFact }, await MemoryTextsAsync());
        Assert.Equal(1, client.Adapter.ExecutionCalls);
        Assert.Equal(0, client.Adapter.ModelCalls);
    }

    [Theory]
    [Trait("Category", "PetPlanClient")]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task A_cancelled_or_superseded_client_intent_cannot_dispatch(bool supersede, bool collaboration)
    {
        var prepared = await CreatePreparedMemoryAsync(operation: collaboration ? "save_as_template" : "remember");
        await using var client = await OpenClientPlanAsync(prepared);
        client.Adapter.CollaborationIntent = collaboration;
        var waiting = await BeginClientIntentAsync(client, prepared);
        var issued = await ClientIntentAsync(client);
        using var changed = await client.Host.SendAsync(HttpMethod.Post, client.Route + (supersede ? "/drafts" : "/cancel"), client.Browser,
            supersede
                ? new
                {
                    expectedRunRevision = waiting.GetProperty("revision").GetInt64(),
                    planVersion = 1,
                    fieldEdits = new[] { new { stepId = prepared.StepId, fieldId = collaboration ? "title" : "markdown", value = "A separately reviewed value." } },
                    requestId = Guid.NewGuid()
                }
                : (object)new { expectedRunRevision = waiting.GetProperty("revision").GetInt64(), requestId = Guid.NewGuid() });
        changed.EnsureSuccessStatusCode();
        if (collaboration)
        {
            using var refused = await ConsumeCollaborationIntentAsync(client, issued, issued.GetProperty("dispatchPermit").GetString());
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        }
        else
        {
            var refused = await DispatchClientIntentAsync(client, issued);
            Assert.Equal(HttpStatusCode.Conflict, refused.Status);
        }
        Assert.Equal(JsonValueKind.Null, (await ClientIntentAsync(client)).ValueKind);
        Assert.Equal(0, await MemoryCountAsync());
        Assert.Equal(0, client.Adapter.ModelCalls);
    }

    [Fact]
    [Trait("Category", "PetPlanClient")]
    public async Task A_client_cannot_forge_a_collaboration_response_before_or_after_trusted_dispatch()
    {
        var prepared = await CreatePreparedMemoryAsync(operation: "save_as_template");
        await using var client = await OpenClientPlanAsync(prepared);
        client.Adapter.CollaborationIntent = true;
        await BeginClientIntentAsync(client, prepared);
        var intent = await ClientIntentAsync(client);
        Assert.Equal("collab", intent.GetProperty("destination").GetString());
        const string observedBody = "{\"document\":\"synthetic-observed-body\"}";
        using (var invented = await ReportClientIoAsync(client, intent, 200, observedBody))
        {
            Assert.Equal(HttpStatusCode.UnprocessableEntity, invented.StatusCode);
        }
        using (var missingPermit = await ConsumeCollaborationIntentAsync(client, intent, null))
        {
            Assert.Equal(HttpStatusCode.Forbidden, missingPermit.StatusCode);
        }
        var permit = intent.GetProperty("dispatchPermit").GetString();
        using (var consumed = await ConsumeCollaborationIntentAsync(client, intent, permit))
        {
            consumed.EnsureSuccessStatusCode();
        }
        using (var replayed = await ConsumeCollaborationIntentAsync(client, intent, permit))
        {
            Assert.Equal(HttpStatusCode.Forbidden, replayed.StatusCode);
        }
        using (var invented = await ReportClientIoAsync(client, intent, 200, observedBody))
        {
            Assert.Equal(HttpStatusCode.UnprocessableEntity, invented.StatusCode);
        }
        using (var settled = await SendPlanCallbackAsync(client, "/internal/pet-plans/requests/settle", new
        {
            token = client.Browser,
            requestId = intent.GetProperty("requestId").GetGuid(),
            status = 200,
            headers = new Dictionary<string, string> { ["Content-Type"] = "application/json" },
            body = observedBody,
            dispatchPermit = permit,
        }))
        {
            settled.EnsureSuccessStatusCode();
        }
        using (var invented = await ReportClientIoAsync(client, intent, 200, "{\"forged\":true}"))
        {
            Assert.Equal(HttpStatusCode.UnprocessableEntity, invented.StatusCode);
        }
        using (var observed = await ReportClientIoAsync(client, intent, 200, observedBody))
        {
            observed.EnsureSuccessStatusCode();
        }
        Assert.Equal(0, client.Adapter.ModelCalls);
    }

    [Theory]
    [Trait("Category", "PetPlanClient")]
    [InlineData(true, false, "refused")]
    [InlineData(false, true, "stale")]
    public async Task Memory_off_or_protected_source_prevents_a_client_request_from_being_issued(bool memoryOff, bool protectedRead, string expectedStepStatus)
    {
        var prepared = await CreatePreparedMemoryAsync(protectedRead);
        if (memoryOff)
        {
            await SetMemoryModeAsync(PetMemoryModes.Off);
        }
        await using var client = await OpenClientPlanAsync(prepared);
        await ApproveClientPlanAsync(client, prepared);
        var waiting = await WaitForRunAsync(client.Host, client.Browser, client.Route, "waiting_for_handoff");
        await ClaimClientPlanAsync(client, waiting);
        var stopped = await WaitForRunAsync(client.Host, client.Browser, client.Route, "review_required");
        Assert.Equal(expectedStepStatus, stopped.GetProperty("plan").GetProperty("steps")[0].GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, (await ClientIntentAsync(client)).ValueKind);
        Assert.Equal(0, await MemoryCountAsync());
        Assert.Equal(0, client.Adapter.ModelCalls);
    }

    [Theory]
    [Trait("Category", "PetPlanClient")]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Memory_off_or_new_protected_source_revokes_an_already_issued_client_request(bool protectedRead)
    {
        var prepared = await CreatePreparedMemoryAsync();
        await using var client = await OpenClientPlanAsync(prepared);
        await BeginClientIntentAsync(client, prepared);
        var readIntent = await ClientIntentAsync(client);
        var read = await DispatchClientIntentAsync(client, readIntent);
        Assert.Equal(HttpStatusCode.OK, read.Status);
        using (var recorded = await ReportClientIoAsync(client, readIntent, (int)read.Status, read.Body))
        {
            recorded.EnsureSuccessStatusCode();
        }
        await client.Adapter.IssueMemoryWriteAsync(readIntent.GetProperty("requestId").GetGuid());
        var issued = await ClientIntentAsync(client);
        Assert.Equal("PUT", issued.GetProperty("method").GetString());
        if (protectedRead)
        {
            await InSessionAsync(TestTenants.AlphaContext, async store =>
            {
                var run = (await store.GetAsync(prepared.Run.Id, Cancellation))!;
                var state = JsonNode.Parse(run.State.GetRawText())!;
                state["planRequest"]!["protectedRead"] = true;
                Assert.True(await store.UpdateAsync(run with
                {
                    State = JsonSerializer.SerializeToElement(state),
                    Revision = run.Revision + 1
                }, run.Revision, Cancellation));
                return true;
            });
        }
        else
        {
            await SetMemoryModeAsync(PetMemoryModes.Off);
        }
        var refused = await DispatchClientIntentAsync(client, issued);
        Assert.Equal(HttpStatusCode.Conflict, refused.Status);
        Assert.Equal(0, await MemoryCountAsync());
        Assert.Equal(0, client.Adapter.ModelCalls);
    }

    [Theory]
    [Trait("Category", "PetPlanClient")]
    [InlineData("exact", 1)]
    [InlineData("changed-receipt", 0)]
    [InlineData("changed-review", 0)]
    [InlineData("not-applied", 0)]
    public async Task Template_client_receives_only_the_owned_matching_applied_build_ledger(string supplied, int expectedEntries)
    {
        var prepared = await CreatePreparedMemoryAsync(operation: "save_as_template");
        var priorPlan = Guid.NewGuid();
        var priorStep = Guid.NewGuid();
        var priorRequest = Guid.NewGuid();
        const string priorDigest = "owned-build-review";
        var receipt = JsonSerializer.Serialize(new { ledger = new[] { new { nodeId = "built-note", itemId = prepared.NoteId, status = "done" } } });
        using var checkpoint = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            petId = prepared.Run.State.GetProperty("petId").GetGuid(),
            provider = "chatgpt",
            proposals = Array.Empty<object>(),
            results = Array.Empty<object>(),
            answers = Array.Empty<string>(),
            turns = 1,
            planRequest = new { requestId = priorRequest, sourceScope = new { kind = "workspace" } },
            plan = new
            {
                id = priorPlan,
                version = 1,
                summary = "Previously verified build",
                reviewDigest = priorDigest,
                scopeDigest = "owned-build-scope",
                recipientRevision = "owned-build-recipient",
                status = supplied == "not-applied" ? "awaiting_review" : "completed",
                steps = new[] { new { id = priorStep, capability = "workspace.build_blueprint", arguments = new { },
                    effect = new { description = "Built the selected note", parameters = new { } }, executor = "server", status = supplied == "not-applied" ? "pending" : "applied",
                    fields = Array.Empty<object>(), receipt } }
            },
        }));
        var built = NewRun(Nix.Domain.Items.ItemId.From(prepared.NoteId), checkpoint.RootElement) with
        {
            ItemId = null,
            SourceItemIds = [],
            WorkspaceScope = true,
            Abilities = ["workspace.build_blueprint"],
            RequestId = priorRequest,
        };
        await SaveWaitingAsync(built, supplied == "not-applied" ? "waiting_for_approval" : "completed");
        await using var hosted = await OpenClientPlanAsync(prepared);
        hosted.Adapter.ChatArguments = JsonSerializer.SerializeToElement(TemplateArguments(prepared.NoteId));
        hosted.Adapter.BuildReceipts = [new
        {
            binding = new { toolId = "previous-build", runId = built.Id, planId = priorPlan, planVersion = 1,
                reviewDigest = supplied == "changed-review" ? "another-review" : priorDigest, stepId = priorStep },
            result = supplied == "changed-receipt" ? receipt + " " : receipt,
        }];
        JsonElement created;
        using (var start = await hosted.Host.SendAsync(HttpMethod.Post,
            $"/api/v1/workspaces/{AlphaWorkspace.Value:D}/pet-plans", hosted.Browser,
            new
            {
                petId = prepared.Run.State.GetProperty("petId").GetGuid(),
                brief = "Save the reviewed source as a template",
                sourceScope = new { kind = "workspace" },
                requestId = Guid.NewGuid(),
                chatSource = new { conversationId = "synthetic-owner-conversation", toolCallIds = TemplateToolIds, turnId = Guid.NewGuid() }
            }))
        {
            start.EnsureSuccessStatusCode();
            using var body = await SiteHttpHost.JsonAsync(start);
            created = body.RootElement.Clone();
        }
        var client = hosted with { Route = $"/api/v1/workspaces/{AlphaWorkspace.Value:D}/pet-plans/{created.GetProperty("id").GetGuid():D}" };
        var sharing = created.GetProperty("sharingQuestion");
        using (var allowed = await client.Host.SendAsync(HttpMethod.Post, client.Route + "/sharing/decision", client.Browser,
            new
            {
                expectedRunRevision = created.GetProperty("revision").GetInt64(),
                recipientRevision = sharing.GetProperty("recipientRevision").GetString(),
                scopeDigest = sharing.GetProperty("scopeDigest").GetString(),
                decisionNonce = sharing.GetProperty("decisionNonce").GetString(),
                approve = true,
                requestId = Guid.NewGuid()
            }))
        {
            allowed.EnsureSuccessStatusCode();
        }
        var review = await WaitForRunAsync(client.Host, client.Browser, client.Route, "waiting_for_approval");
        var reviewed = review.GetProperty("plan");
        await ApproveClientPlanAsync(client, prepared with { PlanId = reviewed.GetProperty("id").GetGuid(), Digest = reviewed.GetProperty("reviewDigest").GetString()! });
        var waiting = await WaitForRunAsync(client.Host, client.Browser, client.Route, "waiting_for_handoff");
        await ClaimClientPlanAsync(client, waiting);
        await WaitForRunAsync(client.Host, client.Browser, client.Route, "waiting_for_handoff");
        var ledger = hosted.Adapter.LastBuildLedger;
        Assert.Equal(expectedEntries, ledger.GetArrayLength());
        if (expectedEntries != 0)
        {
            Assert.Equal("built-note", ledger[0].GetProperty("nodeId").GetString());
            Assert.Equal(prepared.NoteId, ledger[0].GetProperty("itemId").GetGuid());
            Assert.Equal("done", ledger[0].GetProperty("status").GetString());
        }
        Assert.Equal(1, hosted.Adapter.ExecutionCalls);
        Assert.Equal(0, hosted.Adapter.ModelCalls);
    }

    private const string PreparedMemoryFact = "Uses metric units for measurements.";
    private const string ClientReviewDigest = "prepared-client-memory-review";
    private static readonly string[] MemoryFieldPath = ["markdown"];
    private static readonly string[] TitleFieldPath = ["title"];
    private static readonly string[] TemplateToolIds = ["planned-template"];

    private async Task<PreparedClientPlan> CreatePreparedMemoryAsync(bool protectedRead = false, string operation = "remember")
    {
        var (note, petId) = await CreateNoteWithPetAsync();
        var planId = Guid.NewGuid();
        var stepId = Guid.NewGuid();
        var requestId = Guid.NewGuid();
        var arguments = operation == "remember" ? MemoryArguments(PreparedMemoryFact) : TemplateArguments(note.Value);
        var fieldId = operation == "remember" ? "markdown" : "title";
        using var state = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            petId,
            provider = "chatgpt",
            proposals = Array.Empty<object>(),
            results = Array.Empty<object>(),
            answers = Array.Empty<string>(),
            turns = 1,
            planRequest = new { requestId, protectedRead, sourceScope = new { kind = "workspace" } },
            plan = new
            {
                id = planId,
                version = 1,
                summary = "Remember one reviewed fact.",
                reviewDigest = ClientReviewDigest,
                scopeDigest = "prepared-client-scope",
                recipientRevision = "prepared-client-recipient",
                status = "awaiting_review",
                steps = new[] { new { id = stepId, capability = "workspace." + operation, arguments,
                    effect = new { description = "Remember the reviewed fact.", parameters = PreparedMemorySnapshot(arguments) },
                    executor = "client", status = "pending", fields = new[] { new { id = fieldId, label = "Reviewed value", kind = "text",
                        value = operation == "remember" ? PreparedMemoryFact : "Reviewed template", required = true,
                        argumentPath = operation == "remember" ? MemoryFieldPath : TitleFieldPath } } } }
            },
        }));
        var run = NewRun(note, state.RootElement.Clone()) with
        {
            ItemId = null,
            SourceItemIds = [],
            WorkspaceScope = true,
            Abilities = ["workspace." + operation],
            RequestId = requestId
        };
        await SaveWaitingAsync(run, "waiting_for_approval");
        return new(run, planId, stepId, ClientReviewDigest, note.Value);
    }

    private static object MemoryArguments(string fact) => new
    {
        operation = "remember",
        itemId = "",
        parentId = "",
        title = "",
        markdown = fact,
        query = "",
        propertiesJson = "",
        specJson = ""
    };
    private static object TemplateArguments(Guid note) => new
    {
        operation = "save_as_template",
        itemId = note.ToString("D"),
        parentId = "",
        title = "Reviewed template",
        markdown = "",
        query = "",
        propertiesJson = "",
        specJson = "{}"
    };

    private static object PreparedMemorySnapshot(object arguments)
    {
        var flat = JsonSerializer.Serialize(arguments);
        using var parsed = JsonDocument.Parse(flat);
        var operation = parsed.RootElement.GetProperty("operation").GetString()!;
        var fieldId = operation == "remember" ? "markdown" : "title";
        var fact = parsed.RootElement.GetProperty(fieldId).GetString()!;
        return new
        {
            operation,
            arguments = flat,
            argumentFingerprint = flat,
            freshnessFingerprint = "prepared-client-context",
            preview = new
            {
                headline = "Remember the reviewed fact",
                destination = new { title = "Workspace", path = Array.Empty<object>() },
                counts = new { items = 0, fields = 0, views = 0, entries = 0, writes = 1 },
                tree = Array.Empty<object>(),
                notes = Array.Empty<string>(),
                warnings = Array.Empty<string>(),
                problems = Array.Empty<string>(),
                neverDoes = Array.Empty<string>()
            },
            execution = "client",
            lockedRead = false,
            fields = new[] { new { id = fieldId, label = "Reviewed value", kind = "text", value = fact, required = true } },
            targetIds = Guid.TryParse(parsed.RootElement.GetProperty("itemId").GetString(), out var itemId) ? new[] { itemId } : Array.Empty<Guid>(),
            revisions = ""
        };
    }

    private async Task<ClientPlanHarness> OpenClientPlanAsync(PreparedClientPlan prepared)
    {
#pragma warning disable CA2000 // Justification: ClientPlanHarness owns the host and fake adapter, including cleanup on failed setup.
        var adapter = new ClientWorkspaceAdapter();
        var host = SiteHttpHost.Create(fixture, new Dictionary<string, string?>
        {
            ["Nix:Bff:PublicOrigin"] = PetOrigin,
            ["Nix:PetRuns:Enabled"] = "true",
            ["Nix:PetRuns:AllowedWorkspaces:0"] = AlphaWorkspace.Value.ToString("D"),
            ["Nix:Workers:Families:0"] = "pet-plan",
            ["Nix:Pets:WorkerUrl"] = "https://prepared-client.invalid/",
        }, services =>
        {
            services.AddHttpClient<PetWorkerClient>().ConfigurePrimaryHttpMessageHandler(() => adapter);
            services.AddHttpClient("PetRecipientMetadataClient").ConfigurePrimaryHttpMessageHandler(() => new PreparedRecipientMetadata());
        });
#pragma warning restore CA2000
        adapter.Host = host;
        try
        {
            return new(host, await SignInAsync(host), $"/api/v1/workspaces/{AlphaWorkspace.Value:D}/pet-plans/{prepared.Run.Id:D}", adapter);
        }
        catch
        {
            await host.DisposeAsync();
            adapter.Dispose();
            throw;
        }
    }

    private static async Task ApproveClientPlanAsync(ClientPlanHarness client, PreparedClientPlan prepared)
    {
        var current = await ReadClientPlanAsync(client);
        using var approved = await client.Host.SendAsync(HttpMethod.Post, client.Route + $"/plans/{prepared.PlanId:D}/decision", client.Browser,
            new
            {
                expectedRunRevision = current.GetProperty("revision").GetInt64(),
                planVersion = 1,
                reviewDigest = prepared.Digest,
                approve = true,
                requestId = Guid.NewGuid()
            });
        approved.EnsureSuccessStatusCode();
    }

    private static async Task<JsonElement> BeginClientIntentAsync(ClientPlanHarness client, PreparedClientPlan prepared)
    {
        await ApproveClientPlanAsync(client, prepared);
        var waiting = await WaitForRunAsync(client.Host, client.Browser, client.Route, "waiting_for_handoff");
        await ClaimClientPlanAsync(client, waiting);
        return await WaitForRunAsync(client.Host, client.Browser, client.Route, "waiting_for_handoff");
    }

    private static async Task<JsonElement> ClaimClientPlanAsync(ClientPlanHarness client, JsonElement waiting)
    {
        var plan = waiting.GetProperty("plan");
        using var response = await client.Host.SendAsync(HttpMethod.Post,
            client.Route + $"/plans/{plan.GetProperty("id").GetGuid():D}/steps/{plan.GetProperty("steps")[0].GetProperty("id").GetGuid():D}/claim", client.Browser,
            new
            {
                expectedRunRevision = waiting.GetProperty("revision").GetInt64(),
                planVersion = plan.GetProperty("version").GetInt32(),
                reviewDigest = plan.GetProperty("reviewDigest").GetString(),
                requestId = client.ClaimRequestId,
                runnerContextId = client.RunnerContextId
            });
        response.EnsureSuccessStatusCode();
        using var result = await SiteHttpHost.JsonAsync(response);
        return result.RootElement.Clone();
    }

    private static async Task<JsonElement> ReadClientPlanAsync(ClientPlanHarness client)
    {
        using var response = await client.Host.SendAsync(HttpMethod.Get, client.Route, client.Browser);
        response.EnsureSuccessStatusCode();
        using var body = await SiteHttpHost.JsonAsync(response);
        return body.RootElement.Clone();
    }

    private static async Task<JsonElement> ClientIntentAsync(ClientPlanHarness client)
    {
        using var response = await client.Host.SendAsync(HttpMethod.Get, client.Route + "/io", client.Browser);
        response.EnsureSuccessStatusCode();
        using var body = await SiteHttpHost.JsonAsync(response);
        return body.RootElement.Clone();
    }

    private static Task<HttpResponseMessage> ReportClientIoAsync(ClientPlanHarness client, JsonElement intent, int status, string body) =>
        client.Host.SendAsync(HttpMethod.Post, client.Route + "/io/result", client.Browser,
            new { requestId = intent.GetProperty("requestId").GetGuid(), status, headers = new Dictionary<string, string>(), body });

    private static Task<HttpResponseMessage> ConsumeCollaborationIntentAsync(ClientPlanHarness client, JsonElement intent, string? permit) =>
        SendPlanCallbackAsync(client, "/internal/pet-plans/requests/consume", new
        {
            token = client.Browser,
            requestId = intent.GetProperty("requestId").GetGuid(),
            method = intent.GetProperty("method").GetString(),
            target = intent.GetProperty("target").GetString(),
            body = (string?)null,
            headers = intent.GetProperty("headers").EnumerateObject().ToDictionary(header => header.Name, header => header.Value.GetString()!),
            dispatchPermit = permit,
        });

    private static async Task<HttpResponseMessage> SendPlanCallbackAsync(ClientPlanHarness client, string route, object body)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, route) { Content = JsonContent.Create(body) };
        request.Headers.Add("X-Nix-Internal-Secret", SiteHttpHost.InternalSecret);
        return await client.Host.Client.SendAsync(request, Cancellation);
    }

    private static async Task<(HttpStatusCode Status, string Body)> DispatchClientIntentAsync(ClientPlanHarness client, JsonElement intent)
    {
        using var request = new HttpRequestMessage(new HttpMethod(intent.GetProperty("method").GetString()!), intent.GetProperty("target").GetString());
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", client.Browser);
        request.Headers.Add("X-Nix-Pet-Plan-Request", intent.GetProperty("dispatchPermit").GetString());
        if (intent.GetProperty("body").ValueKind == JsonValueKind.String)
        {
            request.Content = new StringContent(intent.GetProperty("body").GetString()!, Encoding.UTF8, "application/json");
        }
        foreach (var header in intent.GetProperty("headers").EnumerateObject())
        {
            if (!request.Headers.TryAddWithoutValidation(header.Name, header.Value.GetString()))
            {
                request.Content?.Headers.Remove(header.Name);
                request.Content?.Headers.TryAddWithoutValidation(header.Name, header.Value.GetString());
            }
        }
        using var response = await client.Host.Client.SendAsync(request, Cancellation);
        return (response.StatusCode, await response.Content.ReadAsStringAsync(Cancellation));
    }

    private async Task SetMemoryModeAsync(string mode)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var dispatcher = work.Resolve<NixDispatcher>();
        var current = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), Cancellation);
        var saved = await dispatcher.SendAsync<SavePetSettings, PetSettingsResponse>(new(current.Revision,
            current.Settings with { MemoryMode = mode }), Cancellation);
        Assert.True(saved.IsSuccess);
        await work.CommitAsync(Cancellation);
    }

    private async Task<int> MemoryCountAsync() => (await MemoryTextsAsync()).Length;

    private async Task<string[]> MemoryTextsAsync()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var current = await work.Resolve<NixDispatcher>().QueryAsync<GetPetSettings, PetSettingsResponse>(new(), Cancellation);
        return current.Settings.Memories?.Select(memory => memory.Text).ToArray() ?? [];
    }

    private sealed record PreparedClientPlan(PetRunRecord Run, Guid PlanId, Guid StepId, string Digest, Guid NoteId);
    private sealed record ClientPlanHarness(SiteHttpHost Host, string Browser, string Route, ClientWorkspaceAdapter Adapter) : IAsyncDisposable
    {
        internal Guid ClaimRequestId { get; } = Guid.NewGuid();
        internal Guid RunnerContextId { get; } = Guid.NewGuid();
        public async ValueTask DisposeAsync()
        {
            await Host.DisposeAsync();
            Adapter.Dispose();
        }
    }

    private sealed class ClientWorkspaceAdapter : HttpMessageHandler
    {
        internal SiteHttpHost Host { get; set; } = null!;
        internal int ExecutionCalls { get; private set; }
        internal int ModelCalls { get; private set; }
        internal bool CollaborationIntent { get; set; }
        internal JsonElement? ChatArguments { get; set; }
        internal object[] BuildReceipts { get; set; } = [];
        internal JsonElement LastBuildLedger => _execution.GetProperty("buildLedger");
        private JsonElement _execution;
        private JsonElement? _adoptedBinding;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            using var document = await request.Content!.ReadFromJsonAsync<JsonDocument>(cancellationToken);
            var root = document!.RootElement;
            if (request.RequestUri!.AbsolutePath == "/v1/companion" && ChatArguments is { } chat)
            {
                switch (root.GetProperty("operation").GetString())
                {
                    case "plan_tools_inspect":
                        return AdapterJson(new
                        {
                            turnId = root.GetProperty("requestId").GetString(),
                            readOnly = false,
                            lockedRead = false,
                            sourceScope = new { kind = "workspace" },
                            contextSourceItemIds = Array.Empty<Guid>(),
                            contextUnbounded = false,
                            contextProtected = false,
                            tools = new[] { new { id = "planned-template", status = _adoptedBinding is null ? "planned" : "adopted",
                                arguments = chat.GetRawText(), planBinding = _adoptedBinding } },
                            buildReceipts = BuildReceipts
                        });
                    case "plan_tools_adopt":
                        using (var payload = JsonDocument.Parse(root.GetProperty("planPayload").GetString()!))
                        {
                            _adoptedBinding = payload.RootElement.GetProperty("bindings")[0].Clone();
                        }
                        return AdapterJson(new { adopted = true });
                    case "plan_tools_resolve":
                        return AdapterJson(new { resolved = true });
                }
            }
            if (request.RequestUri!.AbsolutePath != "/v1/sani/pet-workspace-plan")
            {
                ModelCalls++;
                throw new InvalidOperationException("A prepared client plan must not call a model.");
            }
            switch (root.GetProperty("kind").GetString())
            {
                case "catalog":
                    return AdapterJson(new
                    {
                        ok = true,
                        capabilities = ClientCapabilityNames.Select(name =>
                        new { name = "workspace." + name, description = "Fixture workspace tool", inputSchema = new { type = "object" } })
                    });
                case "prepare_flat":
                    return AdapterJson(new { ok = true, prepared = PreparedMemorySnapshot(JsonNode.Parse(root.GetProperty("arguments").GetString()!)!) });
                case "execute":
                    ExecutionCalls++;
                    if (ExecutionCalls != 1)
                    {
                        Assert.Equal(_execution.GetProperty("binding").GetProperty("executionId").GetGuid(),
                            root.GetProperty("binding").GetProperty("executionId").GetGuid());
                        return AdapterJson(new { ok = true, state = "waiting" });
                    }
                    _execution = root.Clone();
                    if (root.GetProperty("prepared").GetProperty("operation").ValueEquals("save_as_template"))
                    {
                        if (CollaborationIntent)
                        {
                            using var issued = await IssueAsync(1, "GET", null);
                            issued.EnsureSuccessStatusCode();
                        }
                        return AdapterJson(new { ok = true, state = "waiting" });
                    }
                    using (var issued = await IssueAsync(1, "GET", null))
                    {
                        return AdapterJson(new { ok = issued.IsSuccessStatusCode, state = issued.IsSuccessStatusCode ? "waiting" : "refused" });
                    }
                case "poll":
                    return AdapterJson(new { ok = true, state = "waiting" });
                default:
                    throw new InvalidOperationException("Unexpected trusted client adapter operation.");
            }
        }

        internal async Task<Guid> IssueMemoryWriteAsync(Guid readId)
        {
            var read = await PollAsync(readId);
            Assert.True(read.GetProperty("ready").GetBoolean());
            Assert.Equal(200, read.GetProperty("status").GetInt32());
            var current = JsonNode.Parse(read.GetProperty("body").GetString()!)!;
            var settings = current["settings"]!.DeepClone();
            var memories = settings["memories"] as JsonArray;
            if (memories is null)
            {
                memories = [];
                settings["memories"] = memories;
            }
            memories.Add(JsonSerializer.SerializeToNode(new
            {
                id = Guid.NewGuid(),
                text = PreparedMemoryFact,
                createdAt = "2026-11-25T12:00:00Z"
            }));
            var body = new JsonObject { ["expectedRevision"] = current["revision"]!.DeepClone(), ["settings"] = settings }.ToJsonString();
            using var issued = await IssueAsync(2, "PUT", body);
            issued.EnsureSuccessStatusCode();
            using var result = await SiteHttpHost.JsonAsync(issued);
            return result.RootElement.GetProperty("requestId").GetGuid();
        }

        internal async Task CompleteMemoryAsync(Guid writeId)
        {
            var written = await PollAsync(writeId);
            Assert.True(written.GetProperty("ready").GetBoolean());
            Assert.Equal(200, written.GetProperty("status").GetInt32());
            using var response = await CallbackAsync("/internal/pet-plans/executions/complete", new
            {
                tenantId = TestTenants.Alpha,
                principalId = AlphaActor.Value,
                workspaceId = AlphaWorkspace.Value,
                binding = _execution.GetProperty("binding"),
                success = true,
                receipt = JsonSerializer.Serialize(new { remembered = PreparedMemoryFact }),
                lockedContent = false,
                unknown = false,
                status = "applied",
            });
            response.EnsureSuccessStatusCode();
        }

        private async Task<JsonElement> PollAsync(Guid requestId)
        {
            using var response = await CallbackAsync($"/internal/pet-plans/requests/{requestId:D}/result", new
            {
                tenantId = TestTenants.Alpha,
                principalId = AlphaActor.Value,
                workspaceId = AlphaWorkspace.Value,
                binding = _execution.GetProperty("binding"),
            });
            response.EnsureSuccessStatusCode();
            using var result = await SiteHttpHost.JsonAsync(response);
            return result.RootElement.Clone();
        }

        private Task<HttpResponseMessage> IssueAsync(int childId, string method, string? body) =>
            CallbackAsync("/internal/pet-plans/requests/issue", new
            {
                tenantId = TestTenants.Alpha,
                principalId = AlphaActor.Value,
                workspaceId = AlphaWorkspace.Value,
                binding = _execution.GetProperty("binding"),
                childId,
                destination = CollaborationIntent ? "collab" : "core",
                method,
                target = CollaborationIntent ? CollaborationTarget() : "/api/v1/me/pets/settings",
                body,
                headers = body is null ? new Dictionary<string, string>() : new Dictionary<string, string> { ["Content-Type"] = "application/json" },
                executor = "client",
            });

        private string CollaborationTarget()
        {
            using var arguments = JsonDocument.Parse(_execution.GetProperty("prepared").GetProperty("arguments").GetString()!);
            return $"/api/v1/items/{arguments.RootElement.GetProperty("itemId").GetString()}/body";
        }

        private async Task<HttpResponseMessage> CallbackAsync(string route, object body)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, route) { Content = JsonContent.Create(body) };
            request.Headers.Add("X-Nix-Internal-Secret", SiteHttpHost.InternalSecret);
            return await Host.Client.SendAsync(request, Cancellation);
        }

        private static HttpResponseMessage AdapterJson(object value) => new(HttpStatusCode.OK) { Content = JsonContent.Create(value) };
        internal static readonly string[] ClientCapabilityNames = ["list_items", "search", "read_item", "read_note", "search_note", "remember",
            "read_structure", "read_view", "create_note", "append_note", "replace_section", "replace_passage", "rename_item", "move_item", "set_properties",
            "trash_item", "restore_item", "create_structured", "add_view", "update_view", "create_entries", "edit_fields", "add_fields", "edit_form", "set_recurrence",
            "list_templates", "read_template", "apply_template", "build_blueprint", "save_as_template", "read_calendar", "complete_task", "find_action", "run_action"];
    }
}
