using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Primitives;

namespace Nix.Features.PetRuns;

[SuppressMessage("Performance", "CA1812", Justification = "Activated through IPetRunCapability registrations.")]
internal sealed class PetBrowserSearch(PetBrowserClient browser) : IPetRunCapability
{
    public string Name => "browser.search";
    public string Description => "Search the public web and return source links after review of the exact query.";
    public JsonElement? InputSchema => BrowserCapabilityJson.SearchSchema;

    public Task<Result<PetRunEffect>> PreviewAsync(PetRunRecord run, JsonElement args, CancellationToken cancellationToken)
    {
        var search = BrowserCapabilityJson.Parse(args, PetBrowserJson.Default.BrowserSearchInput);
        var query = search?.Query?.Trim();
        var result = query is { Length: > 0 and <= 512 } && !query.Any(char.IsControl)
            ? Result.Success(new PetRunEffect("Search the public web for " + query,
                JsonSerializer.SerializeToElement(new BrowserSearchInput(query), PetBrowserJson.Default.BrowserSearchInput)))
            : Result.Failure<PetRunEffect>(PetBrowserErrors.Invalid());
        return Task.FromResult(result);
    }

    public async Task<Result<string>> ApplyAsync(PetRunRecord run, Guid actionId, PetRunEffect effect,
        CancellationToken cancellationToken)
    {
        var search = BrowserCapabilityJson.Parse(effect.Parameters, PetBrowserJson.Default.BrowserSearchInput);
        if (search?.Query is not { Length: > 0 and <= 512 } query)
        {
            return Result.Failure<string>(PetBrowserErrors.Invalid());
        }

        var result = await browser.SendAsync(new BrowserWorkerCommand("search", Query: query), cancellationToken)
            .ConfigureAwait(false);
        return BrowserCapabilityJson.Receipt(result);
    }

    public string? ModelObservation(PetRunEffect effect, string receipt) =>
        BrowserCapabilityJson.Summary(BrowserCapabilityJson.Parse(receipt, PetBrowserJson.Default.JsonElement),
            includeText: false);
}

[SuppressMessage("Performance", "CA1812", Justification = "Activated through IPetRunCapability registrations.")]
internal sealed class PetBrowserBrowse(PetBrowserClient browser) : IPetRunCapability
{
    public string Name => "browser.browse";
    public string Description => "Read a reviewed web page and discover supported forms and links. Set useSiteSession only when the job calls for the registered session for this exact HTTPS site.";
    public JsonElement? InputSchema => BrowserCapabilityJson.BrowseSchema;

    public async Task<Result<PetRunEffect>> PreviewAsync(PetRunRecord run, JsonElement args, CancellationToken cancellationToken)
    {
        var input = BrowserCapabilityJson.Parse(args, PetBrowserJson.Default.BrowserBrowseInput);
        if (input is null)
        {
            return Result.Failure<PetRunEffect>(PetBrowserErrors.Invalid());
        }

        var visit = await browser.VisitAsync(run, input, cancellationToken).ConfigureAwait(false);
        return visit.IsSuccess
            ? Result.Success(new PetRunEffect("Open the web page at " + visit.Value.Url,
                JsonSerializer.SerializeToElement(visit.Value, PetBrowserJson.Default.BrowserVisit)))
            : Result.Failure<PetRunEffect>(visit.Error);
    }

    public async Task<Result<string>> ApplyAsync(PetRunRecord run, Guid actionId, PetRunEffect effect,
        CancellationToken cancellationToken)
    {
        var visit = BrowserCapabilityJson.Parse(effect.Parameters, PetBrowserJson.Default.BrowserVisit);
        if (visit is null)
        {
            return Result.Failure<string>(PetBrowserErrors.Invalid());
        }

        var session = await browser.SessionAsync(run, visit, Name, cancellationToken).ConfigureAwait(false);
        if (session.IsFailure)
        {
            return Result.Failure<string>(session.Error);
        }

        var page = await browser.SendAsync(new BrowserWorkerCommand("browse", Url: visit.Url, Session: session.Value),
            cancellationToken).ConfigureAwait(false);
        return page.IsFailure
            ? Result.Failure<string>(page.Error)
            : Result.Success(JsonSerializer.Serialize(new BrowserBrowseReceipt(actionId, visit, page.Value),
                PetBrowserJson.Default.BrowserBrowseReceipt));
    }

