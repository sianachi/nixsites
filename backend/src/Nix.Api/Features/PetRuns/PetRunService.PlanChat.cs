using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Primitives;
using Nix.Features.Pets;

namespace Nix.Features.PetRuns;

internal sealed partial class PetRunService
{
    private async Task PrepareChatPlanAsync(Work work, Step step, CancellationToken cancellationToken)
    {
        var source = step.State.PlanRequest!.ChatSource!;
        var request = ChatRequest(step.Run, step.State, "plan_tools_inspect", new JsonObject
        {
            ["toolIds"] = new JsonArray(source.ToolCallIds.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()),
        });
        var inspected = await services.GetRequiredService<PetWorkerClient>().PlanToolsRpcAsync(request, cancellationToken).ConfigureAwait(false);
        await InWorkerScopeAsync(work, async (handler, job, ct) =>
        {
            var current = await handler.CurrentAsync(job, ct).ConfigureAwait(false);
            if (current is null || current.Run.Revision != step.Run.Revision || !await handler.HoldAsync(job, ct).ConfigureAwait(false))
            {
                return new IsolatedOutcome<bool>(false, false);
            }
            var state = current.State;
            if (inspected.IsFailure || !inspected.Value.TryGetProperty("tools", out var tools) || tools.ValueKind != JsonValueKind.Array
                || tools.GetArrayLength() != source.ToolCallIds.Count
                || !inspected.Value.TryGetProperty("turnId", out var turn) || !turn.TryGetGuid(out var turnId) || turnId != source.TurnId)
            {
                var saved = await handler.StopAsync(current.Run, state with
                {
                    Failure = new("adoption", "pet_plans.source_unavailable",
                    "The original tool batch changed. Prepare a fresh plan in this conversation.")
                }, "review_required", ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(saved, saved);
            }
            var root = inspected.Value.TryGetProperty("rootItemId", out var rootValue) && rootValue.ValueKind == JsonValueKind.String
                && Guid.TryParse(rootValue.GetString(), out var actualRoot) ? actualRoot : (Guid?)null;
            if (current.Run.ItemId?.Value != root)
            {
                var refused = await handler.StopAsync(current.Run, state with
                {
                    Failure = new("adoption", "pet_plans.source_unavailable",
                    "The source conversation belongs to a different item scope.")
                }, "review_required", ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(refused, refused);
            }
            PetPlanSourceScope? originalScope;
            try
            {
                originalScope = inspected.Value.TryGetProperty("sourceScope", out var rawScope)
                    ? rawScope.Deserialize(PetPlanJsonContext.Default.PetPlanSourceScope) : null;
            }
            catch (JsonException)
            {
                originalScope = null;
            }
            if (!PetPlanExecution.ValidScope(originalScope, root) || root is not null && (originalScope!.Kind != "subtree"
                    || originalScope.ItemIds is not { Count: 1 } || originalScope.ItemIds[0] != root))
            {
                var refused = await handler.StopAsync(current.Run, state with
                {
                    Failure = new("adoption", "pet_plans.source_unavailable",
                    "The original conversation's source scope could not be verified. Start a new conversation.")
                }, "review_required", ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(refused, refused);
            }
            state = state with
            {
                PlanRequest = state.PlanRequest! with
                {
                    ChatSource = source with { RootItemId = root },
                    SourceReadOnly = state.PlanRequest.SourceReadOnly
                    || inspected.Value.TryGetProperty("readOnly", out var readOnly) && readOnly.ValueKind == JsonValueKind.True
                }
            };
            // The adopted plan keeps the conversation's own source scope; a workspace task request cannot widen it.
            state = state with { PlanRequest = state.PlanRequest with { SourceScope = originalScope! } };
            var candidates = tools.EnumerateArray().ToDictionary(tool => tool.GetProperty("id").GetString()!, StringComparer.Ordinal);
            var proposed = new List<PetTaskPlanStep>();
            foreach (var id in source.ToolCallIds)
            {
                if (!candidates.TryGetValue(id, out var tool) || tool.GetProperty("status").GetString() is not ("planned" or "adopted")
                    || !tool.TryGetProperty("arguments", out var rawArguments) || rawArguments.GetString() is not { } json)
                {
                    var refused = await handler.StopAsync(current.Run, state, "review_required", ct).ConfigureAwait(false);
                    return new IsolatedOutcome<bool>(refused, refused);
                }
                using var arguments = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 24, AllowDuplicateProperties = false });
                var operation = arguments.RootElement.GetProperty("operation").GetString();
                proposed.Add(new("workspace." + operation, arguments.RootElement.Clone()));
            }
            var protectedRead = state.PlanRequest!.ProtectedRead
                || inspected.Value.TryGetProperty("lockedRead", out var locked) && locked.ValueKind == JsonValueKind.True
                || inspected.Value.TryGetProperty("contextProtected", out var contextProtected) && contextProtected.ValueKind == JsonValueKind.True;
            var disclosureSources = new List<Guid>();
            if (!inspected.Value.TryGetProperty("contextSourceItemIds", out var actualSources) || actualSources.ValueKind != JsonValueKind.Array
                || actualSources.GetArrayLength() > 128)
            {
                var refused = await handler.StopAsync(current.Run, state with
                {
                    Failure = new("adoption", "pet_plans.source_unavailable",
                    "The original conversation's source history could not be verified. Start a new conversation.")
                }, "review_required", ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(refused, refused);
            }
            foreach (var rawSource in actualSources.EnumerateArray())
            {
                if (rawSource.ValueKind != JsonValueKind.String || !rawSource.TryGetGuid(out var id) || id == Guid.Empty || disclosureSources.Contains(id))
                {
                    var refused = await handler.StopAsync(current.Run, state with
                    {
                        Failure = new("adoption", "pet_plans.source_unavailable",
                        "The original conversation's source history could not be verified. Start a new conversation.")
                    }, "review_required", ct).ConfigureAwait(false);
                    return new IsolatedOutcome<bool>(refused, refused);
                }
                disclosureSources.Add(id);
            }
            var unboundedDisclosure = !inspected.Value.TryGetProperty("contextUnbounded", out var contextUnbounded)
                || contextUnbounded.ValueKind != JsonValueKind.False;
            var ledger = await handler.VerifiedBuildLedgerAsync(current.Run, inspected.Value, ct).ConfigureAwait(false);
            var timeZone = inspected.Value.TryGetProperty("timeZone", out var zone) && zone.ValueKind == JsonValueKind.String
                && TimeZoneInfo.TryFindSystemTimeZoneById(zone.GetString()!, out _) ? zone.GetString() : state.PlanRequest.TimeZone;
            state = state with
            {
                PlanRequest = state.PlanRequest with
                {
                    ProtectedRead = protectedRead,
                    BuildLedger = ledger,
                    TimeZone = timeZone,
                    DisclosureSourceItemIds = [.. disclosureSources.Order()],
                    UnboundedDisclosure = unboundedDisclosure
                }
            };
            var prepared = await handler.PreparePlanAsync(current.Run, state, "Review the prepared changes from this conversation", proposed, ct).ConfigureAwait(false);
            if (prepared.IsFailure)
            {
                var stopped = await handler.StopAsync(current.Run, state with { Failure = new("preview", prepared.Error.Code, prepared.Error.Message) },
                    "review_required", ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(stopped, stopped);
            }
            var readPhase = prepared.Value.Steps.Any(effect => !handler._capabilities[effect.Capability].RequiresApproval(effect.Effect));
            var offered = prepared.Value;
            if (readPhase)
            {
                offered = offered with
                {
                    Summary = "Read the shared sources before preparing changes.",
                    Steps = [.. offered.Steps.Select(effect =>
                    handler._capabilities[effect.Capability].RequiresApproval(effect.Effect) ? effect with
                    { Status = "cancelled", IncludedInReview = false, Receipt = "Not dispatched. Discovery must finish before a fresh write plan can be prepared." } : effect)]
                };
                offered = offered with { ReviewDigest = PetPlanExecution.Digest(current.Run, offered) };
            }
            state = state with
            {
                PlanRequest = state.PlanRequest! with
                {
                    ReadPhase = readPhase,
                    ReadWithoutAsking = inspected.Value.TryGetProperty("readWithoutAsking", out var readPreference) && readPreference.ValueKind == JsonValueKind.True
                }
            };
            var savedPlan = await handler.StopAsync(current.Run, state with { Plan = offered with { Status = "adopting" } }, "running", ct).ConfigureAwait(false);
            return new IsolatedOutcome<bool>(savedPlan, savedPlan);
        }, cancellationToken).ConfigureAwait(false);
        await AdoptStoredPlanAsync(work, step.Run.Id, cancellationToken).ConfigureAwait(false);
    }

    private Task<bool> AdoptStoredPlanAsync(Work work, Guid runId, CancellationToken cancellationToken) =>
        InWorkerScopeAsync(work, async (handler, job, ct) =>
        {
            var run = await handler.RunStore.GetAsync(runId, ct).ConfigureAwait(false);
            if (run is null || Checkpoint(run).Plan is not { Status: "adopting" } plan
                || !await handler.HoldAsync(job, ct).ConfigureAwait(false))
            {
                return new IsolatedOutcome<bool>(false, false);
            }
            var state = Checkpoint(run);
            var source = state.PlanRequest!.ChatSource!;
            var previous = state.PlanRequest.SourceBindings;
            var next = source.ToolCallIds.Select((tool, index) => new PetPlanToolBinding(tool, run.Id, plan.Id,
                plan.Version, plan.ReviewDigest, plan.Steps[plan.Steps.Count == source.ToolCallIds.Count ? index : 0].Id)).ToArray();
            var operation = previous is null ? "plan_tools_adopt" : "plan_tools_supersede";
            var bindings = previous is null ? new JsonArray(next.Select(binding => (JsonNode?)ToolBinding(binding)).ToArray())
                : new JsonArray(next.Select((binding, index) => (JsonNode?)new JsonObject
                {
                    ["previous"] = ToolBinding(previous[index]),
                    ["next"] = ToolBinding(binding),
                }).ToArray());
            var held = handler.Next(run, state, "running");
            if (!await handler.RunStore.UpdateAsync(held, run.Revision, ct).ConfigureAwait(false))
            {
                return new IsolatedOutcome<bool>(false, false);
            }
            var adopted = await handler.Services.GetRequiredService<PetWorkerClient>().PlanToolsRpcAsync(
                ChatRequest(run, state, operation, new JsonObject { ["bindings"] = bindings }), ct).ConfigureAwait(false);
            if (adopted.IsSuccess && (adopted.Value.TryGetProperty("adopted", out var accepted)
                    || adopted.Value.TryGetProperty("superseded", out accepted)) && accepted.ValueKind == JsonValueKind.True)
            {
                state = state with
                {
                    Plan = plan with { Status = "awaiting_review" },
                    PlanRequest = state.PlanRequest with
                    { SourceBindings = next, SourceSuperseded = state.PlanRequest.SourceSuperseded || previous is not null }
                };
                if (state.PlanRequest.ReadPhase && state.PlanRequest.ReadWithoutAsking
                    && plan.Steps.Where(effect => effect.IncludedInReview).All(effect => !handler._capabilities[effect.Capability].RequiresApproval(effect.Effect)))
                {
                    var reading = await handler.QueuePlanAsync(held, state with { Plan = plan with { Status = "discovery" } }, ct).ConfigureAwait(false);
                    return new IsolatedOutcome<bool>(reading.IsSuccess, reading.IsSuccess);
                }
                var ready = await handler.StopAsync(held, state, "waiting_for_approval", ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(ready, ready);
            }
            var saved = await handler.StopAsync(held, state with
            {
                Plan = plan with { Status = "review_required" },
                Failure = new("adoption", "pet_plans.source_unavailable", "The original conversation could not be linked. Prepare a fresh plan.")
            }, "review_required", ct).ConfigureAwait(false);
            return new IsolatedOutcome<bool>(saved, saved);
        }, cancellationToken);

    private async Task<bool> FinishOrResolveSourcesAsync(PetRunRecord run, PetRunCheckpoint state, string status, CancellationToken cancellationToken)
    {
        if (state.PlanRequest is { SourceBindings: not null, SourceResolved: false } request)
        {
            var queued = await QueuePlanAsync(run, state with { PlanRequest = request with { PendingFinalStatus = status } }, cancellationToken).ConfigureAwait(false);
            return queued.IsSuccess;
        }
        return await StopAsync(run, state, status, cancellationToken).ConfigureAwait(false);
    }

    private Task<bool> ResolveSourceReceiptsAsync(Work work, Step step, CancellationToken cancellationToken) =>
        InWorkerScopeAsync(work, async (handler, job, ct) =>
        {
            var current = await handler.CurrentAsync(job, ct).ConfigureAwait(false);
            if (current is null || current.State.PlanRequest is not { PendingFinalStatus: { } finalStatus } request
                || !await handler.HoldAsync(job, ct).ConfigureAwait(false))
            {
                return new IsolatedOutcome<bool>(false, false);
            }
            if (request.SourceBindings is null)
            {
                var cancelled = await handler.Services.GetRequiredService<PetWorkerClient>().PlanToolsRpcAsync(
                    ChatRequest(current.Run, current.State, "plan_tools_cancel", new JsonObject
                    {
                        ["toolIds"] = new JsonArray(request.ChatSource!.ToolCallIds.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()),
                        ["runId"] = current.Run.Id,
                    }), ct).ConfigureAwait(false);
                var accepted = cancelled.IsSuccess && cancelled.Value.TryGetProperty("cancelled", out var value) && value.ValueKind == JsonValueKind.True;
                var saved = await handler.StopAsync(current.Run, current.State with
                {
                    PlanRequest = request with { SourceResolved = accepted, PendingFinalStatus = null },
                    Failure = accepted ? null : new("receipt", "pet_plans.source_unavailable",
                        "The plan is stopped in Nix. Stop the original conversation before starting another request."),
                }, accepted ? finalStatus : "review_required", ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(saved, saved);
            }
            if (current.State.Plan is not { } plan)
            {
                return new IsolatedOutcome<bool>(false, false);
            }
            var bindings = request.SourceBindings;
            var superseded = request.SourceSuperseded;
            var disclosure = new Dictionary<Guid, (bool Available, Guid[] Sources)>();
            foreach (var effect in plan.Steps)
            {
                var sources = (effect.SourceItemIds ?? [.. WriteTargets(effect.Effect.Parameters)]).Distinct().ToArray();
                var observation = new PetRunProposal(effect.Id, effect.Capability, effect.Effect.Description, effect.Effect.Parameters,
                    effect.Status, Receipt: effect.Receipt, SourceItemIds: sources, ObservationBlocked: effect.ObservationBlocked);
                var available = !effect.ObservationBlocked && (effect.UnboundedSourceProvenance
                    ? await handler.BroadReadAvailableAsync(current.Run, current.State, ct).ConfigureAwait(false)
                    : await handler.ObservationAvailableAsync(current.Run, observation, ct).ConfigureAwait(false));
                disclosure[effect.Id] = (available, available ? sources : []);
            }
            var aggregate = superseded ? AggregateSourceReceipt(plan,
                disclosure.Where(value => !value.Value.Available).Select(value => value.Key).ToHashSet()) : null;
            foreach (var binding in bindings)
            {
                var effect = plan.Steps.FirstOrDefault(candidate => candidate.Id == binding.StepId);
                var available = effect is not null && disclosure[effect.Id].Available;
                var receipt = aggregate ?? (available ? effect?.Receipt : "The result is retained in Nix because its sources are no longer available for this conversation.")
                    ?? $"The effect was {effect?.Status ?? "cancelled"} before a confirmed result was available.";
                var success = !superseded && available && effect?.Status is "applied" or "undone";
                var sources = superseded ? disclosure.Values.SelectMany(value => value.Sources).Distinct().ToArray()
                    : available ? disclosure[effect!.Id].Sources : [];
                var unbounded = superseded ? plan.Steps.Any(value => disclosure[value.Id].Available && value.UnboundedSourceProvenance)
                    : available && effect!.UnboundedSourceProvenance;
                var result = await handler.Services.GetRequiredService<PetWorkerClient>().PlanToolsRpcAsync(ChatRequest(current.Run, current.State,
                    "plan_tools_resolve", SourceReceiptPayload(binding, success, receipt, request.ProtectedRead, sources, unbounded)), ct).ConfigureAwait(false);
                if (result.IsFailure || !result.Value.TryGetProperty("resolved", out var resolved) || resolved.ValueKind != JsonValueKind.True)
                {
                    var saved = await handler.StopAsync(current.Run, current.State with
                    {
                        Failure = new("receipt", "pet_plans.source_unavailable",
                        "The result is saved in Nix. The original conversation could not receive it.")
                    }, "review_required", ct).ConfigureAwait(false);
                    return new IsolatedOutcome<bool>(saved, saved);
                }
            }
            var state = current.State with { PlanRequest = request with { SourceResolved = true, PendingFinalStatus = null } };
            var completed = await handler.StopAsync(current.Run, state, finalStatus, ct).ConfigureAwait(false);
            return new IsolatedOutcome<bool>(completed, completed);
        }, cancellationToken);

    private static string AggregateSourceReceipt(PetPlanPrepared plan, HashSet<Guid> unavailable)
    {
        var header = $"Original proposal superseded by reviewed plan version {plan.Version}. Observed outcomes:";
        var lineBudget = (12_000 - JsonEncodedText.Encode(header).EncodedUtf8Bytes.Length - 2 * plan.Steps.Count)
            / Math.Max(1, plan.Steps.Count);
        var lines = plan.Steps.Select((effect, index) => BoundSourceText(unavailable.Contains(effect.Id)
            ? $"{index + 1}. {effect.Status}: The result is retained in Nix because its sources are no longer available for this conversation."
            : $"{index + 1}. {effect.Status}: {BoundSourceText(effect.Effect.Description, Math.Min(300, lineBudget / 3))}. {effect.Receipt}", lineBudget));
        return header + "\n" + string.Join("\n", lines);
    }

    private static JsonObject SourceReceiptPayload(PetPlanToolBinding binding, bool success, string receipt,
        bool lockedContent, IEnumerable<Guid> sourceIds, bool unbounded)
    {
        var sources = sourceIds.Distinct().Take(129).ToArray();
        return new JsonObject
        {
            ["binding"] = ToolBinding(binding),
            ["success"] = success,
            ["result"] = BoundSourceText(receipt, 12_000),
            ["lockedContent"] = lockedContent,
            ["sourceItemIds"] = new JsonArray(sources.Take(128).Select(id => (JsonNode?)JsonValue.Create(id.ToString("D"))).ToArray()),
            ["unboundedSourceProvenance"] = unbounded || sources.Length > 128,
        };
    }

    private static string BoundSourceText(string value, int maximumEncodedBytes)
    {
        if (JsonEncodedText.Encode(value).EncodedUtf8Bytes.Length <= maximumEncodedBytes)
        {
            return value;
        }
        const string suffix = " [Full result is saved in Nix.]";
        var remaining = maximumEncodedBytes - JsonEncodedText.Encode(suffix).EncodedUtf8Bytes.Length;
        var result = new StringBuilder();
        foreach (var rune in value.EnumerateRunes())
        {
            var text = rune.ToString();
            var bytes = JsonEncodedText.Encode(text).EncodedUtf8Bytes.Length;
            if (bytes > remaining)
            {
                break;
            }
            result.Append(text);
            remaining -= bytes;
        }
        return result.Append(suffix).ToString();
    }

    private static JsonObject ToolBinding(PetPlanToolBinding binding) => new()
    {
        ["toolId"] = binding.ToolId,
        ["runId"] = binding.RunId,
        ["planId"] = binding.PlanId,
        ["planVersion"] = binding.PlanVersion,
        ["reviewDigest"] = binding.ReviewDigest,
        ["stepId"] = binding.StepId,
    };

    private async Task<IReadOnlyList<PetPlanBuildLedgerEntry>> VerifiedBuildLedgerAsync(PetRunRecord run, JsonElement inspected,
        CancellationToken cancellationToken)
    {
        var verified = new List<PetPlanBuildLedgerEntry>();
        if (!inspected.TryGetProperty("buildReceipts", out var receipts) || receipts.ValueKind != JsonValueKind.Array || receipts.GetArrayLength() > 24)
        {
            return verified;
        }
        foreach (var receipt in receipts.EnumerateArray())
        {
            if (!receipt.TryGetProperty("binding", out var rawBinding) || !receipt.TryGetProperty("result", out var rawResult)
                || rawResult.ValueKind != JsonValueKind.String || rawResult.GetString() is not { } text)
            {
                continue;
            }
            var binding = rawBinding.Deserialize(PetPlanJsonContext.Default.PetPlanToolBinding);
            var previous = binding is null ? null : await runs.GetAsync(binding.RunId, cancellationToken).ConfigureAwait(false);
            var plan = previous is null ? null : Checkpoint(previous).Plan;
            var built = plan?.Steps.SingleOrDefault(effect => effect.Id == binding!.StepId);
            if (previous is null || previous.WorkspaceId != run.WorkspaceId || previous.ActorId != run.ActorId
                || plan is null || !PetPlanExecution.Matches(plan, binding!.PlanId, binding.PlanVersion, binding.ReviewDigest)
                || built is not { Capability: "workspace.build_blueprint", Status: "applied", Receipt: { } saved } || saved != text)
            {
                continue;
            }
            try
            {
                using var document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 24, AllowDuplicateProperties = false });
                if (!document.RootElement.TryGetProperty("ledger", out var ledger) || ledger.ValueKind != JsonValueKind.Array || ledger.GetArrayLength() > 80)
                {
                    continue;
                }
                foreach (var entry in ledger.EnumerateArray())
                {
                    if (verified.Count >= 80 || !entry.TryGetProperty("nodeId", out var nodeId) || nodeId.GetString() is not { Length: > 0 and <= 200 } node
                        || !entry.TryGetProperty("itemId", out var rawItem) || !rawItem.TryGetGuid(out var itemId)
                        || !entry.TryGetProperty("status", out var status) || !status.ValueEquals("done"))
                    {
                        continue;
                    }
                    var item = await items.FindAsync(Nix.Domain.Items.ItemId.From(itemId), cancellationToken).ConfigureAwait(false);
                    if (item is not null && item.WorkspaceId == run.WorkspaceId && CanUseSource(item))
                    {
                        verified.Add(new(node, itemId, "done"));
                    }
                }
            }
            catch (JsonException)
            {
                // A truncated receipt cannot establish a template mapping.
            }
        }
        return verified;
    }

    internal static JsonObject ChatRequest(PetRunRecord run, PetRunCheckpoint state, string operation, JsonObject payload)
    {
        var source = state.PlanRequest!.ChatSource!;
        return new()
        {
            ["operation"] = operation,
            ["tenantId"] = run.TenantId.Value,
            ["principalId"] = run.ActorId.Value,
            ["workspaceId"] = run.WorkspaceId.Value,
            ["petId"] = state.PetId,
            ["provider"] = state.Provider,
            ["requestId"] = source.TurnId,
            ["mode"] = source.Mode ?? "chat",
            ["rootItemId"] = source.RootItemId?.ToString("D") ?? "",
            ["planPayload"] = payload.ToJsonString()
        };
    }
}
