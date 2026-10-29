using System.Text.Json.Serialization;

namespace Nix.Features.Pets;

/// <summary>Independent appearance and communication preferences for one companion.</summary>
/// <remarks>
/// <c>ApplyWithoutAsking</c> is the pet's default for the conversation switch that runs clean
/// changes without an approval click (moves, trash, template saves and external links still ask).
/// It is a client-side convenience with no server authority: every change still runs under the
/// owner's own permissions. Last and defaulted so stored profiles without it read as off.
/// </remarks>
public sealed record PetProfile(Guid Id, string Name, string Appearance, string Personality, string ResponseLength, string Instructions, bool ApplyWithoutAsking = false, string Provider = PetProviders.ChatGpt);

/// <summary>Account preferences. Device placement is deliberately absent.</summary>
/// <remarks>
/// <c>InlineWriting</c> is the separate opt-in for sending text the person selects in a note to
/// the model provider from the editor. It defaults to off, and settings stored before it existed
/// read as off. <c>Memories</c> are what the pet has learned about the owner, which the owner sees and
/// edits in Settings; <c>MemoryOff</c> stops them reaching the model and the pet saving more. All three
/// trail and default so a stored document without them still deserialises.
/// </remarks>
public sealed record PetSettings(bool Enabled, Guid? ActivePetId, string Motion, IReadOnlyList<PetProfile> Profiles, bool InlineWriting = false, IReadOnlyList<PetMemory>? Memories = null, bool MemoryOff = false);

/// <summary>One fact the pet saved, or the owner wrote, about the owner.</summary>
public sealed record PetMemory(Guid Id, string Text, DateTimeOffset CreatedAt);

/// <summary>The saved document and its concurrency version.</summary>
public sealed record PetSettingsResponse(long Revision, PetSettings Settings);

/// <summary>Replaces the owner's preferences only at the version they edited.</summary>
public sealed record SavePetSettingsRequest(long ExpectedRevision, PetSettings Settings);

/// <summary>Truthful provider availability without credentials or inferred entitlements.</summary>
/// <remarks>
/// <c>LockedRead</c> says the conversation's model thread holds a tool result read from under a
/// lock. The client holds every write for the owner while it is set; only a new thread clears it.
/// <c>Title</c> names the live conversation (the owner's rename, else its first message).
/// </remarks>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1054", Justification = "The wire contract uses an empty string when no device login is pending; clients allowlist the provider URL.")]
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1056", Justification = "The wire contract uses an empty string when no device login is pending; clients allowlist the provider URL.")]
public sealed record PetConnectionResponse(string Provider, string Status, string Reason, bool CanConnect,
    string VerificationUrl = "", string UserCode = "", string State = "idle", IReadOnlyList<PetMessage>? Messages = null,
    IReadOnlyList<PetModel>? Models = null, IReadOnlyList<PetToolCall>? Tools = null, IReadOnlyList<PetHistoryEntry>? History = null,
    long Revision = 0, bool LockedRead = false, string Title = "");

/// <summary>A private archived conversation in this workspace and pet.</summary>
public sealed record PetHistoryEntry(string Id, string Title, string CreatedAt);

/// <summary>A model offered by the connected Codex runtime.</summary>
public sealed record PetModel(string Id, string Name, bool Default, bool SupportsTools = true);

/// <summary>A bounded tool request and its private execution receipt.</summary>
public sealed record PetToolCall(string Id, string Arguments, string Status, string Result, string ClaimId);

/// <summary>One private conversation message. Changes the pet proposes are tool calls, never part of a message.</summary>
public sealed record PetMessage(string Id, string Role, string Text);

/// <summary>One container in the map a conversation's first message carries.</summary>
/// <param name="Id">The container item.</param>
/// <param name="Title">Its title (240 characters at most).</param>
/// <param name="Type">Its body type (64 characters at most).</param>
/// <param name="ViewKinds">The view kinds it offers, when the client knows them (12 at most, 40 characters each).</param>
public sealed record PetWorkspaceMapEntry(Guid Id, string Title, string Type, IReadOnlyList<string>? ViewKinds = null);

