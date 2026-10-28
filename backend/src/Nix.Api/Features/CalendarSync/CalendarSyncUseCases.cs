using System.Buffers.Text;
using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using Nix.Abstractions;
using Nix.Abstractions.Calendar;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Calendar;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Automations;
using Nix.Features.Views;
using Nix.Messaging;

namespace Nix.Features.CalendarSync;

/// <summary>Lists the providers and the caller's connections.</summary>
public sealed record ListCalendarConnections : ICommand<CalendarConnectionsResponse>;

/// <summary>Starts connecting a provider account.</summary>
public sealed record AuthorizeCalendarConnection(string Provider, string? ReturnTo) : ICommand<CalendarAuthorization>;

/// <summary>The provider URL and the nonce the endpoint sets in its cookie.</summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1056:URI-like properties should not be strings", Justification = "The URL is handed to the browser as a string.")]
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1054:URI-like parameters should not be strings", Justification = "The URL is handed to the browser as a string.")]
public sealed record CalendarAuthorization(string AuthorizationUrl, string Nonce, DateTimeOffset ExpiresAt, bool SecureCookie);

/// <summary>Disconnects an account: best-effort upstream revoke, tokens dropped, links stopped.</summary>
public sealed record DeleteCalendarConnection(Guid ConnectionId) : ICommand<bool>;

/// <summary>Lists a connection's calendars.</summary>
public sealed record ListExternalCalendars(Guid ConnectionId) : ICommand<ExternalCalendarsResponse>;

/// <summary>Lists the caller's links, optionally in one workspace.</summary>
public sealed record ListCalendarLinks(Guid? WorkspaceId) : ICommand<CalendarLinksResponse>;

/// <summary>Creates a link.</summary>
public sealed record CreateCalendarLink(CreateCalendarLinkRequest Request) : ICommand<CalendarLinkResponse>;

/// <summary>Changes a link.</summary>
public sealed record UpdateCalendarLink(Guid LinkId, UpdateCalendarLinkRequest Request) : ICommand<CalendarLinkResponse>;

/// <summary>
/// Deletes a link. Its container and events become ordinary items again, keeping their
/// <c>$cal_</c> keys, and are either left in place or moved to the trash as the caller chose.
/// Nothing is removed from the external calendar either way.
/// </summary>
public sealed record DeleteCalendarLink(Guid LinkId, bool TrashItems = false) : ICommand<bool>;

/// <summary>Enqueues a round now, or returns the one already queued or running.</summary>
public sealed record SyncCalendarLink(Guid LinkId, bool Full) : ICommand<SyncCalendarLinkResponse>;

/// <summary>Reads one page of a link's log.</summary>
public sealed record ListCalendarLinkLog(Guid LinkId, string? Cursor, int? Limit) : ICommand<CalendarSyncLogPageResponse>;

