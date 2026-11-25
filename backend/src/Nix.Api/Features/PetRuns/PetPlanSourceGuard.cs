using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions.PetRuns;
using Nix.Features.Pets;

namespace Nix.Features.PetRuns;

[SuppressMessage("Performance", "CA1812", Justification = "Created by scoped dependency injection.")]
internal sealed class PetPlanSourceGuard(PetWorkerClient worker)
{
    internal async Task<(bool Available, bool ProtectedRead)> CheckAsync(PetRunRecord run, PetRunCheckpoint state, CancellationToken cancellationToken)
    {
        if (state.PlanRequest is not { ChatSource: { } source, SourceBindings: { } bindings } request)
        {
            return (true, state.PlanRequest?.ProtectedRead ?? false);
        }
        var payload = new JsonObject { ["toolIds"] = new JsonArray(source.ToolCallIds.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()) };
        var inspected = await worker.PlanToolsRpcAsync(PetRunService.ChatRequest(run, state, "plan_tools_inspect", payload), cancellationToken).ConfigureAwait(false);
        if (inspected.IsFailure || !inspected.Value.TryGetProperty("tools", out var tools) || tools.ValueKind != JsonValueKind.Array
            || tools.GetArrayLength() != bindings.Count
            || (inspected.Value.TryGetProperty("readOnly", out var readOnly) && readOnly.ValueKind == JsonValueKind.True) != request.SourceReadOnly)
        {
            return (false, request.ProtectedRead);
        }
        var root = inspected.Value.TryGetProperty("rootItemId", out var rawRoot) && rawRoot.ValueKind == JsonValueKind.String
            && Guid.TryParse(rawRoot.GetString(), out var rootId) ? rootId : (Guid?)null;
        if (root != source.RootItemId)
        {
            return (false, request.ProtectedRead);
        }
        if (!inspected.Value.TryGetProperty("sourceScope", out var rawScope))
        {
            return (false, request.ProtectedRead);
        }
        PetPlanSourceScope? scope;
        try { scope = rawScope.Deserialize(PetPlanJsonContext.Default.PetPlanSourceScope); }
        catch (JsonException) { return (false, request.ProtectedRead); }
        if (scope is null || PetPlanExecution.Canonical(JsonSerializer.SerializeToElement(scope, PetPlanJsonContext.Default.PetPlanSourceScope))
            != PetPlanExecution.Canonical(JsonSerializer.SerializeToElement(request.SourceScope, PetPlanJsonContext.Default.PetPlanSourceScope)))
        {
            return (false, request.ProtectedRead);
        }
        if (!inspected.Value.TryGetProperty("contextSourceItemIds", out var sources) || sources.ValueKind != JsonValueKind.Array
            || sources.GetArrayLength() > 128 || !inspected.Value.TryGetProperty("contextUnbounded", out var unbounded)
            || unbounded.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
            || unbounded.GetBoolean() != request.UnboundedDisclosure)
        {
            return (false, request.ProtectedRead);
        }
        var actual = new HashSet<Guid>();
        foreach (var sourceId in sources.EnumerateArray())
        {
            if (sourceId.ValueKind != JsonValueKind.String || !sourceId.TryGetGuid(out var id) || id == Guid.Empty || !actual.Add(id))
            {
                return (false, request.ProtectedRead);
            }
        }
        if (!actual.Order().SequenceEqual((request.DisclosureSourceItemIds ?? []).Order()))
        {
            return (false, request.ProtectedRead);
        }
        foreach (var tool in tools.EnumerateArray())
        {
            if (!tool.TryGetProperty("planBinding", out var raw) || raw.Deserialize(PetPlanJsonContext.Default.PetPlanToolBinding) is not { } binding
                || !bindings.Contains(binding) || tool.GetProperty("status").GetString() != "adopted")
            {
                return (false, request.ProtectedRead);
            }
        }
        var currentProtected = request.ProtectedRead || inspected.Value.TryGetProperty("lockedRead", out var locked) && locked.ValueKind == JsonValueKind.True
            || inspected.Value.TryGetProperty("contextProtected", out var contextProtected) && contextProtected.ValueKind == JsonValueKind.True;
        return (true, currentProtected);
    }
}
