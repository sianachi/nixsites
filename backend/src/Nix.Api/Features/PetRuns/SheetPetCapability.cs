using System.Diagnostics.CodeAnalysis;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Authentication;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Workers;

namespace Nix.Features.PetRuns;

[SuppressMessage("Performance", "CA1812", Justification = "Created by the pet-run service registration.")]
internal sealed class SheetPetCapability(
    IHttpClientFactory clients,
    IConfiguration configuration,
    IItemTree tree,
    IItemLocks locks,
    IPermissionResolver permissions,
    SelfIssuedTokenService tokens) : IPetRunCapability
{
    private static readonly JsonElement Schema = ReadSchema();

    public string Name => "sheet.edit";
    public string Description => "Edit a native Nix spreadsheet. Supply itemId for a selected sheet or a sheet in a workspace-scoped run. "
        + "Set cells using uppercase A1 addresses, strings for values or formulas, and null to clear a cell. "
        + "Grow the grid with rows or columns. Change or reset columnWidths using column letters and a width or null.";
    public JsonElement? InputSchema => Schema;
    public bool Reversible => true;

    public async Task<Result<PetRunEffect>> PreviewAsync(
        PetRunRecord run, JsonElement args, CancellationToken cancellationToken)
    {
        if (args.ValueKind != JsonValueKind.Object)
        {
            return Refused<PetRunEffect>("Provide a sheet edit plan.");
        }
        var itemId = run.ItemId;
        if (args.TryGetProperty("itemId", out var target))
        {
            if (!TryReadItem(target, out itemId))
            {
                return Refused<PetRunEffect>("Choose a valid sheet item.");
            }
        }
        var item = await AuthorizeAsync(run, itemId, cancellationToken).ConfigureAwait(false);
        if (item is null)
        {
            return Refused<PetRunEffect>("The sheet is outside this run's editable scope.");
        }
        var plan = JsonNode.Parse(args.GetRawText())!.AsObject();
        plan.Remove("itemId");
        var request = new JsonObject { ["kind"] = "preview", ["plan"] = plan };
        var result = await SendAsync(run, itemId, Guid.NewGuid(), request, write: false, cancellationToken).ConfigureAwait(false);
        return result.Match(
            preview => Result.Success(new PetRunEffect(
                $"Edit sheet {ItemProperties.ReadTitle(item.Properties)}",
                JsonSerializer.SerializeToElement(new JsonObject
                {
                    ["kind"] = "sheet",
                    ["itemId"] = itemId.Value,
                    ["preview"] = JsonNode.Parse(preview.GetRawText()),
                }, SheetPetJsonContext.Default.JsonObject))),
            Result.Failure<PetRunEffect>);
    }

    public Task<Result<string>> ApplyAsync(
        PetRunRecord run, Guid actionId, PetRunEffect effect, CancellationToken cancellationToken) =>
        ExecuteAsync(run, actionId, effect, null, cancellationToken);

    public Task<Result<string>> UndoAsync(
        PetRunRecord run, Guid actionId, PetRunEffect effect, string receipt, CancellationToken cancellationToken) =>
        ExecuteAsync(run, actionId, effect, receipt, cancellationToken);

    private async Task<Result<string>> ExecuteAsync(
        PetRunRecord run, Guid actionId, PetRunEffect effect, string? receipt, CancellationToken cancellationToken)
    {
        if (effect.Parameters.ValueKind != JsonValueKind.Object
            || !effect.Parameters.TryGetProperty("itemId", out var target) || !TryReadItem(target, out var itemId)
            || !effect.Parameters.TryGetProperty("preview", out var preview))
        {
            return Refused<string>("The saved sheet preview is invalid.");
        }
        if (await AuthorizeAsync(run, itemId, cancellationToken).ConfigureAwait(false) is null)
        {
            return Refused<string>("The sheet is no longer available for editing.");
        }
        var request = new JsonObject
        {
            ["kind"] = receipt is null ? "apply" : "undo",
            ["preview"] = JsonNode.Parse(preview.GetRawText()),
            ["actionId"] = actionId,
        };
        if (receipt is not null)
        {
            try
            {
                request["receipt"] = JsonNode.Parse(receipt);
            }
            catch (JsonException)
            {
                return Refused<string>("The saved sheet receipt is invalid.");
            }
        }
        var result = await SendAsync(run, itemId, actionId, request, write: true, cancellationToken).ConfigureAwait(false);
        return result.Match(value => Result.Success(value.GetRawText()), Result.Failure<string>);
    }

    private async Task<Item?> AuthorizeAsync(PetRunRecord run, ItemId itemId, CancellationToken cancellationToken)
    {
        if (run.ReadOnlySourceItemIds?.Contains(itemId.Value) == true
            || itemId != run.ItemId && !run.WorkspaceScope && !run.SourceItemIds.Contains(itemId.Value))
        {
            return null;
        }
        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        return item is { Type: "spreadsheet" } && item.WorkspaceId == run.WorkspaceId
            && !ItemSettings.Read(item.Settings).WithholdFromPets
            && await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false)
            && (await locks.LockedAmongAsync([itemId], cancellationToken).ConfigureAwait(false)).Count == 0
            ? item : null;
    }

    private async Task<Result<JsonElement>> SendAsync(
        PetRunRecord run, ItemId itemId, Guid actionId, JsonObject body, bool write, CancellationToken cancellationToken)
    {
        var address = configuration["Nix:Pets:WorkerUrl"];
        var secret = configuration["Nix:InternalSecret"];
        if (!tokens.IsConfigured || string.IsNullOrWhiteSpace(secret)
            || !Uri.TryCreate(address, UriKind.Absolute, out var origin)
            || origin.Scheme is not ("http" or "https") || origin.AbsolutePath != "/"
            || origin.UserInfo.Length != 0 || origin.Query.Length != 0 || origin.Fragment.Length != 0)
        {
            return Refused<JsonElement>("Sheet execution is unavailable.");
        }
        var binding = PetActionRequestBinding.Create("GET", $"/internal/authz/items/{itemId.Value:D}", body: null);
        body["itemId"] = itemId.Value;
        body["token"] = tokens.MintPetAction(run.ActorId, run.TenantId, actionId, write ? PetTurnMode.Write : PetTurnMode.Read, binding);
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(origin, "/v1/sani/pet-sheet"))
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        request.Headers.Add("X-Nix-Internal-Secret", secret);
        using var client = clients.CreateClient(WorkerLoopbackClient.HttpClientName);
        client.Timeout = TimeSpan.FromSeconds(40);
        client.MaxResponseContentBufferSize = 64 * 1024;
        try
        {
            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return Refused<JsonElement>("The sheet worker refused the action.", write && (int)response.StatusCode >= 500);
            }
            using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var result = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
            var reply = result.RootElement;
            if (reply.ValueKind == JsonValueKind.Object && reply.TryGetProperty("ok", out var ok))
            {
                if (ok.ValueKind == JsonValueKind.True && reply.TryGetProperty(write ? "receipt" : "preview", out var value)
                    && value.ValueKind == JsonValueKind.Object)
                {
                    return Result.Success(value.Clone());
                }
                if (ok.ValueKind == JsonValueKind.False)
                {
                    var uncertain = write && reply.TryGetProperty("code", out var code)
                        && code.ValueKind == JsonValueKind.String && code.ValueEquals("sheet_edit.uncertain");
                    var detail = reply.TryGetProperty("detail", out var error) && error.ValueKind == JsonValueKind.String
                        ? error.GetString() : null;
                    return Refused<JsonElement>(detail ?? "The sheet worker refused the action.", uncertain);
                }
            }
        }
        catch (Exception error) when (error is HttpRequestException or System.IO.IOException or JsonException or OperationCanceledException)
        {
            return Refused<JsonElement>("The sheet action could not be verified.", write);
        }
        return Refused<JsonElement>("The sheet action could not be verified.", write);
    }

    private static bool TryReadItem(JsonElement target, out ItemId itemId)
    {
        itemId = default;
        if (target.ValueKind != JsonValueKind.String || !target.TryGetGuid(out var id) || id == Guid.Empty)
        {
            return false;
        }
        itemId = new ItemId(id);
        return true;
    }

    private static Result<T> Refused<T>(string detail, bool uncertain = false) =>
        Result.Failure<T>(new NixError(uncertain ? "pet_runs.outcome_unknown" : "pet_runs.sheet_refused", detail));

    private static JsonElement ReadSchema()
    {
        using var document = JsonDocument.Parse("""
            {"type":"object","additionalProperties":false,"properties":{
              "itemId":{"type":"string","format":"uuid"},
              "cells":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,
                    "required":["cell","value"],"properties":{"cell":{"type":"string","pattern":"^[A-Z]{1,2}[1-9][0-9]{0,4}$"},"value":{"type":["string","null"],"maxLength":2048}}}},
              "rows":{"type":"integer","minimum":1,"maximum":10000},
              "columns":{"type":"integer","minimum":1,"maximum":702},
              "columnWidths":{"type":"array","maxItems":128,"items":{"type":"object","additionalProperties":false,
                    "required":["column","width"],"properties":{"column":{"type":"string","pattern":"^[A-Z]{1,2}$"},"width":{"type":["integer","null"],"minimum":48,"maximum":800}}}}
            }}
            """);
        return document.RootElement.Clone();
    }
}

[JsonSerializable(typeof(JsonObject))]
internal sealed partial class SheetPetJsonContext : JsonSerializerContext;
