using System.Security.Cryptography;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using Nix.Abstractions;
using Nix.Domain.Authorization;
using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.PublicLinks;
using Nix.Errors;
using Nix.Features.Workspaces;
using Nix.Http;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.PublicLinks;

/// <summary>Creates (or replaces) the item's one active public link.</summary>
/// <param name="VersionId">For a file: the version to serve, fixed at creation. Null means the latest approved version; with none approved the request is refused.</param>
public sealed record PutPublicLinkRequest(Guid? VersionId = null);

/// <summary>A file a note's public link withholds because it has no approved version.</summary>
public sealed record WithheldFileResponse(Guid FileItemId, string Name);

/// <summary>The item's active public link. The URL is a bearer capability: anyone holding it can read.</summary>
/// <param name="Url">The absolute public URL.</param>
/// <param name="VersionId">The fixed file version a file link serves, or null for a note link.</param>
/// <param name="VersionState">That version's state at the time of the read, or null for a note link.</param>
/// <param name="WithheldFiles">Files of a note link held back for lack of an approved version.</param>
public sealed record PublicLinkResponse(
    Uri Url,
    Guid ItemId,
    Guid? VersionId,
    string? VersionState,
    Guid CreatedBy,
    DateTimeOffset CreatedAt,
    IReadOnlyList<WithheldFileResponse> WithheldFiles);

/// <summary>
/// What an anonymous reader gets from a link. <c>Kind</c> is <c>note</c> (Title and Html set) or
/// <c>file</c> (Url, Name, MediaType and ExpiresAt set; the URL lives at most 60 seconds). Fields
/// of the other kind are null.
/// </summary>
public sealed record PublicLinkReadResponse(
    string Kind,
    string? Title = null,
    string? Html = null,
    Uri? Url = null,
    string? Name = null,
    string? MediaType = null,
    DateTimeOffset? ExpiresAt = null);

/// <summary>The install-level switch for public links. Off by default.</summary>
public static class PublicLinkSettings
{
    /// <summary>Configuration key of the install switch.</summary>
    public const string EnabledKey = "Nix:PublicLinks:Enabled";

    /// <summary>Whether this install serves and creates public links.</summary>
    public static bool IsEnabled(IConfiguration configuration) =>
        configuration.GetValue(EnabledKey, false);
}