/// <summary>What the calendar sync handlers share.</summary>
public sealed class CalendarSyncSupport(
    ICalendarSyncStore store,
    IWorkerJobStore jobs,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    TimeProvider clock)
{
    internal NixSessionContext Context => session.Current ?? throw new InvalidOperationException("A session is required.");

    internal ICalendarSyncStore Store => store;

    internal TimeProvider Clock => clock;

    /// <summary>One of the caller's links, only while they can still read its workspace.</summary>
    internal async Task<CalendarLink?> ReadableLinkAsync(Guid linkId, CancellationToken cancellationToken)
    {
        var link = await store.GetLinkAsync(linkId, cancellationToken).ConfigureAwait(false);
        return link is not null && await permissions.CanReadWorkspaceAsync(link.WorkspaceId, cancellationToken).ConfigureAwait(false)
            ? link
            : null;
    }

    /// <summary>The job payload the Go worker decodes strictly: exactly <c>linkId</c> and <c>full</c>.</summary>
    internal static string Payload(Guid linkId, bool full) =>
        $$"""{"linkId":"{{linkId:D}}","full":{{(full ? "true" : "false")}}}""";

    /// <summary>The job the link's last round runs as, while it is still queued or running.</summary>
    internal async Task<Guid?> ActiveJobAsync(CalendarLink link, CancellationToken cancellationToken)
    {
        if (link.LastJobId is not { } jobId)
        {
            return null;
        }

        var context = Context;
        var job = await jobs.GetAsync(context.TenantId, context.PrincipalId, jobId, cancellationToken).ConfigureAwait(false);
        return job is { Status: "queued" or "running" } ? job.Id : null;
    }

    /// <summary>Enqueues a <c>calendar.sync</c> job under <paramref name="idempotencyKey"/> and records it on the link.</summary>
    internal async Task<Guid> EnqueueAsync(CalendarLink link, string idempotencyKey, bool full, CancellationToken cancellationToken)
    {
        var context = Context;
        var job = await jobs.CreateAsync(
            context.TenantId,
            context.PrincipalId,
            link.WorkspaceId,
            CalendarSyncRules.JobKind,
            idempotencyKey,
            Payload(link.Id, full),
            cancellationToken).ConfigureAwait(false);
        await store.SetLastJobAsync(link.Id, job.Id, clock.GetUtcNow(), cancellationToken).ConfigureAwait(false);
        return job.Id;
    }

    internal static CalendarLinkResponse ToResponse(CalendarLink link, string provider) => new(
        link.Id,
        link.ConnectionId,
        provider,
        link.WorkspaceId.Value,
        link.ContainerItemId.Value,
        link.ExternalCalendarId,
        link.Name,
        link.Direction,
        link.WindowPastDays,
        link.WindowFutureDays,
        link.Status,
        link.LastSyncedAt,
        link.LastError,
        link.Revision);

    internal static CalendarConnectionResponse ToResponse(CalendarConnection connection) => new(
        connection.Id,
        connection.Provider,
        connection.AccountEmail,
        connection.Status,
        connection.Scopes.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
        connection.CreatedAt,
        connection.LastError);

    internal static NixError? AccessError(CalendarAccessStatus status) => status switch
    {
        CalendarAccessStatus.Ok => null,
        CalendarAccessStatus.NeedsReauth => CalendarSyncErrors.NeedsReauth,
        CalendarAccessStatus.ConnectionInactive => CalendarSyncErrors.ConnectionNotFound,
        _ => CalendarSyncErrors.ProviderUnavailable(),
    };
}

/// <summary>Handles <see cref="ListCalendarConnections"/>.</summary>
public sealed class ListCalendarConnectionsHandler(CalendarSyncSupport support, CalendarProviderSettings settings)
    : ICommandHandler<ListCalendarConnections, CalendarConnectionsResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<CalendarConnectionsResponse>> HandleAsync(ListCalendarConnections command, CancellationToken cancellationToken)
    {
        var connections = await support.Store.ListConnectionsAsync(cancellationToken).ConfigureAwait(false);
        return Result.Success(new CalendarConnectionsResponse(
            [.. CalendarProviderSettings.Providers.Select(provider => new CalendarProviderResponse(provider, settings.IsAvailable(provider)))],
            [.. connections.Select(CalendarSyncSupport.ToResponse)]));
    }
}

