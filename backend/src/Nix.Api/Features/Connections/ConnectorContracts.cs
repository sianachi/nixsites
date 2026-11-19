using System.Text.Json;
using System.Text.Json.Serialization;
using Nix.Domain.Primitives;

namespace Nix.Features.Connections;

internal sealed record ConnectorActionDefinition(
    string Id, string Provider, string ResourceKind, string Kind, string Description,
    JsonElement Schema, string SchemaHash, bool Configured);
internal sealed record ConnectorConnection(
    Guid Id, string Provider, string ResourceKind, string ResourceId, IReadOnlyList<string> Actions, Guid Revision);
internal sealed record ConnectorCalendarLink(Guid LinkId, string Provider, string ResourceId, string Name, bool Writable);
internal sealed record ConnectorAvailableAction(
    Guid ConnectionId, Guid ConnectionRevision, string Provider, string Resource, string Action, string Kind, JsonElement? Schema);
internal sealed record ConnectorList(
    bool Enabled, IReadOnlyList<ConnectorConnection> Connections, IReadOnlyList<ConnectorActionDefinition> Actions,
    IReadOnlyList<ConnectorCalendarLink> Calendars);
internal sealed record AuthorizePetConnectionRequest(
    string Provider, string ResourceKind, string ResourceId, string[] Actions, string? ReturnTo, Guid? CalendarLinkId = null);
internal sealed record AuthorizePetConnectionResponse(string AuthorizationUrl);
internal sealed record RegisterPetMcpConnectionRequest(string Url, string Tool, string Token);
internal sealed record RegisteredMcpTool(string Url, string Tool, JsonElement Schema, string SchemaHash);

internal sealed record PreparedConnectorAction(
    Guid ConnectionId, Guid ConnectionRevision, string Action, string Kind, string ResourceId,
    string Destination, string SchemaHash, JsonElement Arguments);

internal sealed record ConnectorWorkerRequest(
    string Operation, string? Action = null, string? ResourceId = null,
    JsonElement? Args = null, string? SchemaHash = null, string? AccessToken = null, Guid? ExecutionId = null);
internal sealed record ConnectorWorkerResponse(
    ConnectorActionDefinition[]? Actions, JsonElement? Arguments, string? SchemaHash, JsonElement? Result, string? Failure);
internal sealed record ConnectorCredential(
    string AccessToken, string? RefreshToken, DateTimeOffset? ExpiresAt,
    Guid? CalendarLinkId = null, RegisteredMcpTool? RemoteMcp = null);
internal sealed record PendingConnectorConsent(string[] Actions, string Verifier, string ReturnTo, string ClientId);

internal static class ConnectorErrors
{
    internal static NixError Missing() => new("connector.not_found", "The connection is not available in this workspace.");
    internal static NixError Invalid() => new("connector.invalid", "Check the selected connection resource and actions.");
    internal static NixError Browser() => new("connector.browser_required", "Use your signed-in browser to manage connections.");
    internal static NixError Unavailable() => new("connector.unavailable", "The provider connection is unavailable. Reconnect if needed.");
    internal static NixError Stale() => new("connector.changed", "The connection or action changed. Review a fresh proposal.");
    internal static NixError Unknown() => new("connector.unknown_outcome", "The provider might have applied the action. Check the destination before trying again.");
}

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(ConnectorList))]
[JsonSerializable(typeof(AuthorizePetConnectionRequest))]
[JsonSerializable(typeof(AuthorizePetConnectionResponse))]
[JsonSerializable(typeof(RegisterPetMcpConnectionRequest))]
[JsonSerializable(typeof(PreparedConnectorAction))]
[JsonSerializable(typeof(ConnectorWorkerRequest))]
[JsonSerializable(typeof(ConnectorWorkerResponse))]
[JsonSerializable(typeof(ConnectorCredential))]
[JsonSerializable(typeof(ConnectorAvailableAction[]))]
[JsonSerializable(typeof(PendingConnectorConsent))]
internal sealed partial class ConnectorJsonContext : JsonSerializerContext;