    public string? ModelObservation(PetRunEffect effect, string receipt)
    {
        var page = BoundReceipt(effect, receipt);
        if (page is null)
        {
            return null;
        }

        return FormattableString.Invariant($"Browse action {page.ActionId}. ")
            + BrowserCapabilityJson.Summary(page.Page, includeText: true);
    }

    public async Task<bool> CanObserveAsync(PetRunRecord run, PetRunEffect effect, string receipt,
        CancellationToken cancellationToken)
    {
        var page = BoundReceipt(effect, receipt);
        return page is not null
            && (await browser.SessionAsync(run, page.Visit, Name, cancellationToken).ConfigureAwait(false)).IsSuccess;
    }

    private static BrowserBrowseReceipt? BoundReceipt(PetRunEffect effect, string receipt)
    {
        var visit = BrowserCapabilityJson.Parse(effect.Parameters, PetBrowserJson.Default.BrowserVisit);
        var page = BrowserCapabilityJson.Parse(receipt, PetBrowserJson.Default.BrowserBrowseReceipt);
        if (page is null || page.ActionId == Guid.Empty || visit is null || page.Visit != visit
            || !PetBrowserClient.TryWebUri(visit.Url, out var requested)
            || !BrowserCapabilityJson.Property(page.Page, "citation", out var citation)
            || citation.ValueKind != JsonValueKind.String
            || !PetBrowserClient.TryWebUri(citation.GetString(), out var final)
            || (visit.ConnectionId is not null
                && requested.GetLeftPart(UriPartial.Authority) != final.GetLeftPart(UriPartial.Authority)))
        {
            return null;
        }
        return page;
    }
}

[SuppressMessage("Performance", "CA1812", Justification = "Activated through IPetRunCapability registrations.")]
internal sealed class PetBrowserSubmitForm(PetBrowserClient browser) : IPetRunCapability
{
    public string Name => "browser.submitForm";
    public string Description => "Propose submitting a supported form from a reviewed browse action. Ask for help when the website needs takeover.";
    public JsonElement? InputSchema => BrowserCapabilityJson.FormSchema;

    public async Task<Result<PetRunEffect>> PreviewAsync(PetRunRecord run, JsonElement args, CancellationToken cancellationToken)
    {
        var input = BrowserCapabilityJson.Parse(args, PetBrowserJson.Default.BrowserFormInput);
        if (input?.Fields is not { } fields || fields.Length > 40 || input.FormIndex is < 0 or > 19)
        {
            return Result.Failure<PetRunEffect>(PetBrowserErrors.Invalid());
        }
        // Preview reads only the earlier approved browse receipt; model-supplied URLs cannot trigger I/O here.
        var prior = FindBrowse(run, input.BrowseActionId);
        if (prior is null || !BrowserCapabilityJson.Property(prior.Page, "forms", out var list)
            || !BrowserCapabilityJson.Property(prior.Page, "citation", out var citation)
            || citation.ValueKind != JsonValueKind.String || !PetBrowserClient.TryWebUri(citation.GetString(), out var pageUrl)
            || BrowserCapabilityJson.Parse(list, PetBrowserJson.Default.BrowserFormDescriptorArray)
                ?.SingleOrDefault(form => form.Index == input.FormIndex && form.Supported) is not
                { Target: { } targetUrl, Fields: { } controls, Revision: { Length: 64 } revision } form
            || !PetBrowserClient.TryWebUri(targetUrl, out var target)
            || target.Scheme != "https"
            || target.GetLeftPart(UriPartial.Authority) != pageUrl.GetLeftPart(UriPartial.Authority))
        {
            return Result.Failure<PetRunEffect>(PetBrowserErrors.Stale());
        }

        var session = await browser.SessionAsync(run, prior.Visit, Name, cancellationToken).ConfigureAwait(false);
        if (session.IsFailure)
        {
            return Result.Failure<PetRunEffect>(session.Error);
        }

        var attachments = await browser.AttachmentsAsync(run, input.Attachments ?? [], cancellationToken).ConfigureAwait(false);
        if (attachments.IsFailure)
        {
            return Result.Failure<PetRunEffect>(attachments.Error);
        }
        var metadata = attachments.Value.Select(attachment => attachment.Metadata).ToArray();
        if (!ValidControls(fields, metadata, controls, form.Enctype))
        {
            return Result.Failure<PetRunEffect>(PetBrowserErrors.Invalid());
        }

        var proposal = new BrowserFormProposal(pageUrl.AbsoluteUri, target.AbsoluteUri, "POST",
            input.FormIndex, fields, metadata, revision);
        var submission = new BrowserSubmission(prior.Visit, proposal, [.. attachments.Value.Select(attachment => attachment.Input)]);
        return Result.Success(new PetRunEffect("Submit the reviewed form to " + target.AbsoluteUri,
            JsonSerializer.SerializeToElement(submission, PetBrowserJson.Default.BrowserSubmission)));
    }