/// <summary>
/// Handles <see cref="AuthorizeCalendarConnection"/> (Amendment 1 A1) [SEC]: builds the provider
/// URL with PKCE S256 and a Data Protection-protected state bound to this principal, tenant and
/// provider, and a nonce the endpoint puts in an HttpOnly cookie only the callback receives.
/// </summary>
public sealed class AuthorizeCalendarConnectionHandler(
    CalendarSyncSupport support,
    CalendarProviderSettings settings,
    CalendarTokenProtector protector)
    : ICommandHandler<AuthorizeCalendarConnection, CalendarAuthorization>
{
    /// <summary>The Google scopes requested.</summary>
    public const string GoogleScopes =
        "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly";

    /// <inheritdoc />
    public async ValueTask<Result<CalendarAuthorization>> HandleAsync(AuthorizeCalendarConnection command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (settings.For(command.Provider) is not { } endpoints)
        {
            return Result.Failure<CalendarAuthorization>(CalendarSyncErrors.ProviderUnavailable(CalendarSyncErrors.NotConfiguredMessage));
        }

        var context = support.Context;
        var personal = await support.Store.PersonalWorkspaceAsync(cancellationToken).ConfigureAwait(false);
        var fallback = personal is { } workspace
            ? $"/w/{workspace.Value:D}/settings?tab=integrations"
            : "/settings?tab=integrations";
        var issued = support.Clock.GetUtcNow();
        var nonce = Random();
        var verifier = Random();
        var challenge = Base64Url.EncodeToString(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        var payload = new CalendarOAuthStatePayload(
            nonce,
            context.TenantId.Value,
            context.PrincipalId.Value,
            command.Provider,
            verifier,
            issued,
            ReturnToPath.Sanitize(command.ReturnTo, fallback));
        var state = protector.ProtectState(CalendarOAuthState.Encode(payload), CalendarOAuthState.Lifetime);
        var redirect = settings.RedirectUri(command.Provider).AbsoluteUri;

        var query = command.Provider == "google"
            ? QueryString.Create(new KeyValuePair<string, string?>[]
            {
                new("client_id", endpoints.ClientId),
                new("redirect_uri", redirect),
                new("response_type", "code"),
                new("scope", GoogleScopes),
                new("access_type", "offline"),
                new("prompt", "consent"),
                new("include_granted_scopes", "false"),
                new("code_challenge", challenge),
                new("code_challenge_method", "S256"),
                new("state", state),
            })
            : QueryString.Create(new KeyValuePair<string, string?>[]
            {
                new("client_id", endpoints.ClientId),
                new("redirect_uri", redirect),
                new("response_type", "code"),
                new("response_mode", "query"),
                new("scope", MicrosoftCalendarProviderClient.Scopes),
                new("prompt", "select_account"),
                new("code_challenge", challenge),
                new("code_challenge_method", "S256"),
                new("state", state),
            });
        var path = command.Provider == "google" ? "/o/oauth2/v2/auth" : $"/{endpoints.Tenant}/oauth2/v2.0/authorize";
        var url = new Uri(endpoints.AuthorizeOrigin, path).AbsoluteUri + query;
        return Result.Success(new CalendarAuthorization(url, nonce, issued + CalendarOAuthState.Lifetime, settings.SecureCookies));
    }

    private static string Random() => Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
}

/// <summary>Handles <see cref="DeleteCalendarConnection"/>.</summary>
public sealed class DeleteCalendarConnectionHandler(
    CalendarSyncSupport support,
    CalendarProviderClients providers,
    CalendarTokenProtector protector)
    : ICommandHandler<DeleteCalendarConnection, bool>
{
    /// <inheritdoc />
    public async ValueTask<Result<bool>> HandleAsync(DeleteCalendarConnection command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var connection = await support.Store.GetConnectionAsync(command.ConnectionId, cancellationToken).ConfigureAwait(false);
        if (connection is null)
        {
            return Result.Failure<bool>(CalendarSyncErrors.ConnectionNotFound);
        }

        // Best effort upstream: a provider that is down, a key that is gone, or Microsoft (which has
        // no per-grant revoke) never keeps the grant alive here.
        if (connection.RefreshTokenProtected is { } protectedRefresh && providers.For(connection.Provider) is { } client)
        {
            try
            {
                await client.RevokeAsync(protector.UnprotectRefreshToken(protectedRefresh), cancellationToken).ConfigureAwait(false);
            }
            catch (CryptographicException)
            {
            }
            catch (CalendarProviderUnavailableException)
            {
            }
        }

        await support.Store.RevokeConnectionAsync(connection.Id, support.Clock.GetUtcNow(), cancellationToken).ConfigureAwait(false);
        return Result.Success(true);
    }
}

/// <summary>Handles <see cref="ListExternalCalendars"/>.</summary>
public sealed class ListExternalCalendarsHandler(
    CalendarSyncSupport support,
    CalendarAccessTokens tokens,
    CalendarProviderClients providers)
    : ICommandHandler<ListExternalCalendars, ExternalCalendarsResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<ExternalCalendarsResponse>> HandleAsync(ListExternalCalendars command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var connection = await support.Store.GetConnectionAsync(command.ConnectionId, cancellationToken).ConfigureAwait(false);
        if (connection is null || connection.Status == "revoked")
        {
            return Result.Failure<ExternalCalendarsResponse>(CalendarSyncErrors.ConnectionNotFound);
        }

        var listed = await ListAsync(support, tokens, providers, connection, cancellationToken).ConfigureAwait(false);
        return listed.IsFailure
            ? Result.Failure<ExternalCalendarsResponse>(listed.Error)
            : Result.Success(new ExternalCalendarsResponse(
                [.. listed.Value.Select(calendar => new ExternalCalendarResponse(calendar.Id, calendar.Name, calendar.Primary, calendar.ReadOnly))]));
    }

    internal static async Task<Result<IReadOnlyList<ExternalCalendar>>> ListAsync(
        CalendarSyncSupport support,
        CalendarAccessTokens tokens,
        CalendarProviderClients providers,
        CalendarConnection connection,
        CancellationToken cancellationToken)
    {
        if (providers.For(connection.Provider) is not { } client)
        {
            return Result.Failure<IReadOnlyList<ExternalCalendar>>(CalendarSyncErrors.ProviderUnavailable());
        }

        var access = await tokens.AcquireAsync(support.Context, connection.Id, null, cancellationToken).ConfigureAwait(false);
        if (CalendarSyncSupport.AccessError(access.Status) is { } error)
        {
            return Result.Failure<IReadOnlyList<ExternalCalendar>>(error);
        }

        try
        {
            return Result.Success(await client.ListCalendarsAsync(access.AccessToken!, cancellationToken).ConfigureAwait(false));
        }
        catch (CalendarProviderUnavailableException)
        {
            return Result.Failure<IReadOnlyList<ExternalCalendar>>(CalendarSyncErrors.ProviderUnavailable());
        }
    }
}

