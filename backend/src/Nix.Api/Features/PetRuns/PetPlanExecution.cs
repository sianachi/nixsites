using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Primitives;
using Nix.Features.Pets;

namespace Nix.Features.PetRuns;

internal static class PetPlanExecution
{
    internal const int MaximumSteps = 12;

    internal static bool ValidScope(PetPlanSourceScope? scope, Guid? anchor) => scope is not null
        && scope.Kind is "workspace" or "selected" or "subtree"
        && (scope.ItemIds is null || scope.ItemIds.Count <= 24)
        && scope.ItemIds?.Contains(Guid.Empty) != true
        && scope.ItemIds?.Distinct().Count() == scope.ItemIds?.Count
        && (scope.ReadOnlyWorkspaceIds is null || scope.ReadOnlyWorkspaceIds.Count <= 20
            && !scope.ReadOnlyWorkspaceIds.Contains(Guid.Empty)
            && scope.ReadOnlyWorkspaceIds.Distinct().Count() == scope.ReadOnlyWorkspaceIds.Count)
        && (scope.Kind != "workspace" || scope.ItemIds is null or { Count: 0 })
        && (scope.Kind != "subtree" || anchor is not null);

    internal static bool ValidChatSource(PetPlanChatSource? source) => source is null
        || source.TurnId != Guid.Empty && source.ConversationId is { Length: > 0 and <= 200 }
        && source.ToolCallIds is { Count: > 0 and <= MaximumSteps }
        && source.ToolCallIds.All(id => id is { Length: > 0 and <= 200 })
        && source.ToolCallIds.Distinct(StringComparer.Ordinal).Count() == source.ToolCallIds.Count
        && source.Mode is null or "chat" or "consult";

    internal static bool SameStart(PetRunRecord run, PetRunCheckpoint state, StartPetPlanRequest request) =>
        state.PlanRequest is { } original && (original.StartFingerprint is { } fingerprint ? fingerprint == StartFingerprint(request)
        : state.PetId == request.PetId
        && run.Brief == request.Brief?.Trim() && run.ItemId?.Value == request.AnchorItemId
        && state.AfterMessageId == request.AfterMessageId
        && Canonical(JsonSerializer.SerializeToElement(original.SourceScope)) == Canonical(JsonSerializer.SerializeToElement(request.SourceScope))
        && Canonical(JsonSerializer.SerializeToElement(original.ChatSource)) == Canonical(JsonSerializer.SerializeToElement(request.ChatSource)));

    internal static string StartFingerprint(StartPetPlanRequest request) => Hash(JsonSerializer.SerializeToElement(new
    {
        request.PetId,
        Brief = request.Brief?.Trim(),
        request.AnchorItemId,
        request.SourceScope,
        request.ChatSource,
        request.AfterMessageId,
    }));

    internal static bool Matches(PetPlanPrepared plan, Guid id, int version, string digest) =>
        plan.Id == id && plan.Version == version && string.Equals(plan.ReviewDigest, digest, StringComparison.Ordinal);