    public async Task<Result<string>> ApplyAsync(PetRunRecord run, Guid actionId, PetRunEffect effect,
        CancellationToken cancellationToken)
    {
        var submission = BrowserCapabilityJson.Parse(effect.Parameters, PetBrowserJson.Default.BrowserSubmission);
        if (submission is null)
        {
            return Result.Failure<string>(PetBrowserErrors.Invalid());
        }

        var session = await browser.SessionAsync(run, submission.Visit, Name, cancellationToken).ConfigureAwait(false);
        if (session.IsFailure)
        {
            return Result.Failure<string>(session.Error);
        }

        var attachments = await browser.AttachmentsAsync(run, submission.Sources, cancellationToken).ConfigureAwait(false);
        if (attachments.IsFailure || !attachments.Value.Select(file => file.Metadata).SequenceEqual(submission.Proposal.Attachments))
        {
            return Result.Failure<string>(PetBrowserErrors.Attachments());
        }

        var result = await browser.SendAsync(new BrowserWorkerCommand("submit", Session: session.Value,
            ActionId: actionId, Proposal: submission.Proposal, Attachments: [.. attachments.Value.Select(browser.Grant)]),
            cancellationToken).ConfigureAwait(false);
        if (result.IsFailure)
        {
            return Result.Failure<string>(result.Error);
        }
        if (!BrowserCapabilityJson.Property(result.Value, "status", out var status) || !status.TryGetInt32(out var code))
        {
            return Result.Failure<string>(PetBrowserErrors.Unknown());
        }
        return code is >= 200 and < 400
            ? Result.Success(FormattableString.Invariant($"The reviewed website replied with HTTP {code}."))
            : Result.Failure<string>(PetBrowserErrors.Unknown());
    }

    private static BrowserBrowseReceipt? FindBrowse(PetRunRecord run, Guid id)
    {
        var state = BrowserCapabilityJson.Parse(run.State, PetRunJsonContext.Default.PetRunCheckpoint);
        var proposal = state?.Proposals.SingleOrDefault(candidate => candidate.Id == id
            && candidate.Capability == "browser.browse" && candidate.Status == "applied");
        var receipt = BrowserCapabilityJson.Parse(proposal?.Receipt, PetBrowserJson.Default.BrowserBrowseReceipt);
        return receipt?.ActionId == id ? receipt : null;
    }

    private static bool ValidControls(BrowserField[] fields, BrowserAttachment[] files, BrowserControl[] controls, string? enctype)
    {
        if (fields.Any(field => field is null || !PetBrowserClient.ValidField(field.Name)
            || field.Value is null || field.Value.Length > 8192)
            || fields.Sum(field => field.Value.Length) > 10_000
            || fields.Select(field => field.Name).Distinct(StringComparer.Ordinal).Count() != fields.Length
            || (files.Length != 0 && enctype != "multipart/form-data"))
        {
            return false;
        }

        foreach (var field in fields)
        {
            var control = controls.SingleOrDefault(entry => entry.Name == field.Name);
            if (control is null || control.Kind == "file"
                || (control.Required && string.IsNullOrWhiteSpace(field.Value))
                || (control.Kind == "select" && !(control.Options?.Contains(field.Value, StringComparer.Ordinal) ?? false)))
            {
                return false;
            }
        }

        return files.All(file => controls.Any(control => control.Kind == "file" && control.Name == file.Field))
            && controls.Where(control => control.Required).All(control => control.Kind == "file"
                ? files.Any(file => file.Field == control.Name) : fields.Any(field => field.Name == control.Name));
    }
}

