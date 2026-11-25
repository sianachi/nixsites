using System.Diagnostics.CodeAnalysis;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Authentication;
using Nix.Domain.Items;
using Nix.Domain.Primitives;

namespace Nix.Features.PetRuns;

[SuppressMessage("Performance", "CA1812", Justification = "Created by the typed HTTP client factory.")]
internal sealed class PetCanvasCapability(
    HttpClient http,
    IConfiguration configuration,
    IItemTree tree,
    IVisibleItems visible,
    IItemLocks locks,
    SelfIssuedTokenService tokens) : IPetRunCapability
{
    private static readonly JsonElement Schema = ReadSchema();

    public string Name => "canvas.edit";
    public bool PlanRequestDispatch => true;
    public string Description => "Edit native canvas elements. Supply itemId for a workspace-scoped job, elements to add or edit, and remove for IDs to delete. "
        + "Boxes use id, type (rectangle, diamond, or ellipse), x, y, width, height, and optional nixItemId to make a linked Nix card. "
        + "Text uses id, type=text, text, and either containerId or x and y. Arrow uses id, type=arrow, from and to box IDs and optional via points. "
        + "Line and freedraw use id, type, and points as [x,y] pairs. Set groupIds to group shapes. "
        + "Style can provide strokeColor, backgroundColor, strokeWidth, strokeStyle, fillStyle, and opacity.";
    public JsonElement? InputSchema => Schema;
    public bool Reversible => true;

    internal static void Register(IServiceCollection services)
    {
        services.AddHttpClient<PetCanvasCapability>(client =>
        {
            client.Timeout = TimeSpan.FromSeconds(45);
            client.MaxResponseContentBufferSize = 560 * 1024;
        }).ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
        });
        services.AddScoped<IPetRunCapability>(service => service.GetRequiredService<PetCanvasCapability>());
        services.AddScoped<IPetRunCapability, PetCanvasReadCapability>();
    }

    public async Task<Result<PetRunEffect>> PreviewAsync(
        PetRunRecord run, JsonElement args, CancellationToken cancellationToken)
    {
        if (args.ValueKind != JsonValueKind.Object)
        {
            return Result.Failure<PetRunEffect>(Error("Provide a canvas edit plan."));
        }
        var plan = JsonNode.Parse(args.GetRawText())!.AsObject();
        ItemId itemId;
        if (args.TryGetProperty("itemId", out var target))
        {
            if (target.ValueKind != JsonValueKind.String || !target.TryGetGuid(out var parsed) || parsed == Guid.Empty)
            {
                return Result.Failure<PetRunEffect>(Error("Choose a valid canvas item."));
            }
            itemId = new ItemId(parsed);
            plan.Remove("itemId");
        }
        else if (run.ItemId is { } anchor)
        {
            itemId = anchor;
        }
        else
        {
            return Result.Failure<PetRunEffect>(Error("Choose the canvas to edit."));
        }
        var item = await AuthorizedCanvasAsync(run, itemId, cancellationToken).ConfigureAwait(false);
        if (item is null)
        {
            return Result.Failure<PetRunEffect>(Error("The canvas is outside this run's scope."));
        }
        var revision = await tree.ReadPetRevisionAsync(run.WorkspaceId, itemId, pin: false, cancellationToken).ConfigureAwait(false);
        var reply = await SendAsync(run, itemId, Guid.NewGuid(), "preview", "plan", plan, cancellationToken).ConfigureAwait(false);
        if (run.RequestId is not null && (revision is null
            || revision != await tree.ReadPetRevisionAsync(run.WorkspaceId, itemId, pin: false, cancellationToken).ConfigureAwait(false)))
        {
            return Result.Failure<PetRunEffect>(Error("The canvas changed while its preview was prepared."));
        }
        if (reply.IsFailure)
        {
            return Result.Failure<PetRunEffect>(reply.Error);
        }
        var preview = reply.Value;
        if (!TryReadLinks(preview, out var links)
            || !await CanReadLinksAsync(run, links, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<PetRunEffect>(Error("One of the linked items is outside this run's scope."));
        }
        return Result.Success(new PetRunEffect(
            $"Edit canvas {ItemProperties.ReadTitle(item.Properties)}",
            JsonSerializer.SerializeToElement(new JsonObject
            {
                ["kind"] = "canvas",
                ["itemId"] = itemId.Value,
                ["preview"] = JsonNode.Parse(preview.GetRawText()),
                ["revisions"] = revision is { } expected ? FormattableString.Invariant($"{run.WorkspaceId.Value:D}|{itemId.Value:D}:{expected}") : "",
            }, PetCanvasJsonContext.Default.JsonObject)));
    }

    public Task<Result<string>> ApplyAsync(
        PetRunRecord run, Guid actionId, PetRunEffect effect, CancellationToken cancellationToken) =>
        ExecuteAsync(run, actionId, effect, null, cancellationToken);

    public Task<Result<string>> UndoAsync(
        PetRunRecord run, Guid actionId, PetRunEffect effect, string receipt, CancellationToken cancellationToken) =>
        ExecuteAsync(run, actionId, effect, receipt, cancellationToken);

    public async Task<string?> RevisionObservationAsync(
        PetRunRecord run, PetRunEffect effect, CancellationToken cancellationToken)
    {
        if (!TryReadPreview(effect, out var itemId, out var preview, out var links)
            || !preview.TryGetProperty("scene", out var scene) || scene.ValueKind != JsonValueKind.Array
            || await AuthorizedCanvasAsync(run, itemId, cancellationToken).ConfigureAwait(false) is null
            || !await CanReadLinksAsync(run, links, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        const int budget = 1800;
        var entries = new List<string>();
        var length = 2;
        foreach (var element in scene.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.Object
                || element.TryGetProperty("isDeleted", out var deleted) && deleted.ValueKind == JsonValueKind.True)
            {
                continue;
            }
            var entry = ProjectElement(element).ToJsonString();
            if (length + entry.Length + 1 > budget)
            {
                break;
            }
            entries.Add(entry);
            length += entry.Length + 1;
        }
        return $"[{string.Join(',', entries)}]";
    }

    private static JsonObject ProjectElement(JsonElement element)
    {
        var projected = new JsonObject();
        foreach (var field in new[] { "id", "type", "text", "containerId" })
        {
            if (element.TryGetProperty(field, out var property) && property.ValueKind == JsonValueKind.String)
            {
                projected[field] = TextCut.Cut(property.GetString()!, 96);
            }
        }
        foreach (var field in new[] { "x", "y", "width", "height" })
        {
            if (element.TryGetProperty(field, out var coordinate) && coordinate.ValueKind == JsonValueKind.Number
                && coordinate.TryGetDouble(out var value) && double.IsFinite(value))
            {
                projected[field] = Math.Round(value);
            }
        }
        foreach (var (field, name) in new[] { ("startBinding", "from"), ("endBinding", "to") })
        {
            if (element.TryGetProperty(field, out var binding) && binding.ValueKind == JsonValueKind.Object
                && binding.TryGetProperty("elementId", out var id) && id.ValueKind == JsonValueKind.String)
            {
                projected[name] = TextCut.Cut(id.GetString()!, 96);
            }
        }
        return projected;
    }

    private async Task<Result<string>> ExecuteAsync(
        PetRunRecord run, Guid actionId, PetRunEffect effect, string? undoReceipt, CancellationToken cancellationToken)
    {
        if (!TryReadPreview(effect, out var itemId, out var preview, out var links))
        {
            return Result.Failure<string>(Error("The saved canvas preview is invalid."));
        }
        if (await AuthorizedCanvasAsync(run, itemId, cancellationToken).ConfigureAwait(false) is null
            || !await CanReadLinksAsync(run, links, cancellationToken)
                .ConfigureAwait(false))
        {
            return Result.Failure<string>(Error("The canvas or one of its links is no longer available."));
        }
        var operation = undoReceipt is null ? "apply" : "undo";
        var payload = JsonNode.Parse(undoReceipt ?? preview.GetRawText());
        var reply = await SendAsync(run, itemId, actionId, operation, undoReceipt is null ? "preview" : "receipt", payload, cancellationToken,
            run.PlanExecution is null ? null : effect.Parameters.GetProperty("revisions").GetString())
            .ConfigureAwait(false);
        return reply.Match(result => Result.Success(result.GetRawText()), Result.Failure<string>);
    }

    private static bool TryReadPreview(
        PetRunEffect effect, out ItemId itemId, out JsonElement preview, out IReadOnlyList<ItemId> links)
    {
        itemId = default;
        preview = default;
        links = [];
        if (effect.Parameters.ValueKind != JsonValueKind.Object
            || !effect.Parameters.TryGetProperty("itemId", out var target)
            || target.ValueKind != JsonValueKind.String || !target.TryGetGuid(out var id)
            || !effect.Parameters.TryGetProperty("preview", out preview)
            || !TryReadLinks(preview, out links))
        {
            return false;
        }
        itemId = new ItemId(id);
        return true;
    }

    private async Task<Item?> AuthorizedCanvasAsync(PetRunRecord run, ItemId itemId, CancellationToken cancellationToken)
    {
        var inSubtree = run.ScopeRootItemId is { } root
            && await tree.IsVisibleSubtreeMemberAsync(run.WorkspaceId, ItemId.From(root), itemId, cancellationToken).ConfigureAwait(false);
        if (run.ReadOnlySourceItemIds?.Contains(itemId.Value) == true
            || run.ScopeRootItemId is not null && !inSubtree
            || itemId != run.ItemId && !run.WorkspaceScope && !inSubtree)
        {
            return null;
        }
        var lookup = await visible.FindAsync(itemId, ItemAccess.Write, cancellationToken).ConfigureAwait(false);
        return lookup.IsSuccess && lookup.Value is { Type: "canvas" } item && item.WorkspaceId == run.WorkspaceId
            && !ItemSettings.Read(item.Settings).WithholdFromPets
            && (await locks.LockedAmongAsync([itemId], cancellationToken).ConfigureAwait(false)).Count == 0
            ? item
            : null;
    }

    private async Task<bool> CanReadLinksAsync(
        PetRunRecord run, IReadOnlyList<ItemId> links, CancellationToken cancellationToken)
    {
        if (links.Count != 0 && (await locks.LockedAmongAsync(links, cancellationToken).ConfigureAwait(false)).Count != 0)
        {
            return false;
        }
        foreach (var link in links)
        {
            if (!run.WorkspaceScope && link != run.ItemId && !run.SourceItemIds.Contains(link.Value)
                && run.ReadOnlySourceItemIds?.Contains(link.Value) != true)
            {
                return false;
            }
            var item = await tree.FindAsync(link, cancellationToken).ConfigureAwait(false);
            if (item?.WorkspaceId != run.WorkspaceId || item.LifecycleState != ItemLifecycleState.Active
                || ItemSettings.Read(item.Settings).WithholdFromPets)
            {
                return false;
            }
        }
        return true;
    }

    private static bool TryReadLinks(JsonElement preview, out IReadOnlyList<ItemId> links)
    {
        var ids = new HashSet<ItemId>();
        links = [];
        if (preview.ValueKind != JsonValueKind.Object || !preview.TryGetProperty("links", out var values)
            || values.ValueKind != JsonValueKind.Array || values.GetArrayLength() > 128)
        {
            return false;
        }
        foreach (var link in values.EnumerateArray())
        {
            if (link.ValueKind != JsonValueKind.String || !link.TryGetGuid(out var id) || id == Guid.Empty)
            {
                return false;
            }
            ids.Add(new ItemId(id));
        }
        links = [.. ids];
        return true;
    }

    private async Task<Result<JsonElement>> SendAsync(
        PetRunRecord run, ItemId itemId, Guid actionId, string operation, string payloadName, JsonNode? payload,
        CancellationToken cancellationToken, string? planRevisions = null)
    {
        var address = configuration["Nix:Pets:WorkerUrl"];
        var secret = configuration["Nix:InternalSecret"];
        if (!tokens.IsConfigured || string.IsNullOrWhiteSpace(secret)
            || !Uri.TryCreate(address, UriKind.Absolute, out var origin)
            || origin.Scheme is not ("http" or "https") || origin.AbsolutePath != "/"
            || origin.UserInfo.Length != 0 || origin.Query.Length != 0 || origin.Fragment.Length != 0)
        {
            return Result.Failure<JsonElement>(Error("Canvas execution is unavailable."));
        }
        var write = operation is "apply" or "undo";
        var binding = PetActionRequestBinding.Create("GET", $"/internal/authz/items/{itemId.Value:D}", body: null);
        var token = run.RequestId is not null ? tokens.MintPetPlanRead(run.ActorId, run.TenantId, run.Id)
            : tokens.MintPetAction(run.ActorId, run.TenantId, actionId, write ? PetTurnMode.Write : PetTurnMode.Read, binding);
        var body = new JsonObject
        {
            ["operation"] = operation,
            ["itemId"] = itemId.Value,
            ["token"] = token,
            [payloadName] = payload,
        };
        if (write)
        {
            body["actionId"] = actionId;
        }
        if (write && run.PlanExecution is not null)
        {
            body["planExecution"] = PetPlanExecution.NativeContext(run, planRevisions ?? "");
        }
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(origin, "/v1/sani/pet-canvas"))
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        request.Headers.Add("X-Nix-Internal-Secret", secret);
        try
        {
            using var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (response.IsSuccessStatusCode)
            {
                var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
                using var json = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
                var root = json.RootElement;
                if (root.ValueKind == JsonValueKind.Object
                    && root.TryGetProperty("ok", out var ok)
                    && ok.ValueKind == JsonValueKind.True && root.TryGetProperty("result", out var result))
                {
                    return Result.Success(result.Clone());
                }
                if (root.ValueKind == JsonValueKind.Object
                    && root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String)
                {
                    var uncertain = root.TryGetProperty("uncertain", out var maybe) && maybe.ValueKind == JsonValueKind.True;
                    if (!uncertain && operation == "apply"
                        && root.TryGetProperty("stale", out var stale) && stale.ValueKind == JsonValueKind.True)
                    {
                        return Result.Failure<JsonElement>(new NixError("pet_runs.canvas_stale", error.GetString()!));
                    }
                    return Result.Failure<JsonElement>(Error(error.GetString()!, uncertain));
                }
            }
        }
        catch (Exception error) when (error is HttpRequestException or System.IO.IOException or JsonException or OperationCanceledException)
        {
            return Result.Failure<JsonElement>(Error("The canvas operation could not be verified.", write));
        }
        return Result.Failure<JsonElement>(Error("The canvas worker could not complete the operation.", write));
    }

    internal async Task<bool> CanReadAsync(PetRunRecord run, ItemId id, CancellationToken cancellationToken)
    {
        // Receipts may become model observations on a later turn. Bind them to a source that
        // the run rechecks each time before it supplies those observations.
        if (id != run.ItemId && !run.SourceItemIds.Contains(id.Value)
            && run.ReadOnlySourceItemIds?.Contains(id.Value) != true)
        {
            return false;
        }
        var lookup = await visible.FindAsync(id, ItemAccess.Read, cancellationToken).ConfigureAwait(false);
        return lookup.IsSuccess && lookup.Value is { Type: "canvas" } item && item.WorkspaceId == run.WorkspaceId
            && !ItemSettings.Read(item.Settings).WithholdFromPets
            && (await locks.LockedAmongAsync([id], cancellationToken).ConfigureAwait(false)).Count == 0;
    }

    internal async Task<Result<string>> ReadElementsAsync(
        PetRunRecord run, ItemId id, Guid actionId, JsonElement query, CancellationToken cancellationToken)
    {
        if (!await CanReadAsync(run, id, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<string>(Error("The canvas source is outside this run's scope."));
        }
        var result = await SendAsync(run, id, actionId, "read", "query", JsonNode.Parse(query.GetRawText()), cancellationToken)
            .ConfigureAwait(false);
        return result.Match(data => Result.Success(data.GetRawText()), Result.Failure<string>);
    }

    private static NixError Error(string message, bool uncertain = false) =>
        new(uncertain ? "pet_runs.outcome_unknown" : "pet_runs.canvas_refused", message);

    private static JsonElement ReadSchema()
    {
        using var document = JsonDocument.Parse("""
            {"type":"object","additionalProperties":false,"properties":{
              "itemId":{"type":"string","format":"uuid"},
              "elements":{"type":"array","items":{"type":"object","required":["id","type"],"properties":{
                "id":{"type":"string"},"type":{"enum":["rectangle","diamond","ellipse","text","line","freedraw","arrow"]},
                "x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number"},"height":{"type":"number"},
                "nixItemId":{"type":["string","null"],"format":"uuid"},"text":{"type":"string"},
                "containerId":{"type":"string"},"fontSize":{"type":"number"},"from":{"type":"string"},"to":{"type":"string"},
                "groupIds":{"type":"array","items":{"type":"string"}},
                "points":{"type":"array","items":{"type":"array","items":{"type":"number"},"minItems":2,"maxItems":2}},
                "via":{"type":"array","items":{"type":"array","items":{"type":"number"},"minItems":2,"maxItems":2}},
                "style":{"type":"object"}}}},
              "remove":{"type":"array","items":{"type":"string"}}}}
            """);
        return document.RootElement.Clone();
    }
}

[SuppressMessage("Performance", "CA1812", Justification = "Created by the scoped capability registry.")]
internal sealed class PetCanvasReadCapability(PetCanvasCapability canvas) : IPetRunCapability
{
    public string Name => "canvas.read";
    public string Description => "Read editable element IDs and geometry from the current canvas or a selected canvas source. "
        + "Arguments are itemId (optional UUID), after (cursor from the previous result), and limit (1 to 4).";
    public bool RequiresApproval(PetRunEffect effect) => false;
    public string? ModelObservation(PetRunEffect effect, string receipt) => receipt;

    public Task<bool> CanObserveAsync(
        PetRunRecord run, PetRunEffect effect, string receipt, CancellationToken cancellationToken) =>
        canvas.CanReadAsync(run, new ItemId(effect.Parameters.GetProperty("itemId").GetGuid()), cancellationToken);

    public async Task<Result<PetRunEffect>> PreviewAsync(
        PetRunRecord run, JsonElement args, CancellationToken cancellationToken)
    {
        if (args.ValueKind != JsonValueKind.Object)
        {
            return Result.Failure<PetRunEffect>(new NixError("pet_runs.canvas_refused", "Provide a canvas source."));
        }
        var query = JsonNode.Parse(args.GetRawText())!.AsObject();
        var id = run.ItemId?.Value;
        if (args.TryGetProperty("itemId", out var target))
        {
            if (target.ValueKind != JsonValueKind.String || !target.TryGetGuid(out var selected))
            {
                return Result.Failure<PetRunEffect>(new NixError("pet_runs.canvas_refused", "Choose a valid canvas source."));
            }
            id = selected;
        }
        query.Remove("itemId");
        if (id is not { } rawId || !await canvas.CanReadAsync(run, new ItemId(rawId), cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<PetRunEffect>(new NixError("pet_runs.canvas_refused", "Select the canvas as a source for this run."));
        }
        var parameters = new JsonObject { ["itemId"] = id, ["query"] = query };
        return Result.Success(new PetRunEffect("Read canvas elements",
            JsonSerializer.SerializeToElement(parameters, PetCanvasJsonContext.Default.JsonObject)));
    }

    public Task<Result<string>> ApplyAsync(
        PetRunRecord run, Guid actionId, PetRunEffect effect, CancellationToken cancellationToken) =>
        canvas.ReadElementsAsync(run, new ItemId(effect.Parameters.GetProperty("itemId").GetGuid()), actionId,
            effect.Parameters.GetProperty("query"), cancellationToken);
}

[System.Text.Json.Serialization.JsonSerializable(typeof(JsonObject))]
internal sealed partial class PetCanvasJsonContext : System.Text.Json.Serialization.JsonSerializerContext;
