using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Mime;
using System.Text;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Abstractions.Automations;
using Nix.Abstractions.PetRuns;
using Nix.Abstractions.Templates;
using Nix.Authentication;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Features.Items;
using Nix.Workers;

namespace Nix.Features.PetRuns;

/// <summary>Resolves named Nix actions in the current run scope and dispatches the verified preview.</summary>
internal sealed class NixActionPetCapability(
    EndpointDataSource endpoints,
    IItemTree tree,
    IItemLocks locks,
    IPermissionResolver permissions,
    ISiteStore sites,
    IAutomationRuleStore rules,
    ITemplateCatalogStore templates,
    ItemBodyClient notes,
    SelfIssuedTokenService credentials,
    WorkerLoopbackClient loopback,
    IHttpClientFactory clients) : IPetRunCapability
{
    internal static void Register(IServiceCollection services) => services.AddScoped<IPetRunCapability>(provider => new NixActionPetCapability(
        provider.GetRequiredService<EndpointDataSource>(), provider.GetRequiredService<IItemTree>(),
        provider.GetRequiredService<IItemLocks>(), provider.GetRequiredService<IPermissionResolver>(), provider.GetRequiredService<ISiteStore>(),
        provider.GetRequiredService<IAutomationRuleStore>(), provider.GetRequiredService<ITemplateCatalogStore>(),
        provider.GetRequiredService<ItemBodyClient>(), provider.GetRequiredService<SelfIssuedTokenService>(),
        provider.GetRequiredService<WorkerLoopbackClient>(), provider.GetRequiredService<IHttpClientFactory>()));

    internal const string TargetTextRequiredCode = "pet_runs.target_text_required";

    public string Name => "nix.action";
    public string Description => "Read or propose a named Nix API operation using operationId, path, query and body. "
        + "Read examples: GetItem, GetItemBody, SearchPassages, ListItems. Reviewed writes: "
        + string.Join(", ", PetCapabilities.FencedWrites) + ". "
        + """Append preserves existing note blocks without reading their text. Example: {"operationId":"AppendItemBody","path":{"itemId":"the target item UUID"},"body":{"markdown":"\n- [ ] New item\n"}}. """
        + "GetItemBody returns note body text. If the target note text is not shared and you need it, ask to share that current note as a source.";
    public JsonElement? InputSchema => Schema;

    private static readonly JsonElement Schema = JsonDocument.Parse("""
        {"type":"object","required":["operationId"],"additionalProperties":false,"properties":{
          "operationId":{"type":"string"},"path":{"type":"object"},"query":{"type":"object"},"body":{"type":"object"}
        }}
        """).RootElement.Clone();

    private static readonly HashSet<string> ItemParameters = new(StringComparer.OrdinalIgnoreCase)
    {
        "itemId", "itemIds", "parentId", "parentItemId", "afterId", "containerItemId", "sourceItemId",
        "sourceItemIds", "rootItemId", "targetItemId", "rootId", "subtreeRootId", "successorId",
        "targetParentId", "destinationParentId", "targetParentItemId", "fileItemId", "existingItemId",
        "holderItemId", "documentItemId",
    };
    private static readonly HashSet<string> WorkspaceParameters = new(StringComparer.OrdinalIgnoreCase)
    { "workspaceId", "workspaceIds", "sourceWorkspaceIds", "targetWorkspaceId", "destinationWorkspaceId" };


    public bool RequiresApproval(PetRunEffect effect) =>
        !effect.Parameters.TryGetProperty("operationId", out var id)
        || id.ValueKind != JsonValueKind.String
        || PetCapabilities.Find(id.GetString()!)?.Mode != "read";

    public string? ModelObservation(PetRunEffect effect, string receipt) => RequiresApproval(effect) ? null : receipt;

    public async Task<bool> CanObserveAsync(
        PetRunRecord run, PetRunEffect effect, string receipt, CancellationToken cancellationToken)
    {
        if (RequiresApproval(effect))
        {
            return false;
        }
        try
        {
            var request = PetCoreRequest.Parse(effect.Parameters.GetProperty("inputs"), endpoints);
            var revisions = await ResolveAsync(run, request, cancellationToken).ConfigureAwait(false);
            if (revisions != effect.Parameters.GetProperty("revisions").GetString())
            {
                return false;
            }
            if (request.Definition.Id == "GetItemBody")
            {
                return true;
            }

            var newline = receipt.IndexOf('\n', StringComparison.Ordinal);
            if (newline < 0 || receipt.Length - newline > 24_100)
            {
                return false;
            }
            using var result = JsonDocument.Parse(receipt[(newline + 1)..]);
            return await CanObserveResultAsync(run, request, result.RootElement, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is InvalidPetActionException or JsonException)
        {
            return false;
        }
    }

    public async Task<string?> RevisionObservationAsync(PetRunRecord run, PetRunEffect effect, CancellationToken cancellationToken)
    {
        try
        {
            var request = PetCoreRequest.Parse(effect.Parameters.GetProperty("inputs"), endpoints);
            if (!IsNoteWrite(request) || request.Body is null
                || !await permissions.CanWriteWorkspaceAsync(run.WorkspaceId, cancellationToken).ConfigureAwait(false))
            {
                return null;
            }
            await ResolveAsync(run, request, cancellationToken).ConfigureAwait(false);
            using var body = JsonDocument.Parse(request.Body);
            return body.RootElement.GetProperty("markdown").GetString();
        }
        catch (Exception exception) when (exception is InvalidPetActionException or JsonException)
        {
            return null;
        }
    }

    public async Task<Result<PetRunEffect>> PreviewAsync(PetRunRecord run, JsonElement args, CancellationToken cancellationToken)
    {
        try
        {
            var request = PetCoreRequest.Parse(args, endpoints);
            var revisions = await ResolveAsync(run, request, cancellationToken).ConfigureAwait(false);
            ItemBodyRevision? note = null;
            if (IsNoteWrite(request))
            {
                var item = NoteId(request);
                var current = await notes.ReadWithRevisionAsync(item, NoteToken(run, item, run.Id, PetTurnMode.Read), cancellationToken).ConfigureAwait(false);
                if (current.IsFailure || current.Value.Revision is null)
                {
                    throw new InvalidPetActionException("Nix could not read the exact note revision.");
                }
                if (request.Definition.Id == "ReplaceItemBody" && current.Value.Losses.Count > 0)
                {
                    throw new InvalidPetActionException("Replacing this note as Markdown would remove its rich formatting. Append to it or edit it in Nix.");
                }
                note = current.Value.Revision;
            }
            var preview = JsonSerializer.SerializeToElement(new
            {
                operationId = request.Definition.Id,
                method = request.Definition.Method,
                target = request.Target,
                inputs = args,
                revisions,
                documentId = note?.DocumentId,
                headSeq = note?.HeadSeq,
            });
            return Result.Success(new PetRunEffect(
                $"Run {request.Definition.Id} in the selected Nix scope.", preview));
        }
        catch (InvalidPetActionException exception)
        {
            return Result.Failure<PetRunEffect>(exception.Error);
        }
    }

    public async Task<Result<string>> ApplyAsync(PetRunRecord run, Guid actionId, PetRunEffect effect, CancellationToken cancellationToken)
    {
        try
        {
            var request = PetCoreRequest.Parse(effect.Parameters.GetProperty("inputs"), endpoints);
            var revisions = await ResolveAsync(run, request, cancellationToken).ConfigureAwait(false);
            if (revisions != effect.Parameters.GetProperty("revisions").GetString()
                || request.Target != effect.Parameters.GetProperty("target").GetString()
                || request.Definition.Method != effect.Parameters.GetProperty("method").GetString())
            {
                return Result.Failure<string>(new NixError("pet_runs.stale_review", "The target changed. Review a new preview."));
            }

            if (request.Definition.Id == "GetItemBody" || IsNoteWrite(request))
            {
                return await ApplyNoteAsync(run, actionId, request, effect.Parameters, cancellationToken).ConfigureAwait(false);
            }
            return await ExecuteAsync(run, actionId, request, revisions, cancellationToken).ConfigureAwait(false);
        }
        catch (InvalidPetActionException exception)
        {
            return Result.Failure<string>(exception.Error);
        }
    }

    private async Task<string> ResolveAsync(PetRunRecord run, PetCoreRequest request, CancellationToken cancellationToken)
    {
        if (!await permissions.CanReadWorkspaceAsync(run.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidPetActionException("The run's workspace is unavailable.");
        }
        if (run.IncludeTargetText is not null && request.Definition.Id == "GetConversationMessages")
        {
            throw new InvalidPetActionException("Conversation history is outside the selected job scope.");
        }
        if (run.IncludeTargetText == false && request.Definition.Id is "SearchPassages" or "GetPassages")
        {
            throw new InvalidPetActionException("This operation searches note text across items. Read a selected source or use item metadata instead.");
        }
        var read = request.Definition.Mode == "read";
        var scopedWorkspace = false;
        var itemIds = new HashSet<Guid>();
        foreach (var (key, value) in request.References)
        {
            if (ItemParameters.Contains(key))
            {
                itemIds.Add(Id(value));
            }
            else if (WorkspaceParameters.Contains(key))
            {
                if (Id(value) != run.WorkspaceId.Value)
                {
                    throw new InvalidPetActionException("The action names a workspace outside this run.");
                }
                scopedWorkspace = true;
            }
        }

        scopedWorkspace |= await ResolveSecondaryAsync(run, request, itemIds, cancellationToken).ConfigureAwait(false);
        if (itemIds.Count == 0 && (!scopedWorkspace || !run.WorkspaceScope))
        {
            throw new InvalidPetActionException("The action needs a target item or an explicitly selected workspace.");
        }
        if (request.Definition.Mode != "read" && itemIds.Count == 0)
        {
            throw new InvalidPetActionException("This action has no verified revision for its complete effect. Choose an available pet action or make the change in Nix.");
        }
        var versions = new List<string>();
        foreach (var raw in itemIds.Order())
        {
            var id = ItemId.From(raw);
            var item = request.Definition.Id == "RestoreItem"
                ? await tree.FindStoredAsync(id, cancellationToken).ConfigureAwait(false)
                : await tree.FindAsync(id, cancellationToken).ConfigureAwait(false);
            if (item is null || item.WorkspaceId != run.WorkspaceId || ItemSettings.Read(item.Settings).WithholdFromPets
                || (!read && run.ReadOnlySourceItemIds?.Contains(raw) == true)
                || (!run.WorkspaceScope && run.ItemId != id && !run.SourceItemIds.Contains(raw)
                    && run.ReadOnlySourceItemIds?.Contains(raw) != true)
                || (await locks.GetStateAsync(id, cancellationToken).ConfigureAwait(false)).Locked)
            {
                throw new InvalidPetActionException("An item is locked, unavailable, or outside the selected job scope.");
            }
            if (id == run.ItemId && run.IncludeTargetText == false
                && (request.Definition.Id == "GetItemBody"
                    || item.Type == "note" && request.Definition.Id == "ListComments"))
            {
                throw new InvalidPetActionException(item.Type == "note" ? TargetTextRequiredCode : "pet_runs.invalid_action",
                    "The job has not been granted text from its target note.");
            }
            if (await tree.ReadPetRevisionAsync(run.WorkspaceId, id, pin: false, cancellationToken).ConfigureAwait(false) is not { } revision)
            {
                throw new InvalidPetActionException("Nix could not read an affected item's revision.");
            }
            versions.Add(string.Create(CultureInfo.InvariantCulture, $"{raw:D}:{revision}"));
        }
        var revisions = versions.Count == 0 ? string.Empty : $"{run.WorkspaceId.Value:D}|{string.Join(',', versions)}";
        if (revisions.Length > PetActionRequestBinding.MaximumRevisionsLength)
        {
            throw new InvalidPetActionException("Choose a smaller set of items for one approved action.");
        }
        return revisions;
    }

    private async Task<bool> ResolveSecondaryAsync(
        PetRunRecord run,
        PetCoreRequest request,
        HashSet<Guid> itemIds,
        CancellationToken cancellationToken)
    {
        var scoped = false;
        foreach (var (key, value) in request.References.Distinct())
        {
            switch (key)
            {
                case "siteId" when request.Definition.Path!.Contains("{siteId}", StringComparison.Ordinal):
                    var site = await sites.FindAsync(Id(value), cancellationToken).ConfigureAwait(false);
                    if (site is null || site.WorkspaceId != run.WorkspaceId)
                    {
                        throw new InvalidPetActionException("The site is outside this run's workspace.");
                    }
                    itemIds.Add(site.RootItemId.Value);
                    scoped = true;
                    break;
                case "ruleId" when request.Definition.Path!.Contains("{ruleId}", StringComparison.Ordinal):
                    var rule = await rules.GetAsync(Id(value), cancellationToken).ConfigureAwait(false);
                    if (rule is null || rule.WorkspaceId != run.WorkspaceId)
                    {
                        throw new InvalidPetActionException("The rule is outside this run's workspace.");
                    }
                    scoped = true;
                    break;
                case "templateId" when request.Definition.Path!.Contains("{templateId}", StringComparison.Ordinal):
                    var template = await templates.DetailAsync(TemplateId.From(Id(value)), cancellationToken).ConfigureAwait(false);
                    if (template.IsFailure || template.Value.Template.WorkspaceId != run.WorkspaceId)
                    {
                        throw new InvalidPetActionException("The template is outside this run's workspace.");
                    }
                    scoped = true;
                    break;
            }
        }
        return scoped;
    }

    private async Task<Result<string>> ExecuteAsync(
        PetRunRecord run,
        Guid actionId,
        PetCoreRequest request,
        string revisions,
        CancellationToken cancellationToken)
    {
        var method = request.Definition.Method!;
        var address = loopback.PetActionAddress(request.Target);
        var body = request.Body;
        var binding = PetActionRequestBinding.Create(method, address.PathAndQuery, body, revisions);
        var bearer = credentials.MintPetAction(run.ActorId, run.TenantId, actionId, request.TurnMode, binding);
        using var outgoing = new HttpRequestMessage(new HttpMethod(method), address);
        outgoing.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        if (revisions.Length > 0)
        {
            outgoing.Headers.TryAddWithoutValidation(PetActionRequestBinding.RevisionsHeader, revisions);
        }
        if (body is not null)
        {
            outgoing.Content = new StringContent(body, Encoding.UTF8, MediaTypeNames.Application.Json);
        }
        using var client = clients.CreateClient(WorkerLoopbackClient.HttpClientName);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(45));
        try
        {
            using var response = await client.SendAsync(outgoing, HttpCompletionOption.ResponseHeadersRead, deadline.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return Result.Failure<string>(response.StatusCode switch
                {
                    HttpStatusCode.Conflict => new NixError("pet_runs.stale_review", "Core could not apply the reviewed revision."),
                    _ when (int)response.StatusCode >= 500 => new NixError("pet_runs.outcome_uncertain", "Core could not confirm the action's result. Check the target before retrying."),
                    _ => new NixError("pet_runs.action_refused", $"Core declined the action ({(int)response.StatusCode})."),
                });
            }
            return await ReceiptAsync(run, request, response, deadline.Token).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is HttpRequestException or IOException or JsonException
            || exception is OperationCanceledException && !cancellationToken.IsCancellationRequested)
        {
            return Result.Failure<string>(new NixError("pet_runs.outcome_uncertain", "The action's result could not be verified. Check the target before retrying."));
        }
    }

    private async Task<Result<string>> ApplyNoteAsync(PetRunRecord run, Guid actionId, PetCoreRequest request, JsonElement approved, CancellationToken cancellationToken)
    {
        var item = NoteId(request);
        if (!IsNoteWrite(request))
        {
            var read = await notes.ReadAsync(item, NoteToken(run, item, actionId, PetTurnMode.Read), cancellationToken).ConfigureAwait(false);
            return read.IsSuccess
                ? Result.Success(read.Value.Markdown.Length <= 24_000 ? read.Value.Markdown : read.Value.Markdown[..24_000] + "\n[Truncated]")
                : Result.Failure<string>(read.Error);
        }
        if (!approved.GetProperty("documentId").TryGetGuid(out var doc)
            || approved.GetProperty("headSeq").GetString() is not { } seq || request.Body is null)
        {
            throw new InvalidPetActionException("The note write has no reviewed revision or content.");
        }
        using var body = JsonDocument.Parse(request.Body);
        if (!body.RootElement.TryGetProperty("markdown", out var markdown) || markdown.ValueKind != JsonValueKind.String)
        {
            throw new InvalidPetActionException("A note write needs Markdown text.");
        }
        var result = await notes.WriteWithRevisionAsync(item, markdown.GetString()!,
            request.Definition.Id == "AppendItemBody", NoteToken(run, item, actionId, PetTurnMode.Write),
            new ItemBodyRevision(doc, seq), cancellationToken).ConfigureAwait(false);
        return result.IsSuccess
            ? Result.Success($"Core saved the note at revision {result.Value.Seq}.")
            : result.Error.Code == "items.body_unavailable"
                ? Result.Failure<string>(new NixError("pet_runs.outcome_uncertain", "The note write could not be confirmed. Check the note before retrying."))
                : Result.Failure<string>(result.Error);
    }

    private string NoteToken(PetRunRecord run, Guid item, Guid actionId, PetTurnMode mode) =>
        credentials.MintPetAction(run.ActorId, run.TenantId, actionId, mode,
            PetActionRequestBinding.Create("GET", $"/internal/authz/items/{item:D}", null));

    private static Guid NoteId(PetCoreRequest request) =>
        Id(request.References.First(pair => pair.Key == "itemId").Value);

    private static bool IsNoteWrite(PetCoreRequest request) =>
        request.Definition.Id is "ReplaceItemBody" or "AppendItemBody";

    private async Task<Result<string>> ReceiptAsync(
        PetRunRecord run,
        PetCoreRequest request,
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        const int capacity = 24_000;
        var summary = $"Core completed {request.Definition.Id} ({(int)response.StatusCode}).";
        if (request.Definition.Mode != "read" || response.StatusCode == HttpStatusCode.NoContent
            || response.Content.Headers.ContentType?.MediaType != MediaTypeNames.Application.Json)
        {
            return Result.Success(summary);
        }
        var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        await using (stream.ConfigureAwait(false))
        {
            var buffer = new byte[capacity + 1]; // byte[]: bounded JSON parse of one action receipt
            var read = await stream.ReadAtLeastAsync(buffer, buffer.Length, throwOnEndOfStream: false, cancellationToken).ConfigureAwait(false);
            if (read > capacity)
            {
                return Result.Success(summary + " Use a smaller query to inspect its result.");
            }
            using var result = JsonDocument.Parse(buffer.AsMemory(0, read));
            return await CanObserveResultAsync(run, request, result.RootElement, cancellationToken).ConfigureAwait(false)
                ? Result.Success(summary + "\n" + result.RootElement.GetRawText())
                : Result.Success(summary + " Some results could not be shown in the selected scope.");
        }
    }

    private async Task<bool> CanObserveResultAsync(
        PetRunRecord run, PetCoreRequest request, JsonElement result, CancellationToken cancellationToken)
    {
        // Aggregates and facets can carry protected values without returning the contributing IDs.
        if (ContainsCredential(result)
            || (request.Definition.Id is "AggregateWorkspaceQuery" or "RunWorkspaceQuery" or "RunItemQuery" or "RunItemChart"
                or "GetSiteBuild" or "GetTemplateItem" or "PreviewTemplateCapture" or "GetWorkspaceSyncSnapshot"
                && (!run.WorkspaceScope || await tree.AnyItemsWithheldFromPetsAsync(run.WorkspaceId, cancellationToken).ConfigureAwait(false)
                    || await locks.AnyInWorkspaceAsync(run.WorkspaceId, cancellationToken).ConfigureAwait(false))))
        {
            return false;
        }

        var references = ItemResultReferences(result).Distinct().Take(129).ToArray();
        if (references.Length > 128
            || (await locks.LockedAmongAsync(references.Select(ItemId.From).ToArray(), cancellationToken).ConfigureAwait(false)).Count != 0)
        {
            return false;
        }
        foreach (var reference in references)
        {
            var source = await tree.FindStoredAsync(ItemId.From(reference), cancellationToken).ConfigureAwait(false);
            if (source is not null && (source.WorkspaceId != run.WorkspaceId || ItemSettings.Read(source.Settings).WithholdFromPets
                || !run.WorkspaceScope && source.Id != run.ItemId && !run.SourceItemIds.Contains(reference)
                    && run.ReadOnlySourceItemIds?.Contains(reference) != true))
            {
                return false;
            }
        }
        return true;
    }

    private static bool ContainsCredential(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => value.EnumerateObject().Any(property =>
            property.Name.EndsWith("Token", StringComparison.OrdinalIgnoreCase)
            || property.Name.EndsWith("Secret", StringComparison.OrdinalIgnoreCase)
            || property.Name.EndsWith("Password", StringComparison.OrdinalIgnoreCase)
            || property.Name.EndsWith("DownloadUrl", StringComparison.OrdinalIgnoreCase)
            || property.Name.EndsWith("UploadUrl", StringComparison.OrdinalIgnoreCase)
            || ContainsCredential(property.Value)),
        JsonValueKind.Array => value.EnumerateArray().Any(ContainsCredential),
        _ => false,
    };

    private static IEnumerable<Guid> ItemResultReferences(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                if (ItemParameters.Contains(property.Name) || property.NameEquals("id")
                    || property.NameEquals("sourceId") || property.NameEquals("targetId"))
                {
                    if (property.Value.ValueKind == JsonValueKind.String && property.Value.TryGetGuid(out var id))
                    {
                        yield return id;
                    }
                    if (property.Value.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var entry in property.Value.EnumerateArray())
                        {
                            if (entry.ValueKind == JsonValueKind.String && entry.TryGetGuid(out var elementId))
                            {
                                yield return elementId;
                            }
                        }
                    }
                }
                foreach (var nested in ItemResultReferences(property.Value))
                {
                    yield return nested;
                }
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in value.EnumerateArray())
            {
                foreach (var nested in ItemResultReferences(element))
                {
                    yield return nested;
                }
            }
        }
    }

    private static Guid Id(string value) => Guid.TryParseExact(value, "D", out var id) && id != Guid.Empty
        ? id : throw new InvalidPetActionException("The action's target identifier is invalid.");
}