/// <summary>Companion operation. Identity and permissions are always derived by Core.</summary>
/// <remarks>
/// <c>Today</c> (yyyy-MM-dd in the owner's zone) and <c>TimeZone</c> (an IANA name) let the model
/// resolve relative dates; <c>WorkspaceMap</c> (at most 40 containers) is sent with a
/// conversation's first message only. <c>ToolLockedContent</c> reports, with a tool result, that the
/// result came from an item under a lock; it can only tighten what runs without asking. All of these
/// are the client's own view and never used for an authorization decision; every tool the model
/// calls is still checked against the caller's permissions.
/// <c>RootItemId</c> scopes a conversation to one readable item and its children. <c>ReadOnly</c>
/// limits the companion's tools; it never grants permission to read workspace data.
/// <c>ItemIds</c> attaches up to <see cref="PetWorkerClient.MaxSharedItems"/> items to a send, alongside
/// <c>ItemId</c>; the two are merged and de-duplicated, and each id gets the same checks. <c>SharedText</c>
/// is text the person selected in those items. <c>ReplaceFromMessageId</c> (send only) names the user
/// message the new turn replaces: the worker drops it and every message after it first.
/// <c>Text</c> is the new title for <c>rename</c>. <c>HistoryId</c> names the archive for <c>read_history</c>,
/// <c>delete_history</c> and <c>resume_history</c>, and for <c>rename</c> when it renames an archive rather
/// than the live conversation.
/// <c>ToolImage</c> (tool_result only) is a picture the result carries, a <c>data:image/jpeg;base64</c> URL of
/// at most <see cref="PetWorkerClient.MaxToolImageLength"/> characters, read by the browser from a file the
/// caller could open.
/// </remarks>
public sealed record PetRuntimeRequest(string Operation, Guid? WorkspaceId = null, Guid? PetId = null,
    Guid? RequestId = null, string Text = "", Guid? ItemId = null, string SharedText = "",
    string Model = "", bool WorkspaceAccess = false, string ToolId = "", string ToolResult = "", bool ToolSuccess = false, Guid? HistoryId = null,
    string Mode = "", string Today = "", string TimeZone = "", IReadOnlyList<PetWorkspaceMapEntry>? WorkspaceMap = null,
    bool ToolLockedContent = false, Guid? RootItemId = null, bool ReadOnly = false,
    IReadOnlyList<Guid>? ItemIds = null, Guid? ReplaceFromMessageId = null, string ToolImage = "");

/// <summary>One item attached to a turn: its id and the title Core read for it.</summary>
internal sealed record PetWorkerItem(string Id, string Title);

internal sealed record PetWorkerRequest(string TenantId, string PrincipalId, string WorkspaceId,
    string PetId, string Operation, string RequestId, string Text, string Instructions,
    string ItemId, string ItemTitle, string SharedText, string Model, bool WorkspaceAccess,
    string ToolId, string ToolResult, bool ToolSuccess, string HistoryId, string Mode, long After,
    string Today, string TimeZone, IReadOnlyList<PetWorkspaceMapEntry>? WorkspaceMap, bool ToolLockedContent,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? RootItemId,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool ReadOnly,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<PetWorkerItem>? Items,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ReplaceFromMessageId,
    // The pet's provider and, for a key provider, the owner's key: forwarded on every request
    // over the internal channel and held by the worker in memory only. Never logged.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Provider = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ApiKey = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ConversationItemId = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? SourceWorkspaceIds = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<PetMessage>? EarlierMessages = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ToolImage = null);

/// <summary>One inline writing request from the editor: the person's selection and what to do with it.</summary>
/// <param name="WorkspaceId">The workspace the item is in.</param>
/// <param name="ItemId">The item being edited; the caller must be able to read it and it must not be locked.</param>
/// <param name="RequestId">Client-chosen identity of this request, passed to the worker for tracing and de-duplication.</param>
/// <param name="Kind">One of continue, summarise, improve, fix, translate, action_items, custom.</param>
/// <param name="Selection">The material to work on (16,000 bytes of UTF-8 at most); empty only for continue and custom.</param>
/// <param name="Instruction">The person's own words; required for custom (2,000 bytes at most).</param>
/// <param name="Context">Surrounding text for orientation (32,000 bytes of UTF-8 at most).</param>
/// <param name="Language">The target language; required for translate (64 bytes at most).</param>
/// <param name="Model">An optional model identifier offered by the connected runtime.</param>
public sealed record PetInlineRequest(Guid WorkspaceId, Guid ItemId, Guid RequestId, string Kind,
    string Selection, string? Instruction = null, string? Context = null, string? Language = null, string? Model = null);

/// <summary>The worker's inline operation. Unknown fields are refused by the worker, so this is exactly its shape.</summary>
internal sealed record PetInlineWorkerRequest(string TenantId, string PrincipalId, string WorkspaceId,
    string PetId, string Operation, string RequestId, string Text, string SharedText, string ContextText,
    string InlineKind, string Language, string Model,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Provider = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ApiKey = null);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(PetSettings))]
[JsonSerializable(typeof(PetSettingsResponse))]
[JsonSerializable(typeof(SavePetSettingsRequest))]
[JsonSerializable(typeof(PetConnectionResponse))]
[JsonSerializable(typeof(PetProvidersResponse))]
[JsonSerializable(typeof(PetProviderKeyResponse))]
[JsonSerializable(typeof(SavePetProviderKeyRequest))]
[JsonSerializable(typeof(PetRuntimeRequest))]
[JsonSerializable(typeof(PetInlineRequest))]
[JsonSerializable(typeof(PetWorkerRequest))]
[JsonSerializable(typeof(PetInlineWorkerRequest))]
internal sealed partial class PetJsonContext : JsonSerializerContext;