/// <summary>Handles <see cref="ListCalendarLinks"/>: the caller's own links in workspaces they can still read.</summary>
public sealed class ListCalendarLinksHandler(CalendarSyncSupport support, IPermissionResolver permissions)
    : ICommandHandler<ListCalendarLinks, CalendarLinksResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<CalendarLinksResponse>> HandleAsync(ListCalendarLinks command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        WorkspaceId? workspace = command.WorkspaceId is { } id ? WorkspaceId.From(id) : null;
        if (workspace is { } requested && !await permissions.CanReadWorkspaceAsync(requested, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<CalendarLinksResponse>(CalendarSyncErrors.ContainerNotFound);
        }

        var readable = (await permissions.ReadableWorkspacesAsync(cancellationToken).ConfigureAwait(false)).ToHashSet();
        var links = await support.Store.ListLinksAsync(workspace, cancellationToken).ConfigureAwait(false);
        var connections = (await support.Store.ListConnectionsAsync(cancellationToken).ConfigureAwait(false))
            .ToDictionary(connection => connection.Id, connection => connection.Provider);
        return Result.Success(new CalendarLinksResponse(
            [.. links
                .Where(link => readable.Contains(link.WorkspaceId))
                .Select(link => CalendarSyncSupport.ToResponse(link, connections.GetValueOrDefault(link.ConnectionId, string.Empty)))]));
    }
}