internal static class BrowserCapabilityJson
{
    internal static readonly JsonElement SearchSchema = Json("""
        {"type":"object","required":["query"],"properties":{"query":{"type":"string","maxLength":512}},"additionalProperties":false}
        """);

    internal static readonly JsonElement BrowseSchema = Json("""
        {"type":"object","required":["url"],"properties":{"url":{"type":"string"},"connectionId":{"type":"string","format":"uuid"},"useSiteSession":{"type":"boolean"}},"additionalProperties":false}
        """);

    internal static readonly JsonElement FormSchema = Json("""
        {"type":"object","required":["browseActionId","formIndex","fields"],"properties":{
          "browseActionId":{"type":"string","format":"uuid"},"formIndex":{"type":"integer","minimum":0},
          "fields":{"type":"array","items":{"type":"object","required":["name","value"],"properties":{"name":{"type":"string"},"value":{"type":"string"}},"additionalProperties":false}},
          "attachments":{"type":"array","items":{"type":"object","required":["field","fileId"],"properties":{"field":{"type":"string"},"fileId":{"type":"string","format":"uuid"},"versionId":{"type":"string","format":"uuid"}},"additionalProperties":false}}
        },"additionalProperties":false}
        """);

    internal static T? Parse<T>(JsonElement value, JsonTypeInfo<T> type)
    {
        try
        {
            return value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined
                ? default : value.Deserialize(type);
        }
        catch (JsonException)
        {
            return default;
        }
    }

    internal static T? Parse<T>(string? value, JsonTypeInfo<T> type)
    {
        try
        {
            return value is null ? default : JsonSerializer.Deserialize(value, type);
        }
        catch (JsonException)
        {
            return default;
        }
    }

    internal static Result<string> Receipt(Result<JsonElement> value) => value.IsSuccess
        ? Result.Success(value.Value.GetRawText())
        : Result.Failure<string>(value.Error);

    internal static bool Property(JsonElement element, string name, out JsonElement value)
    {
        value = default;
        return element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out value);
    }

    internal static string Summary(JsonElement page, bool includeText)
    {
        var citation = Text(page, "citation", 160);
        var forms = Property(page, "forms", out var value) && value.ValueKind == JsonValueKind.Array
            ? value.EnumerateArray().Take(2).Select(DescribeForm)
            : [];
        var links = Property(page, "links", out var linkList) && linkList.ValueKind == JsonValueKind.Array
            ? linkList.EnumerateArray().Take(includeText ? 2 : 5)
                .Select(link => Text(link, "title", 45) + " " + Text(link, "url", 140))
            : [];
        var pageLines = includeText ? new[] { citation, "Page title: " + Text(page, "title", 100) } : [citation];
        var excerpt = includeText ? "Body excerpt: " + Text(page, "text", 180) : "";
        return string.Join('\n', pageLines.Concat(forms).Concat(links).Append(excerpt));
    }

    private static string DescribeForm(JsonElement form)
    {
        var number = Property(form, "index", out var index) && index.TryGetInt32(out var found)
            ? found.ToString(CultureInfo.InvariantCulture) : "?";
        if (!Property(form, "supported", out var supported) || supported.ValueKind != JsonValueKind.True)
        {
            return "Form " + number + " requires human takeover.";
        }
        var names = Property(form, "fields", out var fields) && fields.ValueKind == JsonValueKind.Array
            ? fields.EnumerateArray().Take(8).Select(field => Text(field, "name", 32))
            : [];
        return "Form " + number + " fields " + string.Join(", ", names);
    }

    private static string Text(JsonElement element, string property, int max)
    {
        var text = Property(element, property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? "" : "";
        return text.Length <= max ? text : text[..max];
    }

    private static JsonElement Json(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }
}