/// <summary>Public links for notes and files, and the anonymous read.</summary>
internal static class PublicLinkEndpoints
{
    internal static IEndpointRouteBuilder MapPublicLinkEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var group = endpoints.MapGroup("/api/v1/items/{itemId:guid}/public-link").WithTags("PublicLinks");
        group.MapGet("", Get)
            .WithName("GetPublicLink")
            .Produces<PublicLinkResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPut("", Put)
            .WithName("CreatePublicLink")
            .Produces<PublicLinkResponse>()
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapDelete("", Revoke)
            .WithName("RevokePublicLink")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        // Anonymous, outside /api/v1 and so outside the unit of work, like the public form routes.
        endpoints.MapGet("/public/v1/links/{token}", Read)
            .WithTags("PublicLinks")
            .WithName("ReadPublicLink")
            .Produces<PublicLinkReadResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.PublicLinksPolicyName);
        return endpoints;
    }

    private static async Task<IResult> Get(
        Guid itemId,
        HttpContext context,
        [FromServices] IItemTree tree,
        [FromServices] IPermissionResolver permissions,
        [FromServices] IConfiguration configuration,
        [FromServices] PublicLinkStore store,
        [FromServices] PublicLinkTokenService tokens,
        [FromServices] IPublicNoteReader? notes)
    {
        if (Disabled(configuration, context) is { } disabled)
        {
            return disabled;
        }

        var item = await tree.FindAsync(ItemId.From(itemId), context.RequestAborted).ConfigureAwait(false);
        if (item is null
            || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, context.RequestAborted).ConfigureAwait(false))
        {
            return Refuse(context, 404, "public_links.not_found", "No such item is visible.");
        }

        var link = await store.FindActiveAsync(item.Id, context.RequestAborted).ConfigureAwait(false);
        return link is null
            ? Refuse(context, 404, "public_links.no_link", "This item has no active public link.")
            : TypedResults.Ok(await ToResponseAsync(link, context, store, tokens, notes).ConfigureAwait(false));
    }

    private static async Task<IResult> Put(
        Guid itemId,
        PutPublicLinkRequest request,
        HttpContext context,
        [FromServices] IItemTree tree,
        [FromServices] IPermissionResolver permissions,
        [FromServices] IConfiguration configuration,
        [FromServices] PublicLinkStore store,
        [FromServices] PublicLinkTokenService tokens,
        [FromServices] S3CapabilitySigner signer,
        [FromServices] INixSessionContextAccessor sessions,
        [FromServices] AccessTokenSessionContext tokenScope,
        [FromServices] TimeProvider clock,
        [FromServices] IPublicNoteReader? notes)
    {
        if (Disabled(configuration, context) is { } disabled)
        {
            return disabled;
        }

        if (!tokens.IsConfigured)
        {
            return Refuse(context, 503, "public_links.not_configured", "Public links are not configured.");
        }

        var ct = context.RequestAborted;
        var item = await tree.FindAsync(ItemId.From(itemId), ct).ConfigureAwait(false);
        if (item is null || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, ct).ConfigureAwait(false))
        {
            return Refuse(context, 404, "public_links.not_found", "No such item is visible.");
        }

        var workspace = await store.FindWorkspaceAsync(item.WorkspaceId, ct).ConfigureAwait(false);
        if (workspace is null || !AgentPolicyGate.MayCreatePublicLink(tokenScope, workspace))
        {
            return Refuse(context, 403, "public_links.agent_not_allowed", "This workspace does not let agents create public links.");
        }

        var isFile = item.Type == "file";
        if (!isFile && item.Type != "note")
        {
            return Refuse(context, 422, "public_links.unsupported_type", "Only notes and files can have a public link.");
        }

        if (!isFile && request.VersionId is not null)
        {
            return Refuse(context, 422, "public_links.version_not_applicable", "A note link has no version.");
        }

        if (await store.IsUnderLockAsync(item.Id, ct).ConfigureAwait(false))
        {
            return Refuse(context, 409, "public_links.locked", "A locked item, or one under a lock, cannot have a public link.");
        }

        FileVersion? version = null;
        if (isFile)
        {
            if (!signer.IsConfigured)
            {
                return Refuse(context, 503, "public_links.storage_unavailable", "File storage is not configured.");
            }

            version = await store.FindVersionAsync(item.Id, request.VersionId, ct).ConfigureAwait(false);
            if (version is null || version.State == "revoked")
            {
                return Refuse(
                    context,
                    422,
                    request.VersionId is null ? "public_links.no_approved_version" : "public_links.version_not_linkable",
                    request.VersionId is null
                        ? "The file has no approved version; approve one or name a version."
                        : "That version does not belong to this file or has been revoked.");
            }
        }

        var session = sessions.Current
            ?? throw new InvalidOperationException("The authenticated pipeline did not establish a session.");
        var now = clock.GetUtcNow();
        var existing = await store.FindActiveAsync(item.Id, ct).ConfigureAwait(false);
        if (existing is not null)
        {
            // Revoke first and flush, so the one-active-link-per-item index sees the old row gone.
            existing.RevokedAt = now;
            store.AddAudit(session, existing, "public_link.revoked", now);
            await store.SaveAsync(ct).ConfigureAwait(false);
        }

        Principal? principal = null;
        WorkspaceMember? membership = null;
        var linkId = Guid.CreateVersion7();
        var principalId = await store.FindReusablePrincipalAsync(item.Id, ct).ConfigureAwait(false);
        if (principalId is null)
        {
            principalId = PrincipalId.Create();
            principal = new Principal
            {
                Id = principalId.Value,
                TenantId = session.TenantId,
                ExternalSubject = $"nix:public-link:{linkId:D}",
                Kind = PrincipalKind.Service,
                DisplayName = "Public link",
                Email = null,
                Status = PrincipalStatus.Active,
                DeprovisionedAt = null,
            };
            membership = new WorkspaceMember
            {
                WorkspaceId = item.WorkspaceId,
                SubjectType = SubjectType.Principal,
                SubjectId = principalId.Value.Value,
                TenantId = session.TenantId,
                Role = WorkspaceRoles.ToText(WorkspaceRole.Viewer),
                GrantedBy = session.PrincipalId,
                GrantedAt = now,
            };
        }

        var link = new PublicLink
        {
            Id = linkId,
            TenantId = session.TenantId,
            WorkspaceId = item.WorkspaceId,
            ItemId = item.Id,
            Nonce = NewNonce(),
            FileVersionId = version?.Id,
            ServicePrincipalId = principalId.Value,
            CreatedBy = session.PrincipalId,
            CreatedAt = now,
            RevokedAt = null,
        };
        store.Add(link, principal, membership);
        store.AddAudit(session, link, "public_link.created", now);
        await store.SaveAsync(ct).ConfigureAwait(false);
        return TypedResults.Ok(await ToResponseAsync(link, context, store, tokens, notes).ConfigureAwait(false));
    }

    private static async Task<IResult> Revoke(
        Guid itemId,
        HttpContext context,
        [FromServices] IItemTree tree,
        [FromServices] IPermissionResolver permissions,
        [FromServices] IConfiguration configuration,
        [FromServices] PublicLinkStore store,
        [FromServices] INixSessionContextAccessor sessions,
        [FromServices] TimeProvider clock)
    {
        if (Disabled(configuration, context) is { } disabled)
        {
            return disabled;
        }

        var ct = context.RequestAborted;
        var item = await tree.FindAsync(ItemId.From(itemId), ct).ConfigureAwait(false);
        if (item is null || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, ct).ConfigureAwait(false))
        {
            return Refuse(context, 404, "public_links.not_found", "No such item is visible.");
        }

        var link = await store.FindActiveAsync(item.Id, ct).ConfigureAwait(false);
        if (link is null)
        {
            return Refuse(context, 404, "public_links.no_link", "This item has no active public link.");
        }

        var now = clock.GetUtcNow();
        link.RevokedAt = now;
        store.AddAudit(
            sessions.Current ?? throw new InvalidOperationException("The authenticated pipeline did not establish a session."),
            link,
            "public_link.revoked",
            now);
        await store.SaveAsync(ct).ConfigureAwait(false);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> Read(
        string token,
        HttpContext context,
        [FromServices] IPublicLinkResolver resolver,
        [FromServices] PublicLinkStore store,
        [FromServices] S3CapabilitySigner signer,
        [FromServices] IPublicNoteReader? notes)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers["X-Robots-Tag"] = "noindex";
        context.Response.Headers.XContentTypeOptions = "nosniff";

        var ct = context.RequestAborted;
        var link = await resolver.ResolveAsync(token, ct).ConfigureAwait(false);
        if (link is null)
        {
            return TypedResults.NotFound();
        }

        if (link.FileVersionId is not { } versionId)
        {
            var render = notes is null ? null : await notes.RenderAsync(link, ct).ConfigureAwait(false);
            if (render is null)
            {
                return TypedResults.NotFound();
            }

            // The page's own file requests then reuse this render instead of repeating it.
            Notes.PublicNoteServing.Remember(link.LinkId, render.ServableFileIds);
            return TypedResults.Ok(new PublicLinkReadResponse("note", Title: render.Title, Html: Notes.PublicNoteServing.BindToken(render.Html, token)));
        }

        // A revoked version, or one whose object is not published, answers like any dead link.
        var version = signer.IsConfigured
            ? await store.FindVersionAsync(link.ItemId, versionId, ct).ConfigureAwait(false)
            : null;
        if (version is null || version.State == "revoked")
        {
            return TypedResults.NotFound();
        }

        var capability = signer.GetForPublicLink(version.ObjectKey, version.FileName, version.MediaType);
        return TypedResults.Ok(new PublicLinkReadResponse(
            "file",
            Url: capability.Url,
            Name: version.FileName,
            MediaType: S3CapabilitySigner.ServesInlineOnPublicLink(version.MediaType)
                ? version.MediaType
                : "application/octet-stream",
            ExpiresAt: capability.ExpiresAt));
    }

    private static async Task<PublicLinkResponse> ToResponseAsync(
        PublicLink link,
        HttpContext context,
        PublicLinkStore store,
        PublicLinkTokenService tokens,
        IPublicNoteReader? notes)
    {
        var ct = context.RequestAborted;
        string? state = null;
        IReadOnlyList<WithheldFileResponse> withheld = [];
        if (link.FileVersionId is { } versionId)
        {
            state = (await store.FindVersionAsync(link.ItemId, versionId.Value, ct).ConfigureAwait(false))?.State;
        }
        else if (notes is not null)
        {
            var render = await notes.RenderAsync(
                new ResolvedPublicLink(link.Id, link.TenantId, link.WorkspaceId, link.ItemId, null, link.ServicePrincipalId.Value),
                ct).ConfigureAwait(false);
            withheld = [.. (render?.WithheldFiles ?? []).Select(file => new WithheldFileResponse(file.FileItemId, file.Name))];
        }

        var token = tokens.Create(new PublicLinkTokenPayload(
            link.TenantId.Value,
            link.Id,
            link.ServicePrincipalId.Value,
            link.Nonce));
        return new PublicLinkResponse(
            new Uri($"{context.Request.Scheme}://{context.Request.Host}/links/{token}"),
            link.ItemId.Value,
            link.FileVersionId?.Value,
            state,
            link.CreatedBy.Value,
            link.CreatedAt,
            withheld);
    }

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult? Disabled(IConfiguration configuration, HttpContext context) =>
        PublicLinkSettings.IsEnabled(configuration)
            ? null
            : Refuse(context, 404, "public_links.disabled", "Public links are not enabled on this install.");

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult Refuse(HttpContext context, int status, string code, string detail) =>
        TypedResults.Problem(ApiProblem.Create(context, status, code, "Public link refused", detail));

    private static string NewNonce() => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(PutPublicLinkRequest))]
[JsonSerializable(typeof(PublicLinkResponse))]
[JsonSerializable(typeof(PublicLinkReadResponse))]
internal sealed partial class PublicLinksJsonContext : JsonSerializerContext;