/// <summary>
/// Handles <see cref="CreateCalendarLink"/>. The owner must be able to write the container at link
/// time (and, the dispatcher re-checks, at every fire): in a shared workspace a two-way link pushes
/// what any member writes there to the owner's external calendar (Amendment 1 A7).
/// </summary>
public sealed class CreateCalendarLinkHandler(
    CalendarSyncSupport support,
    CalendarAccessTokens tokens,
    CalendarProviderClients providers,
    IPermissionResolver permissions,
    IItemTree tree,
    ISchemaResolver schemas,
    IItemLocks locks,
    NixDispatcher dispatcher)
    : ICommandHandler<CreateCalendarLink, CalendarLinkResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<CalendarLinkResponse>> HandleAsync(CreateCalendarLink command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var request = command.Request;
        if (request is null)
        {
            return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.Invalid("A link is required."));
        }

        if (CalendarLinkValidation.Validate(request) is { } invalid)
        {
            return Result.Failure<CalendarLinkResponse>(invalid);
        }

        var workspaceId = WorkspaceId.From(request.WorkspaceId);
        if (!await tree.WorkspaceExistsAsync(workspaceId, cancellationToken).ConfigureAwait(false)
            || !await permissions.CanWriteWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.ContainerNotFound);
        }

        var connection = await support.Store.GetConnectionAsync(request.ConnectionId, cancellationToken).ConfigureAwait(false);
        if (connection is null || connection.Status == "revoked")
        {
            return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.ConnectionNotFound);
        }

        if (connection.Status != "active")
        {
            return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.NeedsReauth);
        }

        var listed = await ListExternalCalendarsHandler.ListAsync(support, tokens, providers, connection, cancellationToken).ConfigureAwait(false);
        if (listed.IsFailure)
        {
            return Result.Failure<CalendarLinkResponse>(listed.Error);
        }

        var calendar = listed.Value.FirstOrDefault(entry => string.Equals(entry.Id, request.ExternalCalendarId, StringComparison.Ordinal));
        if (calendar is null)
        {
            return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.CalendarNotFound);
        }

        if (calendar.ReadOnly && request.Direction == "two_way")
        {
            return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.Invalid(
                "direction: a calendar the account cannot write to can only be linked import_only"));
        }

        var container = await ContainerAsync(workspaceId, request.Container, cancellationToken).ConfigureAwait(false);
        if (container.IsFailure)
        {
            return Result.Failure<CalendarLinkResponse>(container.Error);
        }

        var context = support.Context;
        var now = support.Clock.GetUtcNow();
        var link = new CalendarLink
        {
            TenantId = context.TenantId,
            Id = Guid.CreateVersion7(),
            PrincipalId = context.PrincipalId,
            ConnectionId = connection.Id,
            WorkspaceId = workspaceId,
            ContainerItemId = container.Value,
            ExternalCalendarId = calendar.Id,
            Name = CalendarSyncRules.Bound(string.IsNullOrWhiteSpace(calendar.Name) ? calendar.Id : calendar.Name, 200),
            Direction = request.Direction,
            WindowPastDays = (short)(request.WindowPastDays ?? 30),
            WindowFutureDays = (short)(request.WindowFutureDays ?? 365),
            Status = "active",
            Revision = 1,
            CreatedAt = now,
            UpdatedAt = now,
        };
        switch (await support.Store.InsertLinkAsync(link, cancellationToken).ConfigureAwait(false))
        {
            case CalendarLinkWrite.Exists:
                return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.LinkExists);
            case CalendarLinkWrite.ContainerMissing:
                return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.ContainerNotFound);
        }

        var jobId = await support.EnqueueAsync(link, CalendarSyncRules.NowJobKey(link.Id, now, full: true), full: true, cancellationToken)
            .ConfigureAwait(false);
        return Result.Success(CalendarSyncSupport.ToResponse(link with { LastJobId = jobId }, connection.Provider));
    }

    /// <summary>
    /// Resolves the container: an existing item gains the sync keys it lacks (a key it declares with
    /// another type is a conflict), or a new structured item is created with the calendar schema.
    /// </summary>
    private async Task<Result<ItemId>> ContainerAsync(
        WorkspaceId workspaceId, CalendarLinkContainerRequest request, CancellationToken cancellationToken)
    {
        if (request.ItemId is { } existingId)
        {
            var existing = await tree.FindAsync(ItemId.From(existingId), cancellationToken).ConfigureAwait(false);
            if (existing is null || existing.WorkspaceId != workspaceId || existing.LifecycleState != ItemLifecycleState.Active
                || existing.TemplateId is not null)
            {
                return Result.Failure<ItemId>(CalendarSyncErrors.ContainerNotFound);
            }

            if (await IsLockedAsync(existing.Id, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<ItemId>(CalendarSyncErrors.ContainerNotFound);
            }

            var effective = await schemas.ResolveForChildrenAsync(existing.Id, cancellationToken).ConfigureAwait(false);
            var missing = ImmutableArray.CreateBuilder<PropertyDefinition>();
            foreach (var property in CalendarContainerSchema.Properties)
            {
                if (effective.Find(property.Key) is { } declared)
                {
                    if (declared.Type != property.Type)
                    {
                        return Result.Failure<ItemId>(CalendarSyncErrors.ContainerSchemaConflict(property.Key));
                    }
                }
                else
                {
                    missing.Add(property);
                }
            }

            var hasView = ViewDefinitionsJson.Read(existing.Views).Views.Any(view => view.Kind == ViewKind.Calendar
                && string.Equals(view.DateProperty, CalendarContainerSchema.StartKey, StringComparison.Ordinal))
                || ViewDefinitionsJson.Read(existing.Views).Views.Any(view => string.Equals(view.Id, CalendarContainerSchema.ViewId, StringComparison.Ordinal));
            if (missing.Count > 0 || !hasView)
            {
                var appended = await dispatcher.SendAsync<AppendViewSetup, Item>(
                    new AppendViewSetup(existing.Id, missing.ToImmutable(), hasView ? [] : [CalendarContainerSchema.CalendarView], MakeDefault: false),
                    cancellationToken).ConfigureAwait(false);
                if (appended.IsFailure)
                {
                    return Result.Failure<ItemId>(CalendarSyncErrors.ContainerSchemaConflict(appended.Error.Message));
                }
            }

            return Result.Success(existing.Id);
        }

        var create = request.Create!;
        ItemId? parent = create.ParentId is { } parentId ? ItemId.From(parentId) : null;
        if (parent is { } parentItem && await IsLockedAsync(parentItem, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemId>(CalendarSyncErrors.ContainerNotFound);
        }

        var created = await dispatcher.SendAsync<CreateStructuredItem, Item>(
            new CreateStructuredItem(
                workspaceId,
                "folder",
                create.Title.Trim(),
                parent,
                CalendarContainerSchema.Schema,
                [CalendarContainerSchema.CalendarView],
                CalendarContainerSchema.ViewId),
            cancellationToken).ConfigureAwait(false);
        return created.IsFailure
            ? Result.Failure<ItemId>(CalendarSyncErrors.ContainerNotFound)
            : Result.Success(created.Value.Id);
    }

    private async Task<bool> IsLockedAsync(ItemId itemId, CancellationToken cancellationToken) =>
        (await locks.LockedAmongAsync([itemId], cancellationToken).ConfigureAwait(false)).Contains(itemId);
}

/// <summary>
/// Handles <see cref="UpdateCalendarLink"/>. Switching to <c>two_way</c> re-reads the external
/// calendar, as creating a link does: one the account cannot write to stays <c>import_only</c>.
/// </summary>
public sealed class UpdateCalendarLinkHandler(
    CalendarSyncSupport support,
    IPermissionResolver permissions,
    CalendarAccessTokens tokens,
    CalendarProviderClients providers)
    : ICommandHandler<UpdateCalendarLink, CalendarLinkResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<CalendarLinkResponse>> HandleAsync(UpdateCalendarLink command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var request = command.Request;
        if (request is null)
        {
            return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.Invalid("A change is required."));
        }

        var link = await support.ReadableLinkAsync(command.LinkId, cancellationToken).ConfigureAwait(false);
        if (link is null)
        {
            return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.LinkNotFound);
        }

        if (!await permissions.CanWriteWorkspaceAsync(link.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.LinkNotFound);
        }

        var name = request.Name?.Trim() ?? link.Name;
        var direction = request.Direction ?? link.Direction;
        var status = request.Status ?? link.Status;
        var past = request.WindowPastDays ?? link.WindowPastDays;
        var future = request.WindowFutureDays ?? link.WindowFutureDays;
        if (name.Length is < 1 or > 200)
        {
            return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.Invalid("name: 1 to 200 characters"));
        }

        if (direction is not ("two_way" or "import_only"))
        {
            return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.Invalid("direction: two_way or import_only"));
        }

        if (request.Status is not null and not ("active" or "paused"))
        {
            return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.Invalid("status: active or paused"));
        }

        if (past is < 0 or > 365 || future is < 1 or > 730)
        {
            return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.Invalid("windowPastDays: 0 to 365; windowFutureDays: 1 to 730"));
        }

        var connection = await support.Store.GetConnectionAsync(link.ConnectionId, cancellationToken).ConfigureAwait(false);
        if (status == "active" && link.Status != "active" && connection?.Status != "active")
        {
            return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.NeedsReauth);
        }

        if (direction == "two_way" && link.Direction != "two_way")
        {
            if (connection is null || connection.Status == "revoked")
            {
                return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.ConnectionNotFound);
            }

            var listed = await ListExternalCalendarsHandler.ListAsync(support, tokens, providers, connection, cancellationToken).ConfigureAwait(false);
            if (listed.IsFailure)
            {
                return Result.Failure<CalendarLinkResponse>(listed.Error);
            }

            var calendar = listed.Value.FirstOrDefault(entry => string.Equals(entry.Id, link.ExternalCalendarId, StringComparison.Ordinal));
            if (calendar is null)
            {
                return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.CalendarNotFound);
            }

            if (calendar.ReadOnly)
            {
                return Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.Invalid(
                    "direction: a calendar the account cannot write to can only be linked import_only"));
            }
        }

        var updated = await support.Store.UpdateLinkAsync(
            link.Id, request.Revision, name, direction, status, (short)past, (short)future, support.Clock.GetUtcNow(), cancellationToken)
            .ConfigureAwait(false);
        return updated is null
            ? Result.Failure<CalendarLinkResponse>(CalendarSyncErrors.Conflict)
            : Result.Success(CalendarSyncSupport.ToResponse(updated, connection?.Provider ?? string.Empty));
    }
}

