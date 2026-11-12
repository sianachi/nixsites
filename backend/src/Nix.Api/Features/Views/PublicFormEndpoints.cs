using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using Nix.Abstractions;
using Nix.Domain.Audit;
using Nix.Domain.Authorization;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Views;

internal sealed record PublicFormLinkResponse(
    bool Published,
    string? Url,
    DateTimeOffset? PublishedAt,
    DateTimeOffset? RevokedAt);

internal sealed record PublicFormPropertyResponse(
    string BlockId,
    string Type,
    IReadOnlyList<string> Options);

internal sealed record PublicFormBlockResponse(
    string Id,
    string Kind,
    string Text,
    string? Help,
    bool Required,
    string? IdentityRole,
    IReadOnlyList<FormConditionContract> VisibleWhen);

internal sealed record PublicFormPageResponse(
    string Id,
    string Title,
    string? Description,
    IReadOnlyList<FormConditionContract> VisibleWhen,
    IReadOnlyList<PublicFormBlockResponse> Blocks);

internal sealed record PublicFormDefinitionResponse(
    IReadOnlyList<PublicFormPageResponse> Pages,
    string ConfirmationTitle,
    string ConfirmationMessage);

internal sealed record PublicInteractiveFormResponse(
    string Name,
    PublicFormDefinitionResponse Form,
    IReadOnlyList<PublicFormPropertyResponse> Fields);

internal sealed record SubmitPublicFormRequest(
    IReadOnlyDictionary<string, JsonElement>? Answers,
    string? Website);

public static class PublicFormEndpoints
{
    private const string PublicFormSubjectPrefix = "nix:public-form:";
    private const string SubmissionFormKey = "nix_submission_form";