    internal static string Hash(JsonElement value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Canonical(value))));

    internal static JsonObject NativeContext(PetRunRecord run, string revisions) => new()
    {
        ["tenantId"] = run.TenantId.Value,
        ["principalId"] = run.ActorId.Value,
        ["workspaceId"] = run.WorkspaceId.Value,
        ["binding"] = JsonSerializer.SerializeToNode(run.PlanExecution, PetPlanDispatchJsonContext.Default.PetPlanExecutionBinding),
        ["revisions"] = revisions,
    };

    internal static string Digest(PetRunRecord run, PetPlanPrepared plan) => Hash(JsonSerializer.SerializeToElement(new
    {
        contractVersion = 1,
        runId = run.Id,
        workspaceId = run.WorkspaceId.Value,
        anchorItemId = run.ItemId?.Value,
        actorId = run.ActorId.Value,
        plan.Id,
        plan.Version,
        plan.Summary,
        plan.ScopeDigest,
        plan.RecipientRevision,
        plan.ProtectedRead,
        steps = plan.Steps.Select(step => new { step.Id, step.Capability, step.Arguments, step.Effect, step.Executor, step.Fields, step.IncludedInReview }),
    }));

    internal static string Canonical(JsonElement value) => CanonicalNode(value)?.ToJsonString() ?? "null";

    private static JsonNode? CanonicalNode(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => new JsonObject(value.EnumerateObject().OrderBy(property => property.Name, StringComparer.Ordinal)
            .Select(property => new KeyValuePair<string, JsonNode?>(property.Name, CanonicalNode(property.Value)))),
        JsonValueKind.Array => new JsonArray(value.EnumerateArray().Select(CanonicalNode).ToArray()),
        JsonValueKind.Undefined or JsonValueKind.Null => null,
        _ => JsonNode.Parse(value.GetRawText()),
    };

    internal static IReadOnlyList<PetPlanEditableField> Fields(JsonElement arguments, PetRunEffect effect)
    {
        var fields = new List<PetPlanEditableField>();
        Walk(arguments, []);
        return fields;

        void Walk(JsonElement value, string[] path)
        {
            if (fields.Count >= 100 || path.Length > 12)
            {
                return;
            }
            if (value.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in value.EnumerateObject())
                {
                    if (property.Name is "operation" or "operationId" or "path" or "query" or "itemId" or "parentId"
                        or "workspaceId" or "templateId" or "id" or "kind" or "type" || property.Name.EndsWith("Id", StringComparison.Ordinal))
                    {
                        continue;
                    }
                    Walk(property.Value, [.. path, property.Name]);
                }
            }
            else if (path.Length > 0 && value.ValueKind is JsonValueKind.String or JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False)
            {
                var id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\0', path))))[..24];
                JsonElement? before = null;
                if (path is ["title"] && effect.Parameters.TryGetProperty("from", out var from))
                {
                    before = from.Clone();
                }
                fields.Add(new(id, string.Join(" / ", path), value.ValueKind switch
                {
                    JsonValueKind.Number => "number",
                    JsonValueKind.True or JsonValueKind.False => "boolean",
                    _ => "text",
                }, value.Clone(), CurrentValue: before, ArgumentPath: path));
            }
        }
    }

    internal static Result<IReadOnlyList<PetTaskPlanStep>> Edit(PetPlanPrepared plan, IReadOnlyList<PetPlanFieldEdit> edits)
    {
        if (edits.Any(edit => edit is null) || edits.GroupBy(edit => (edit.StepId, edit.FieldId)).Any(group => group.Count() != 1))
        {
            return Invalid("Change each stored field at most once.");
        }
        var arguments = plan.Steps.ToDictionary(step => step.Id, step => JsonNode.Parse(step.Arguments.GetRawText())!);
        foreach (var edit in edits)
        {
            var step = plan.Steps.SingleOrDefault(candidate => candidate.Id == edit.StepId);
            var field = step?.Fields.SingleOrDefault(candidate => candidate.Id == edit.FieldId);
            if (field?.ArgumentPath is not { Count: > 0 } path || !FitsField(field, edit.Value))
            {
                return Invalid("Choose a current editable field and a value of its stated type.");
            }
            JsonNode? node = arguments[edit.StepId];
            foreach (var key in path.Take(path.Count - 1))
            {
                node = node is JsonObject group ? group[key] : null;
            }
            if (node is not JsonObject parent || !parent.ContainsKey(path[^1]))
            {
                return Invalid("This field needs a fresh preview.");
            }
            parent[path[^1]] = JsonNode.Parse(edit.Value.GetRawText());
        }
        return Result.Success<IReadOnlyList<PetTaskPlanStep>>([.. plan.Steps.Select(step =>
            new PetTaskPlanStep(step.Capability, JsonSerializer.SerializeToElement(arguments[step.Id])))]);
    }

    private static bool FitsField(PetPlanEditableField field, JsonElement value) => field.Kind switch
    {
        "text" or "date" => value.ValueKind == JsonValueKind.String && value.GetString()!.Length <= 128_000,
        "number" => value.ValueKind == JsonValueKind.Number,
        "boolean" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
        "choice" => value.ValueKind == JsonValueKind.String && field.Choices?.Contains(value.GetString()!, StringComparer.Ordinal) == true,
        _ => false,
    };

    private static Result<IReadOnlyList<PetTaskPlanStep>> Invalid(string message) =>
        Result.Failure<IReadOnlyList<PetTaskPlanStep>>(new NixError("pet_plans.invalid_fields", message));
}