/// <summary>Handles <see cref="DeleteCalendarLink"/>.</summary>
public sealed class DeleteCalendarLinkHandler(CalendarSyncSupport support, NixDispatcher dispatcher, IItemProtections protections) : ICommandHandler<DeleteCalendarLink, bool>
{
    /// <inheritdoc />
    public async ValueTask<Result<bool>> HandleAsync(DeleteCalendarLink command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var link = await support.ReadableLinkAsync(command.LinkId, cancellationToken).ConfigureAwait(false);
        if (link is null)
        {
            return Result.Failure<bool>(CalendarSyncErrors.LinkNotFound);
        }

        // Asked before anything is undone: trashing the container would hide a note somebody
        // protected inside it, and an unlink that then quietly kept everything would not be the
        // answer the caller chose.
        if (command.TrashItems
            && await protections.AnyDeleteProtectedBelowAsync(link.ContainerItemId, userOnly: true, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<bool>(CalendarSyncErrors.Invalid(
                "items: a note inside this calendar is protected from deletion; remove the protection or keep the notes"));
        }

        if (!await support.Store.DeleteLinkAsync(link.Id, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<bool>(CalendarSyncErrors.LinkNotFound);
        }

        // The link goes first, so trashing the container cannot be read as "the user deleted these
        // events" and pushed upstream. With the link gone the container is an ordinary item, and
        // the trash is the ordinary one: a single flag, undone from the trash.
        if (!command.TrashItems)
        {
            return Result.Success(false);
        }

        var trashed = await dispatcher
            .SendAsync<Nix.Features.Items.DeleteItem, ItemId>(new Nix.Features.Items.DeleteItem(link.ContainerItemId), cancellationToken)
            .ConfigureAwait(false);
        return Result.Success(trashed.IsSuccess);
    }
}

/// <summary>The containers in a workspace that have a calendar linked into them, for its administrators.</summary>
public sealed record ListWorkspaceCalendarLinks(WorkspaceId WorkspaceId) : ICommand<WorkspaceCalendarLinksResponse>;

/// <summary>
/// Unlinks the calendar on a container on behalf of a workspace owner or tenant administrator,
/// whoever linked it. The items are kept or trashed exactly as an owner's own unlink does.
/// </summary>
public sealed record UnlinkWorkspaceCalendar(WorkspaceId WorkspaceId, ItemId ContainerItemId, bool TrashItems) : ICommand<bool>;

/// <summary>Handles <see cref="ListWorkspaceCalendarLinks"/>.</summary>
public sealed class ListWorkspaceCalendarLinksHandler(CalendarSyncSupport support, IPermissionResolver permissions)
    : ICommandHandler<ListWorkspaceCalendarLinks, WorkspaceCalendarLinksResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<WorkspaceCalendarLinksResponse>> HandleAsync(ListWorkspaceCalendarLinks command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        // Not found rather than forbidden, like every other workspace the caller may not manage.
        if (!await permissions.CanManageWorkspaceAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<WorkspaceCalendarLinksResponse>(CalendarSyncErrors.LinkNotFound);
        }

        var containers = await support.Store.ListLinkedContainersAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false);
        return Result.Success(new WorkspaceCalendarLinksResponse(
            [.. containers.Select(item => new WorkspaceCalendarLinkResponse(item.Id.Value, ItemProperties.ReadTitle(item.Properties)))]));
    }
}