    internal static IEndpointRouteBuilder MapPublicFormEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapGet(
                "/api/v1/items/{itemId:guid}/views/{viewId}/public-link",
                GetStatus)
            .WithTags("Forms")
            .WithName("GetPublicFormStatus")
            .Produces<PublicFormLinkResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);

        endpoints.MapPut(
                "/api/v1/items/{itemId:guid}/views/{viewId}/public-link",
                Publish)
            .WithTags("Forms")
            .WithName("PublishPublicForm")
            .Produces<PublicFormLinkResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        endpoints.MapDelete(
                "/api/v1/items/{itemId:guid}/views/{viewId}/public-link",
                Revoke)
            .WithTags("Forms")
            .WithName("RevokePublicForm")
            .Produces<PublicFormLinkResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        endpoints.MapGet("/public/v1/forms/{token}", GetPublicForm)
            .WithTags("Forms")
            .WithName("GetPublicForm")
            .Produces<PublicInteractiveFormResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);

        endpoints.MapPost("/public/v1/forms/{token}", SubmitPublicForm)
            .WithTags("Forms")
            .WithName("SubmitPublicForm")
            .Produces(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.PublicFormsPolicyName);

        return endpoints;
    }

    private static async Task<IResult> GetStatus(
        Guid itemId,
        string viewId,
        HttpContext httpContext,
        [FromServices] IItemTree tree,
        [FromServices] IPublicFormStore store,
        [FromServices] IPermissionResolver permissions,
        [FromServices] PublicFormTokenService tokens)
    {
        var item = await tree.FindAsync(ItemId.From(itemId), httpContext.RequestAborted)
            .ConfigureAwait(false);
        if (item is null
            || FindInteractiveForm(item, viewId) is null
            || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, httpContext.RequestAborted)
                .ConfigureAwait(false))
        {
            return NotFound();
        }

        var link = await store.FindForUpdateAsync(item.Id, viewId, httpContext.RequestAborted)
            .ConfigureAwait(false);
        if (link is null
            || link.RevokedAt is not null
            || !await store.IsActivePrincipalAsync(link.SubmissionPrincipalId, httpContext.RequestAborted)
                .ConfigureAwait(false))
        {
            return TypedResults.Ok(new PublicFormLinkResponse(
                false,
                null,
                link?.PublishedAt,
                link?.RevokedAt));
        }

        if (!tokens.IsConfigured)
        {
            return TypedResults.Problem(
                statusCode: StatusCodes.Status503ServiceUnavailable,
                title: "Public forms are not configured");
        }

        return TypedResults.Ok(ToLinkResponse(link, httpContext, tokens));
    }

    private static async Task<IResult> Publish(
        Guid itemId,
        string viewId,
        HttpContext httpContext,
        [FromServices] IItemTree tree,
        [FromServices] IPublicFormStore store,
        [FromServices] IPermissionResolver permissions,
        [FromServices] ISchemaResolver schemas,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] PublicFormTokenService tokens,
        [FromServices] TimeProvider clock)
    {
        if (!tokens.IsConfigured)
        {
            return TypedResults.Problem(
                statusCode: StatusCodes.Status503ServiceUnavailable,
                title: "Public forms are not configured");
        }

        var item = await tree.FindAsync(ItemId.From(itemId), httpContext.RequestAborted)
            .ConfigureAwait(false);
        var view = item is null ? null : FindInteractiveForm(item, viewId);
        if (item is null
            || view is null
            || item.LifecycleState != ItemLifecycleState.Active
            || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, httpContext.RequestAborted)
                .ConfigureAwait(false))
        {
            return NotFound();
        }

        var response = await PublishConfiguredAsync(
            item,
            view,
            httpContext,
            store,
            schemas,
            session,
            tokens,
            clock).ConfigureAwait(false);
        return response is null ? TypedResults.BadRequest() : TypedResults.Ok(response);
    }

    internal static async Task<PublicFormLinkResponse?> PublishConfiguredAsync(
        Item item,
        ViewDefinition view,
        HttpContext httpContext,
        IPublicFormStore store,
        ISchemaResolver schemas,
        INixSessionContextAccessor session,
        PublicFormTokenService tokens,
        TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(item);
        ArgumentNullException.ThrowIfNull(view);
        ArgumentNullException.ThrowIfNull(httpContext);
        if (!tokens.IsConfigured
            || view.Kind != ViewKind.InteractiveForm
            || view.InteractiveForm is null
            || string.Equals(view.Mode, "temporary", StringComparison.Ordinal))
        {
            return null;
        }

        var context = session.Current
            ?? throw new InvalidOperationException("The authenticated pipeline did not establish a session.");
        var responseSchema = await schemas.ResolveForChildrenAsync(item.Id, httpContext.RequestAborted)
            .ConfigureAwait(false);
        var configuredFields = view.InteractiveForm.Pages.SelectMany(page => page.Blocks)
            .Where(block => block.Kind == "field")
            .ToArray();
        if (configuredFields.Any(block =>
                block.PropertyKey is null
                || responseSchema.Find(block.PropertyKey) is null
                || (block.IdentityRole is not null
                    && responseSchema.Find(block.PropertyKey)?.Type != PropertyType.Text)))
        {
            return null;
        }

        var now = clock.GetUtcNow();
        var link = await store.FindForUpdateAsync(item.Id, view.Id, httpContext.RequestAborted)
            .ConfigureAwait(false);
        if (link is null)
        {
            var linkId = Guid.CreateVersion7();
            var principalId = PrincipalId.Create();
            var principal = new Principal
            {
                Id = principalId,
                TenantId = context.TenantId,
                ExternalSubject = $"{PublicFormSubjectPrefix}{linkId:D}",
                Kind = PrincipalKind.Service,
                DisplayName = $"Public form: {view.Name}",
                Email = null,
                Status = PrincipalStatus.Active,
                DeprovisionedAt = null,
            };
            var membership = new WorkspaceMember
            {
                WorkspaceId = item.WorkspaceId,
                SubjectType = SubjectType.Principal,
                SubjectId = principalId.Value,
                TenantId = context.TenantId,
                Role = WorkspaceRoles.ToText(WorkspaceRole.Editor),
                GrantedBy = context.PrincipalId,
                GrantedAt = now,
            };
            link = new PublicFormLink
            {
                Id = linkId,
                TenantId = context.TenantId,
                WorkspaceId = item.WorkspaceId,
                ItemId = item.Id,
                ViewId = view.Id,
                Nonce = NewNonce(),
                SubmissionPrincipalId = principalId,
                PublishedBy = context.PrincipalId,
                PublishedAt = now,
                RevokedAt = null,
            };
            store.Add(link, principal, membership);
        }
        else
        {
            link.Nonce = NewNonce();
            link.PublishedBy = context.PrincipalId;
            link.PublishedAt = now;
            link.RevokedAt = null;
        }

        AddAudit(store, context, item.WorkspaceId, link.Id, "public_form.published", now, httpContext);
        await store.SaveAsync(httpContext.RequestAborted).ConfigureAwait(false);
        return ToLinkResponse(link, httpContext, tokens);
    }

    private static async Task<IResult> Revoke(
        Guid itemId,
        string viewId,
        HttpContext httpContext,
        [FromServices] IItemTree tree,
        [FromServices] IPublicFormStore store,
        [FromServices] IPermissionResolver permissions,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] TimeProvider clock)
    {
        var item = await tree.FindAsync(ItemId.From(itemId), httpContext.RequestAborted)
            .ConfigureAwait(false);
        if (item is null
            || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, httpContext.RequestAborted)
                .ConfigureAwait(false))
        {
            return NotFound();
        }

        var link = await store.FindForUpdateAsync(item.Id, viewId, httpContext.RequestAborted)
            .ConfigureAwait(false);
        if (link is null)
        {
            return NotFound();
        }

        link.RevokedAt = clock.GetUtcNow();
        link.Nonce = NewNonce();
        var current = session.Current
            ?? throw new InvalidOperationException("The authenticated pipeline did not establish a session.");
        AddAudit(
            store,
            current,
            item.WorkspaceId,
            link.Id,
            "public_form.revoked",
            link.RevokedAt.Value,
            httpContext);
        await store.SaveAsync(httpContext.RequestAborted).ConfigureAwait(false);
        return TypedResults.Ok(new PublicFormLinkResponse(false, null, link.PublishedAt, link.RevokedAt));
    }

    private static async Task<IResult> GetPublicForm(
        string token,
        HttpContext httpContext,
        [FromServices] IItemTree tree,
        [FromServices] IPublicFormStore store,
        [FromServices] ISchemaResolver schemas,
        [FromServices] PublicFormTokenService tokens)
    {
        if (!tokens.TryRead(token, out var payload))
        {
            return NotFound();
        }

        var context = NixSessionContext.ForTenant(
            TenantId.From(payload.TenantId),
            PrincipalId.From(payload.SubmissionPrincipalId));
#pragma warning disable CA2007 // The transaction itself is used after creation; only disposal lacks ConfigureAwait.
        await using var transaction = await store.BeginAsync(context, httpContext.RequestAborted)
            .ConfigureAwait(false);
#pragma warning restore CA2007
        var resolved = await Resolve(store, tree, payload, lockSubmission: false, httpContext.RequestAborted).ConfigureAwait(false);
        if (resolved is null)
        {
            return NotFound();
        }

        var schema = await schemas.ResolveForChildrenAsync(resolved.Value.Item.Id, httpContext.RequestAborted)
            .ConfigureAwait(false);
        var form = resolved.Value.View.InteractiveForm!;
        var fields = form.Pages
            .SelectMany(page => page.Blocks)
            .Where(block => block.Kind == "field" && block.PropertyKey is not null)
            .Select(block => (Block: block, Property: schema.Find(block.PropertyKey!)))
            .Where(pair => pair.Property is not null)
            .Select(pair => new PublicFormPropertyResponse(
                pair.Block.Id,
                PropertyTypes.ToText(pair.Property!.Type),
                pair.Property.Options))
            .ToImmutableArray();

        return TypedResults.Ok(new PublicInteractiveFormResponse(
            resolved.Value.View.Name,
            Sanitize(form),
            fields));
    }

    private static async Task<IResult> SubmitPublicForm(
        string token,
        SubmitPublicFormRequest request,
        HttpContext httpContext,
        [FromServices] IItemTree tree,
        [FromServices] ISchemaResolver schemas,
        [FromServices] IPublicFormStore store,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] PublicFormTokenService tokens,
        [FromServices] TimeProvider clock)
    {
        if (!string.IsNullOrEmpty(request.Website))
        {
            return TypedResults.BadRequest();
        }

        if (!tokens.TryRead(token, out var payload))
        {
            return NotFound();
        }

        var context = NixSessionContext.ForTenant(
            TenantId.From(payload.TenantId),
            PrincipalId.From(payload.SubmissionPrincipalId));
#pragma warning disable CA2007 // The transaction itself is used after creation; only disposal lacks ConfigureAwait.
        await using var transaction = await store.BeginAsync(context, httpContext.RequestAborted)
            .ConfigureAwait(false);
#pragma warning restore CA2007
        var resolved = await Resolve(store, tree, payload, lockSubmission: true, httpContext.RequestAborted).ConfigureAwait(false);
        if (resolved is null)
        {
            return NotFound();
        }

        var answers = request.Answers ?? new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        var blocks = resolved.Value.View.InteractiveForm!.Pages.SelectMany(page => page.Blocks).ToArray();
        var fields = blocks.Where(block => block.Kind == "field").ToDictionary(block => block.Id, StringComparer.Ordinal);
        if (answers.Keys.Any(key => !fields.ContainsKey(key)))
        {
            return TypedResults.BadRequest();
        }

        var values = answers.ToDictionary(
            pair => pair.Key,
            pair => JsonNode.Parse(pair.Value.GetRawText()),
            StringComparer.Ordinal);
        var visible = VisibleFields(resolved.Value.View.InteractiveForm, values);
        var visibleIds = visible.Select(block => block.Id).ToHashSet(StringComparer.Ordinal);
        if (answers.Keys.Any(key => !visibleIds.Contains(key)))
        {
            return TypedResults.BadRequest();
        }

        if (visible.Any(block => block.Required && IsEmpty(values.GetValueOrDefault(block.Id))))
        {
            return TypedResults.BadRequest();
        }

        var properties = new JsonObject();
        foreach (var block in visible)
        {
            if (block.PropertyKey is not null && values.TryGetValue(block.Id, out var answer))
            {
                properties[block.PropertyKey] = answer?.DeepClone();
            }
        }

        var form = resolved.Value.View.InteractiveForm;
        var title = GenerateResponseTitle(form, resolved.Value.View.Name, values, clock.GetUtcNow());
        var responseSchema = await schemas.ResolveForChildrenAsync(resolved.Value.Item.Id, httpContext.RequestAborted)
            .ConfigureAwait(false);
        if (responseSchema.Find(SubmissionFormKey)?.Type == PropertyType.Text)
        {
            properties[SubmissionFormKey] = resolved.Value.View.Id;
        }

        var result = await dispatcher.SendAsync<CreateItem, Item>(
            new CreateItem(
                resolved.Value.Item.WorkspaceId,
                "note",
                title,
                resolved.Value.Item.Id,
                properties),
            httpContext.RequestAborted).ConfigureAwait(false);
        if (result.IsFailure)
        {
            return TypedResults.BadRequest();
        }

        AddAudit(
            store,
            context,
            resolved.Value.Item.WorkspaceId,
            result.Value.Id.Value,
            "public_form.response_created",
            clock.GetUtcNow(),
            httpContext);
        await store.SaveAsync(httpContext.RequestAborted).ConfigureAwait(false);
        await transaction.CommitAsync(httpContext.RequestAborted).ConfigureAwait(false);
        return TypedResults.Created();
    }

    private static async Task<(PublicFormLink Link, Item Item, ViewDefinition View)?> Resolve(
        IPublicFormStore store,
        IItemTree tree,
        PublicFormTokenPayload payload,
        bool lockSubmission,
        CancellationToken cancellationToken)
    {
        var link = await store.FindAsync(payload.LinkId, cancellationToken).ConfigureAwait(false);
        if (link is null
            || link.RevokedAt is not null
            || link.SubmissionPrincipalId != PrincipalId.From(payload.SubmissionPrincipalId)
            || !await store.IsActivePrincipalAsync(link.SubmissionPrincipalId, cancellationToken)
                .ConfigureAwait(false)
            || !CryptographicOperations.FixedTimeEquals(
                System.Text.Encoding.UTF8.GetBytes(link.Nonce),
                System.Text.Encoding.UTF8.GetBytes(payload.Nonce)))
        {
            return null;
        }

        if (lockSubmission && !await store.LockSubmissionAsync(link, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        var item = await tree.FindAsync(link.ItemId, cancellationToken).ConfigureAwait(false);
        var view = item is null ? null : FindInteractiveForm(item, link.ViewId);
        return item is null || item.LifecycleState != ItemLifecycleState.Active || view is null
            ? null
            : (link, item, view);
    }

    private static ViewDefinition? FindInteractiveForm(Item item, string viewId) =>
        ViewDefinitionsJson.Read(item.Views).Views.FirstOrDefault(
            view => view.Kind == ViewKind.InteractiveForm
                && view.InteractiveForm is not null
                && !string.Equals(view.Mode, "temporary", StringComparison.Ordinal)
                && string.Equals(view.Id, viewId, StringComparison.Ordinal));

    public static IReadOnlyList<FormBlock> VisibleFields(
        InteractiveFormDefinition form,
        IReadOnlyDictionary<string, JsonNode?> answers)
    {
        ArgumentNullException.ThrowIfNull(form);
        ArgumentNullException.ThrowIfNull(answers);
        var visible = new List<FormBlock>();
        var effectiveAnswers = new Dictionary<string, JsonNode?>(StringComparer.Ordinal);
        foreach (var page in form.Pages)
        {
            if (!Matches(page.VisibleWhen, effectiveAnswers))
            {
                continue;
            }

            foreach (var block in page.Blocks)
            {
                if (block.Kind != "field" || !Matches(block.VisibleWhen, effectiveAnswers))
                {
                    continue;
                }

                visible.Add(block);
                if (answers.TryGetValue(block.Id, out var answer))
                {
                    effectiveAnswers[block.Id] = answer;
                }
            }
        }

        return visible;
    }

    public static string GenerateResponseTitle(
        InteractiveFormDefinition form,
        string formName,
        IReadOnlyDictionary<string, JsonNode?> answers,
        DateTimeOffset submittedAt)
    {
        ArgumentNullException.ThrowIfNull(form);
        ArgumentException.ThrowIfNullOrWhiteSpace(formName);
        ArgumentNullException.ThrowIfNull(answers);
        var selected = form.TitleMode == "field" && form.TitleFieldBlockId is { } titleBlock
            ? answers.GetValueOrDefault(titleBlock)?.ToString()?.Trim()
            : null;
        return string.IsNullOrWhiteSpace(selected)
            ? $"{formName} — {submittedAt:yyyy-MM-dd HH:mm:ss 'UTC'}"
            : selected;
    }

    private static bool Matches(
        ImmutableArray<FormCondition> conditions,
        IReadOnlyDictionary<string, JsonNode?> answers) =>
        conditions.IsDefaultOrEmpty || conditions.All(condition =>
        {
            var answer = answers.GetValueOrDefault(condition.FieldBlockId);
            var actual = answer?.ToString() ?? string.Empty;
            var expected = condition.Value ?? string.Empty;
            return condition.Operator switch
            {
                "checked" => TryGetBoolean(answer, out var checkedValue) && checkedValue,
                "not_checked" => answer is null
                    || (TryGetBoolean(answer, out var uncheckedValue) && !uncheckedValue),
                "not_equals" => !string.Equals(actual, expected, StringComparison.Ordinal),
                "contains" when answer is JsonArray array =>
                    array.Any(value => string.Equals(value?.ToString(), expected, StringComparison.Ordinal)),
                "contains" => actual.Contains(expected, StringComparison.Ordinal),
                _ => string.Equals(actual, expected, StringComparison.Ordinal),
            };
        });

    private static bool TryGetBoolean(JsonNode? value, out bool result)
    {
        result = false;
        return value is JsonValue jsonValue && jsonValue.TryGetValue(out result);
    }

    private static bool IsEmpty(JsonNode? value) =>
        value is null
        || (value is JsonValue && string.IsNullOrWhiteSpace(value.ToString()))
        || (value is JsonArray array && array.Count == 0);

    private static PublicFormLinkResponse ToLinkResponse(
        PublicFormLink link,
        HttpContext context,
        PublicFormTokenService tokens)
    {
        var token = tokens.Create(link.TenantId, link.Id, link.SubmissionPrincipalId, link.Nonce);
        var url = $"{context.Request.Scheme}://{context.Request.Host}/forms/{token}";
        return new PublicFormLinkResponse(true, url, link.PublishedAt, null);
    }

    private static string NewNonce() => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

    private static PublicFormDefinitionResponse Sanitize(InteractiveFormDefinition form) =>
        new(
            [.. form.Pages.Select(page => new PublicFormPageResponse(
                page.Id,
                page.Title,
                page.Description,
                [.. page.VisibleWhen.Select(condition => new FormConditionContract(
                    condition.FieldBlockId,
                    condition.Operator,
                    condition.Value))],
                [.. page.Blocks.Select(block => new PublicFormBlockResponse(
                    block.Id,
                    block.Kind,
                    block.Text,
                    block.Help,
                    block.Required,
                    block.IdentityRole,
                    [.. block.VisibleWhen.Select(condition => new FormConditionContract(
                        condition.FieldBlockId,
                        condition.Operator,
                        condition.Value))]))]))],
            form.ConfirmationTitle,
            form.ConfirmationMessage);

    private static void AddAudit(
        IPublicFormStore store,
        NixSessionContext context,
        WorkspaceId workspaceId,
        Guid subjectId,
        string action,
        DateTimeOffset occurredAt,
        HttpContext httpContext) =>
        store.AddAudit(new AuditEvent
        {
            Id = AuditEventId.Create(),
            TenantId = context.TenantId,
            WorkspaceId = workspaceId,
            ActorId = context.PrincipalId,
            OnBehalfOf = null,
            Action = action,
            SubjectId = subjectId,
            SubjectType = "public_form",
            Before = null,
            After = null,
            ActorIp = httpContext.Connection.RemoteIpAddress,
            OccurredAt = occurredAt,
        });

    private static Microsoft.AspNetCore.Http.HttpResults.NotFound NotFound() => TypedResults.NotFound();
}
