using System.Diagnostics.CodeAnalysis;
using Nix.Abstractions;
using Nix.Abstractions.Calendar;
using Nix.Domain.Tenancy;
using Nix.Features.CalendarSync;

namespace Nix.Features.Connections;

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class ConnectorCalendars(
    ICalendarSyncStore calendars, CalendarAccessTokens access, INixSessionContextAccessor session)
{
    internal async Task<IReadOnlyList<ConnectorCalendarLink>> ListAsync(WorkspaceId workspace, CancellationToken token)
    {
        var links = await calendars.ListLinksAsync(workspace, token).ConfigureAwait(false);
        var providers = (await calendars.ListConnectionsAsync(token).ConfigureAwait(false))
            .Where(row => row.Status == "active").ToDictionary(row => row.Id, row => row.Provider);
        return [.. links.Where(link => link.Status == "active" && providers.ContainsKey(link.ConnectionId))
            .Select(link => new ConnectorCalendarLink(link.Id, providers[link.ConnectionId], link.ExternalCalendarId,
                link.Name, link.Direction == "two_way"))];
    }

    internal async Task<Guid?> CheckAsync(
        WorkspaceId workspace, Guid linkId, string provider, string resource, bool write, CancellationToken token)
    {
        var link = await calendars.GetLinkAsync(linkId, token).ConfigureAwait(false);
        if (link is not { Status: "active" } || link.WorkspaceId != workspace || link.ExternalCalendarId != resource
            || (write && link.Direction != "two_way")
            || await calendars.GetConnectionAsync(link.ConnectionId, token).ConfigureAwait(false) is not { Status: "active" } connection
            || connection.Provider != provider)
        {
            return null;
        }
        return connection.Id;
    }

    internal async Task<string?> AcquireAsync(
        WorkspaceId workspace, Guid linkId, string provider, string resource, bool write, CancellationToken token)
    {
        var context = session.Current;
        var connectionId = await CheckAsync(workspace, linkId, provider, resource, write, token).ConfigureAwait(false);
        if (context is null || connectionId is null)
        {
            return null;
        }
        var grant = await access.AcquireAsync(context.Value, connectionId.Value, workspace, token).ConfigureAwait(false);
        return grant.Status == CalendarAccessStatus.Ok ? grant.AccessToken : null;
    }
}
