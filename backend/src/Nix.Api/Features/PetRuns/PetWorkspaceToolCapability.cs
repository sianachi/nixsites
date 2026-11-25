using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Authentication;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Features.Pets;
using Nix.Messaging;

namespace Nix.Features.PetRuns;

[SuppressMessage("Performance", "CA1812", Justification = "Created by the workspace capability registrations.")]
internal sealed class PetWorkspaceToolCatalog(PetWorkerClient worker)
{
    private readonly Dictionary<string, JsonElement> _definitions = new(StringComparer.Ordinal);
    internal JsonElement? Find(string name) => _definitions.TryGetValue(name, out var definition) ? definition : null;
    internal async Task<Result<bool>> LoadAsync(CancellationToken cancellationToken)
    {
        if (_definitions.Count != 0)
        {
            return Result.Success(true);
        }

        var response = await worker.WorkspacePlanRpcAsync(new JsonObject { ["kind"] = "catalog" }, cancellationToken).ConfigureAwait(false);
        if (response.IsFailure)
        {
            return Result.Failure<bool>(response.Error);
        }

        if (!response.Value.TryGetProperty("capabilities", out var capabilities) || capabilities.ValueKind != JsonValueKind.Array)
        {
            return Result.Failure<bool>(new("pet_plans.catalog_invalid", "The workspace plan catalog is unavailable."));
        }

        var definitions = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var definition in capabilities.EnumerateArray())
        {
            if (!definition.TryGetProperty("name", out var field) || field.GetString() is not { } name
                || !PetWorkspaceToolCapability.Names.Contains(name, StringComparer.Ordinal)
                || !definition.TryGetProperty("inputSchema", out var schema) || schema.ValueKind != JsonValueKind.Object
                || !definition.TryGetProperty("description", out var description) || description.GetString() is not { Length: >= 1 and <= 2_000 }
                || !definitions.TryAdd(name, definition.Clone()))
            {
                return Result.Failure<bool>(new("pet_plans.catalog_invalid", "The workspace plan catalog is incomplete."));
            }
        }
        if (definitions.Count != PetWorkspaceToolCapability.Names.Count)
        {
            return Result.Failure<bool>(new("pet_plans.catalog_invalid", "The workspace plan catalog is incomplete."));
        }

        foreach (var pair in definitions)
        {
            _definitions.Add(pair.Key, pair.Value);
        }

        return Result.Success(true);
    }
}