/// <summary>Handles <see cref="UnlinkWorkspaceCalendar"/>.</summary>
/// <remarks>
/// [SEC] The one place a link is removed by somebody other than its owner. A linked container is
/// undeletable for the whole workspace, so without this a member who linked one could hold a
/// folder, and everything above it, beyond the reach of the workspace's own owner. The right is
/// the one that already governs workspace-level integrations, not ordinary write access.
/// </remarks>
public sealed class UnlinkWorkspaceCalendarHandler(
    CalendarSyncSupport support,
    IPermissionResolver permissions,
    IItemProtections protections,
    NixDispatcher dispatcher) : ICommandHandler<UnlinkWorkspaceCalendar, bool>
{
    /// <inheritdoc />
    public async ValueTask<Result<bool>> HandleAsync(UnlinkWorkspaceCalendar command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        if (!await permissions.CanManageWorkspaceAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<bool>(CalendarSyncErrors.LinkNotFound);
        }

        if (command.TrashItems
            && await protections.AnyDeleteProtectedBelowAsync(command.ContainerItemId, userOnly: true, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<bool>(CalendarSyncErrors.Invalid(
                "items: a note inside this calendar is protected from deletion; remove the protection or keep the notes"));
        }

        if (!await support.Store.UnlinkContainerAsync(command.WorkspaceId, command.ContainerItemId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<bool>(CalendarSyncErrors.LinkNotFound);
        }

        if (!command.TrashItems)
        {
            return Result.Success(false);
        }

        var trashed = await dispatcher
            .SendAsync<Nix.Features.Items.DeleteItem, ItemId>(new Nix.Features.Items.DeleteItem(command.ContainerItemId), cancellationToken)
            .ConfigureAwait(false);
        return Result.Success(trashed.IsSuccess);
    }
}

/// <summary>Handles <see cref="SyncCalendarLink"/>: coalesces onto a queued or running round.</summary>
public sealed class SyncCalendarLinkHandler(CalendarSyncSupport support, IPermissionResolver permissions)
    : ICommandHandler<SyncCalendarLink, SyncCalendarLinkResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<SyncCalendarLinkResponse>> HandleAsync(SyncCalendarLink command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var readable = await support.ReadableLinkAsync(command.LinkId, cancellationToken).ConfigureAwait(false);
        if (readable is null || !await permissions.CanWriteWorkspaceAsync(readable.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<SyncCalendarLinkResponse>(CalendarSyncErrors.LinkNotFound);
        }

        // Locked until the request commits, so checking for a running round and enqueueing one is
        // atomic against a trigger firing for the same link at the same moment.
        var link = await support.Store.LockLinkAsync(readable.Id, cancellationToken).ConfigureAwait(false);
        if (link is null)
        {
            return Result.Failure<SyncCalendarLinkResponse>(CalendarSyncErrors.LinkNotFound);
        }

        if (link.Status is not ("active" or "error"))
        {
            return Result.Failure<SyncCalendarLinkResponse>(CalendarSyncErrors.LinkInactive);
        }

        var connection = await support.Store.GetConnectionAsync(link.ConnectionId, cancellationToken).ConfigureAwait(false);
        if (connection is not { Status: "active" })
        {
            return Result.Failure<SyncCalendarLinkResponse>(CalendarSyncErrors.NeedsReauth);
        }

        if (await support.ActiveJobAsync(link, cancellationToken).ConfigureAwait(false) is { } running)
        {
            return Result.Success(new SyncCalendarLinkResponse(running));
        }

        var jobId = await support.EnqueueAsync(
            link, CalendarSyncRules.NowJobKey(link.Id, support.Clock.GetUtcNow(), command.Full), command.Full, cancellationToken)
            .ConfigureAwait(false);
        return Result.Success(new SyncCalendarLinkResponse(jobId));
    }
}

/// <summary>Handles <see cref="ListCalendarLinkLog"/>.</summary>
public sealed class ListCalendarLinkLogHandler(CalendarSyncSupport support) : ICommandHandler<ListCalendarLinkLog, CalendarSyncLogPageResponse>
{
    private const int DefaultLimit = 50;

    /// <inheritdoc />
    public async ValueTask<Result<CalendarSyncLogPageResponse>> HandleAsync(ListCalendarLinkLog command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var link = await support.ReadableLinkAsync(command.LinkId, cancellationToken).ConfigureAwait(false);
        if (link is null)
        {
            return Result.Failure<CalendarSyncLogPageResponse>(CalendarSyncErrors.LinkNotFound);
        }

        var limit = Math.Clamp(command.Limit ?? DefaultLimit, 1, 100);
        var cursor = LogCursor.Decode(command.Cursor);
        var rows = await support.Store.ReadLogAsync(link.Id, cursor?.At, cursor?.Id, limit + 1, cancellationToken).ConfigureAwait(false);
        var page = rows.Take(limit).ToList();
        var next = rows.Count > limit ? LogCursor.Encode(page[^1].At, page[^1].Id) : null;
        return Result.Success(new CalendarSyncLogPageResponse(
            [.. page.Select(row => new CalendarSyncLogEntryResponse(row.Id, row.At, row.Direction, row.Action, row.ItemId, row.ExternalEventId, row.Detail))],
            next));
    }
}

/// <summary>Shape checks for a new link.</summary>
internal static class CalendarLinkValidation
{
    internal static NixError? Validate(CreateCalendarLinkRequest request)
    {
        if (request.ConnectionId == Guid.Empty || request.WorkspaceId == Guid.Empty)
        {
            return CalendarSyncErrors.Invalid("connectionId and workspaceId are required");
        }

        if (string.IsNullOrWhiteSpace(request.ExternalCalendarId) || request.ExternalCalendarId.Length > 500)
        {
            return CalendarSyncErrors.Invalid("externalCalendarId: 1 to 500 characters");
        }

        if (request.Direction is not ("two_way" or "import_only"))
        {
            return CalendarSyncErrors.Invalid("direction: two_way or import_only");
        }

        if (request.WindowPastDays is < 0 or > 365 || request.WindowFutureDays is < 1 or > 730)
        {
            return CalendarSyncErrors.Invalid("windowPastDays: 0 to 365; windowFutureDays: 1 to 730");
        }

        var container = request.Container;
        if (container is null || (container.ItemId is null) == (container.Create is null))
        {
            return CalendarSyncErrors.Invalid("container: exactly one of itemId or create");
        }

        if (container.Create is { } create && (string.IsNullOrWhiteSpace(create.Title) || create.Title.Trim().Length > 200))
        {
            return CalendarSyncErrors.Invalid("container.create.title: 1 to 200 characters");
        }

        return null;
    }
}
