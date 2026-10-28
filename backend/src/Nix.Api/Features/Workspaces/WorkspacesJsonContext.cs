using System.Text.Json.Serialization;
using Nix.Contracts;
using Nix.Features.Workspaces;

namespace Nix.Serialization;

/// <summary>
/// The workspaces feature's JSON contract, source-generated.
/// </summary>
/// <remarks>
/// One context per feature rather than one for the API, and <c>Program</c> chains them all onto
/// the serializer's resolver chain. The generated output is equivalent either way; what changes is
/// that adding a response type touches a file inside one feature instead of a file every feature
/// shares. With several goals in flight at once, a single registration point is a merge conflict
/// on every one of them - and they are the boring kind that get resolved carelessly.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WorkspaceResponse))]
[JsonSerializable(typeof(WorkspaceArrangementResponse))]
[JsonSerializable(typeof(WorkspaceArrangementInput))]
[JsonSerializable(typeof(SaveWorkspaceArrangementRequest))]
[JsonSerializable(typeof(IReadOnlyList<WorkspaceGroupDto>))]
[JsonSerializable(typeof(CursorPage<WorkspaceResponse>))]
[JsonSerializable(typeof(CreateWorkspaceRequest))]
[JsonSerializable(typeof(RenameWorkspaceRequest))]
[JsonSerializable(typeof(SetWorkspaceSharingRequest))]
[JsonSerializable(typeof(WorkspaceMemberResponse))]
[JsonSerializable(typeof(CursorPage<WorkspaceMemberResponse>))]
[JsonSerializable(typeof(WorkspacePrincipalResponse))]
[JsonSerializable(typeof(CursorPage<WorkspacePrincipalResponse>))]
[JsonSerializable(typeof(WorkspaceInvitationResponse))]
[JsonSerializable(typeof(CursorPage<WorkspaceInvitationResponse>))]
[JsonSerializable(typeof(WorkspaceInviteeResponse))]
[JsonSerializable(typeof(CursorPage<WorkspaceInviteeResponse>))]
[JsonSerializable(typeof(CreateWorkspaceInvitationRequest))]
[JsonSerializable(typeof(ChangeWorkspaceMemberRoleRequest))]
[JsonSerializable(typeof(RecoverWorkspaceRequest))]
[JsonSerializable(typeof(DailyNoteResponse))]
[JsonSerializable(typeof(DailyNoteSettingsResponse))]
[JsonSerializable(typeof(SaveDailyNoteSettingsRequest))]
internal sealed partial class WorkspacesJsonContext : JsonSerializerContext;