internal sealed class PetWorkspaceToolCapability(string name, PetWorkspaceToolCatalog catalog,
    PetWorkerClient worker, SelfIssuedTokenService tokens, IItemTree items, NixDispatcher dispatcher) : IPetRunCapability, IPetPlanCapability, IPetPlanOutcomeCapability, IPetPlanDiscoveryCapability
{
    private PetWorkspaceToolCatalog Catalog => catalog;
    internal static IReadOnlyList<string> Names { get; } = [
        "workspace.list_items", "workspace.search", "workspace.read_item", "workspace.read_note", "workspace.search_note",
        "workspace.remember", "workspace.read_structure", "workspace.read_view", "workspace.create_note", "workspace.append_note",
        "workspace.replace_section", "workspace.replace_passage", "workspace.rename_item", "workspace.move_item", "workspace.set_properties",
        "workspace.trash_item", "workspace.restore_item", "workspace.create_structured", "workspace.add_view", "workspace.update_view",
        "workspace.create_entries", "workspace.edit_fields", "workspace.add_fields", "workspace.edit_form", "workspace.set_recurrence",
        "workspace.list_templates", "workspace.read_template", "workspace.apply_template", "workspace.build_blueprint", "workspace.save_as_template",
        "workspace.read_calendar", "workspace.complete_task", "workspace.find_action", "workspace.run_action",
    ];
    internal static void Register(IServiceCollection services)
    {
        services.AddScoped<PetWorkspaceToolCatalog>();
        foreach (var capability in Names)
        {
            services.AddScoped<IPetRunCapability>(provider => new PetWorkspaceToolCapability(capability,
                provider.GetRequiredService<PetWorkspaceToolCatalog>(), provider.GetRequiredService<PetWorkerClient>(),
                provider.GetRequiredService<SelfIssuedTokenService>(), provider.GetRequiredService<IItemTree>(), provider.GetRequiredService<NixDispatcher>()));
        }
    }
    internal static async Task<Result<bool>> PrepareCatalogAsync(IEnumerable<IPetRunCapability> capabilities, CancellationToken cancellationToken)
    {
        foreach (var capability in capabilities.OfType<PetWorkspaceToolCapability>())
        {
            return await capability.Catalog.LoadAsync(cancellationToken).ConfigureAwait(false);
        }

        return Result.Success(true);
    }
    internal static bool ReadOnlyOperation(string capability) => capability is
        "workspace.list_items" or "workspace.search" or "workspace.read_item" or "workspace.read_note" or "workspace.search_note"
        or "workspace.read_structure" or "workspace.read_view" or "workspace.list_templates" or "workspace.read_template"
        or "workspace.read_calendar" or "workspace.find_action";
    public bool RequiresApproval(PetRunEffect effect) => !ReadOnlyOperation(Name);
    public bool PlanRequestDispatch => true;
    public string Name => name;
    public string Description => catalog.Find(name)?.GetProperty("description").GetString() ?? "Prepare a reviewed workspace operation.";
    public JsonElement? InputSchema => catalog.Find(name)?.GetProperty("inputSchema");
    public string Executor(PetRunEffect effect) => effect.Parameters.GetProperty("execution").GetString() ?? "client";
    public JsonElement Arguments(PetRunEffect effect, JsonElement supplied)
    {
        using var parsed = JsonDocument.Parse(effect.Parameters.GetProperty("arguments").GetString() ?? "{}");
        return parsed.RootElement.Clone();
    }
    public string FrozenArgumentsHash(PetRunEffect effect, JsonElement args) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(effect.Parameters.GetProperty("arguments").GetString() ?? "")));
    public IReadOnlyList<PetPlanEditableField> Fields(PetRunEffect effect) =>
        [.. effect.Parameters.GetProperty("fields").EnumerateArray().Select(field => new PetPlanEditableField(
            field.GetProperty("id").GetString()!, field.GetProperty("label").GetString()!, "text", field.GetProperty("value").Clone(),
            Required: field.GetProperty("required").GetBoolean(), ArgumentPath: [field.GetProperty("id").GetString()!]))];

    public string ExpectedRevisions(PetRunEffect effect) => effect.Parameters.GetProperty("revisions").GetString() ?? "";

    public PetRunEffect PublicEffect(PetRunEffect effect)
    {
        var args = Arguments(effect, default);
        var values = new JsonObject();
        foreach (var property in args.EnumerateObject())
        {
            if (property.Name == "operation")
            {
                continue;
            }

            var text = property.Value.GetString() ?? "";
            if (property.Name is "specJson" or "propertiesJson")
            {
                if (text.Length != 0)
                {
                    values[property.Name == "specJson" ? "specification" : "properties"] = JsonNode.Parse(text);
                }
            }
            else if (text.Length != 0)
            {
                values[property.Name] = text;
            }
        }
        return new PetRunEffect(effect.Description, JsonSerializer.SerializeToElement(new JsonObject
        {
            ["kind"] = "workspace",
            ["preview"] = JsonNode.Parse(effect.Parameters.GetProperty("preview").GetRawText()),
            ["values"] = values,
        }, PetWorkspacePlanRpcJsonContext.Default.JsonObject));
    }

    public async Task<Result<PetRunEffect>> PreviewAsync(PetRunRecord run, JsonElement args, CancellationToken cancellationToken)
    {
        if (Name == "workspace.remember")
        {
            var settings = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), cancellationToken).ConfigureAwait(false);
            if (settings.Settings.MemoryMode == PetMemoryModes.Off || run.ProtectedRead)
            {
                return Result.Failure<PetRunEffect>(new("pet_plans.memory_held", "Memory is disabled or this conversation has read protected content. Nothing was saved."));
            }
        }
        var loaded = await catalog.LoadAsync(cancellationToken).ConfigureAwait(false);
        if (loaded.IsFailure)
        {
            return Result.Failure<PetRunEffect>(loaded.Error);
        }

        var flat = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("operation", out _);
        var request = Request(run, flat ? "prepare_flat" : "prepare");
        if (!flat)
        {
            request["capability"] = Name;
        }

        request["arguments"] = flat ? JsonValue.Create(args.GetRawText()) : JsonNode.Parse(args.GetRawText());
        var prepared = await worker.WorkspacePlanRpcAsync(request, cancellationToken).ConfigureAwait(false);
        if (prepared.IsFailure)
        {
            return Result.Failure<PetRunEffect>(prepared.Error);
        }

        if (!prepared.Value.TryGetProperty("ok", out var ok) || ok.ValueKind != JsonValueKind.True
            || !prepared.Value.TryGetProperty("prepared", out var snapshot) || snapshot.ValueKind != JsonValueKind.Object
            || snapshot.GetProperty("operation").GetString() != Name["workspace.".Length..])
        {
            return Result.Failure<PetRunEffect>(new("pet_plans.preparation_refused", "The workspace operation needs a fresh plan."));
        }

        var revisions = new List<string>();
        foreach (var target in snapshot.GetProperty("targetIds").EnumerateArray())
        {
            if (!target.TryGetGuid(out var id))
            {
                return Refused();
            }

            var item = Name == "workspace.restore_item"
                ? await items.FindStoredAsync(ItemId.From(id), cancellationToken).ConfigureAwait(false)
                : await items.FindAsync(ItemId.From(id), cancellationToken).ConfigureAwait(false);
            var inSubtree = run.ScopeRootItemId is { } root
                && await items.IsVisibleSubtreeMemberAsync(run.WorkspaceId, ItemId.From(root), ItemId.From(id), cancellationToken).ConfigureAwait(false);
            if (item is null || item.WorkspaceId != run.WorkspaceId || (!run.WorkspaceScope && run.ItemId?.Value != id
                && !run.SourceItemIds.Contains(id) && !inSubtree && !(ReadOnlyOperation(Name) && run.ReadOnlySourceItemIds?.Contains(id) == true))
                || !ReadOnlyOperation(Name) && (run.ReadOnlySourceItemIds?.Contains(id) == true || run.ScopeRootItemId is not null && !inSubtree))
            {
                return Refused();
            }

            var revision = await items.ReadPetRevisionAsync(run.WorkspaceId, item.Id, pin: false, cancellationToken).ConfigureAwait(false);
            if (revision is null)
            {
                return Refused();
            }

            revisions.Add(string.Create(CultureInfo.InvariantCulture, $"{id:D}:{revision}"));
        }
        var finalCheck = await worker.WorkspacePlanRpcAsync(request, cancellationToken).ConfigureAwait(false);
        if (finalCheck.IsFailure || !finalCheck.Value.TryGetProperty("prepared", out var current)
            || current.GetProperty("freshnessFingerprint").GetString() != snapshot.GetProperty("freshnessFingerprint").GetString())
        {
            return Refused();
        }

        var saved = JsonNode.Parse(snapshot.GetRawText())!.AsObject();
        saved["revisions"] = revisions.Count == 0 ? "" : $"{run.WorkspaceId.Value:D}|{string.Join(',', revisions.Order(StringComparer.Ordinal))}";
        return Result.Success(new PetRunEffect(snapshot.GetProperty("preview").GetProperty("headline").GetString() ?? "Review the workspace change",
            JsonSerializer.SerializeToElement(saved, PetWorkspacePlanRpcJsonContext.Default.JsonObject)));
    }

    internal Task<Result<JsonElement>> BeginExecutionAsync(PetRunRecord run, PetRunEffect effect, CancellationToken cancellationToken)
    {
        if (run.PlanExecution is null)
        {
            return Task.FromResult(Result.Failure<JsonElement>(new("pet_plans.execution_missing", "The reviewed execution context is missing.")));
        }

        var request = Request(run, "execute");
        request["prepared"] = JsonNode.Parse(effect.Parameters.GetRawText());
        request["binding"] = Binding(run.PlanExecution);
        if (run.BuildLedger is { ValueKind: JsonValueKind.Array } ledger)
        {
            request["buildLedger"] = JsonNode.Parse(ledger.GetRawText());
        }
        return worker.WorkspacePlanRpcAsync(request, cancellationToken);
    }
    internal Task<Result<JsonElement>> PollExecutionAsync(PetRunRecord run, CancellationToken cancellationToken)
    {
        if (run.PlanExecution is null)
        {
            return Task.FromResult(Result.Failure<JsonElement>(new("pet_plans.execution_missing", "The reviewed execution context is missing.")));
        }

        return worker.WorkspacePlanRpcAsync(new JsonObject
        {
            ["kind"] = "poll",
            ["tenantId"] = run.TenantId.Value,
            ["principalId"] = run.ActorId.Value,
            ["workspaceId"] = run.WorkspaceId.Value,
            ["binding"] = Binding(run.PlanExecution)
        }, cancellationToken);
    }
    public async Task<PetPlanExecutionOutcome> DiscoverAsync(PetRunRecord run, PetRunEffect prepared, CancellationToken cancellationToken)
    {
        if (!ReadOnlyOperation(Name))
        {
            return new("refused", null, new("pet_plans.discovery_write", "Discovery cannot make a workspace change."));
        }
        var request = Request(run, "discover");
        request["prepared"] = JsonNode.Parse(prepared.Parameters.GetRawText());
        var response = await worker.WorkspacePlanRpcAsync(request, cancellationToken).ConfigureAwait(false);
        if (response.IsFailure)
        {
            return new("refused", null, response.Error);
        }
        var root = response.Value;
        return root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True
            && root.TryGetProperty("receipt", out var receipt) && receipt.ValueKind == JsonValueKind.String
            ? new("applied", receipt.GetString(), LockedContent: root.TryGetProperty("lockedContent", out var locked) && locked.ValueKind == JsonValueKind.True,
                SourceItemIds: ReadSources(root), UnboundedSourceProvenance: root.TryGetProperty("unboundedSourceProvenance", out var unbounded) && unbounded.ValueKind == JsonValueKind.True)
            : new("refused", null, new("pet_plans.discovery_refused", "The workspace read could not be confirmed."));
    }

    public async Task<Result<string>> ApplyAsync(PetRunRecord run, Guid actionId, PetRunEffect effect, CancellationToken cancellationToken)
    {
        var outcome = await ApplyPlanAsync(run, actionId, effect, cancellationToken).ConfigureAwait(false);
        return outcome.Status == "applied" && outcome.Receipt is { } receipt ? Result.Success(receipt)
            : Result.Failure<string>(outcome.Failure ?? new NixError("pet_plans.execution_uncertain", "The operation has not confirmed its result."));
    }

    public async Task<PetPlanExecutionOutcome> ApplyPlanAsync(PetRunRecord run, Guid executionId, PetRunEffect effect, CancellationToken cancellationToken)
    {
        var result = await BeginExecutionAsync(run, effect, cancellationToken).ConfigureAwait(false);
        for (var attempt = 0; attempt < 60 && result.IsSuccess; attempt++)
        {
            var root = result.Value;
            var state = root.TryGetProperty("state", out var field) ? field.GetString() : null;
            var receipt = root.TryGetProperty("receipt", out var receiptField) && receiptField.ValueKind == JsonValueKind.String ? receiptField.GetString() : null;
            if (state == "completed" && !string.IsNullOrWhiteSpace(receipt))
            {
                return new("applied", receipt, LockedContent: root.TryGetProperty("lockedContent", out var locked) && locked.ValueKind == JsonValueKind.True,
                SourceItemIds: ReadSources(root), UnboundedSourceProvenance: root.TryGetProperty("unboundedSourceProvenance", out var unbounded) && unbounded.ValueKind == JsonValueKind.True);
            }
            if (state is "partial" or "failed" or "unknown" or "refused")
            {
                var status = state == "partial" ? "partial" : state == "refused" ? "refused" : "unknown";
                return new(status, receipt, new("pet_plans." + status, status == "partial"
                    ? "Part of this operation completed. Review its receipt before planning more changes."
                    : "The operation stopped or its result is uncertain. Inspect Nix before retrying."));
            }
            if (state == "waiting" || Executor(effect) == "client")
            {
                return new("waiting_for_handoff", null, new("pet_plans.waiting_client", "The plan is waiting for its owner client."));
            }
            await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken).ConfigureAwait(false);
            result = await PollExecutionAsync(run, cancellationToken).ConfigureAwait(false);
        }
        return new("unknown", null, result.IsFailure ? result.Error
            : new("pet_plans.execution_uncertain", "The operation has not confirmed its result. Inspect Nix before retrying."));
    }

    public string? ModelObservation(PetRunEffect effect, string receipt) => ReadOnlyOperation(Name) ? receipt : null;

    private static Guid[]? ReadSources(JsonElement root)
    {
        if (!root.TryGetProperty("sourceItemIds", out var sources) || sources.ValueKind != JsonValueKind.Array || sources.GetArrayLength() > 128)
        {
            return null;
        }
        var ids = new List<Guid>();
        foreach (var source in sources.EnumerateArray())
        {
            if (!source.TryGetGuid(out var id) || id == Guid.Empty)
            {
                return null;
            }
            ids.Add(id);
        }
        return ids.Distinct().ToArray();
    }

    private JsonObject Request(PetRunRecord run, string kind)
    {
        var request = new JsonObject
        {
            ["kind"] = kind,
            ["tenantId"] = run.TenantId.Value,
            ["principalId"] = run.ActorId.Value,
            ["workspaceId"] = run.WorkspaceId.Value,
            ["timeZone"] = run.TimeZone ?? "UTC",
            ["lockedRead"] = run.ProtectedRead,
            ["token"] = tokens.MintPetPlanRead(run.ActorId, run.TenantId, run.Id),
        };
        if (run.ScopeRootItemId is { } root)
        {
            request["scope"] = new JsonObject { ["rootItemId"] = root, ["readOnly"] = false };
        }
        return request;
    }
    private static JsonObject Binding(PetPlanExecutionBinding value) => new()
    {
        ["runId"] = value.RunId,
        ["planId"] = value.PlanId,
        ["planVersion"] = value.PlanVersion,
        ["reviewDigest"] = value.ReviewDigest,
        ["stepId"] = value.StepId,
        ["claimId"] = value.ClaimId,
        ["executionId"] = value.ExecutionId,
        ["frozenArgumentsHash"] = value.FrozenArgumentsHash,
        ["jobId"] = value.JobId,
        ["workerExecutionId"] = value.WorkerExecutionId,
    };
    private static Result<PetRunEffect> Refused() => Result.Failure<PetRunEffect>(new("pet_plans.scope", "The operation is outside this plan's writable workspace scope."));
}
