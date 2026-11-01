using System.Text.Json;
using System.Text.Json.Serialization;

namespace Nix.Features.Sites;

/// <summary>One link in a site's top navigation.</summary>
/// <param name="Label">The link text.</param>
/// <param name="Path">The target page path, such as <c>/guide/</c>.</param>
public sealed record SiteNavLinkDto(string Label, string Path);

/// <summary>A site's presentation settings. Also the <c>settings</c> object of the build manifest.</summary>
/// <param name="Name">The site name.</param>
/// <param name="Description">A one-line description used in meta tags.</param>
/// <param name="Accent">The accent colour as <c>#rrggbb</c>.</param>
/// <param name="Navigation">The top navigation.</param>
/// <param name="FooterText">Footer text.</param>
/// <param name="BuiltWithNix">Whether the "Built with Nix" link shows.</param>
/// <param name="Language">The language tag.</param>
/// <param name="Noindex">Whether search engines are asked to leave the whole site out. Absent means false.</param>
/// <param name="Author">The person who writes the site, for structured data; null for none.</param>
/// <param name="HeadingMark">The shape before headings and cards: <c>square</c>, <c>diamond</c> or <c>none</c>. Absent means square.</param>
/// <param name="Typeface">The type family: <c>rounded</c>, <c>serif</c> or <c>legible</c>. Absent means rounded.</param>
/// <param name="Spacing">The vertical rhythm: <c>compact</c>, <c>comfortable</c> or <c>airy</c>. Absent means comfortable.</param>
/// <param name="ThemeItemId">The page under the site root whose files are the custom layout's theme; null for none. Ignored by the docs and blog layouts.</param>
public sealed record SiteSettingsDto(
    string Name,
    string Description,
    string Accent,
    IReadOnlyList<SiteNavLinkDto> Navigation,
    string FooterText,
    bool BuiltWithNix,
    string Language,
    bool Noindex = false,
    string? Author = null,
    string HeadingMark = "square",
    string Typeface = "rounded",
    string Spacing = "comfortable",
    Guid? ThemeItemId = null);

/// <summary>A collection whose children are dated posts, with the properties the blog layout reads.</summary>
/// <param name="ItemId">The collection item.</param>
/// <param name="DateProperty">The property holding each post's publication date.</param>
/// <param name="TagsProperty">The property holding each post's tags.</param>
/// <param name="CoverProperty">The property holding each post's cover image.</param>
/// <param name="SummaryProperty">The property holding each post's summary.</param>
public sealed record SiteDatedCollectionDto(
    Guid ItemId,
    string DateProperty,
    string? TagsProperty,
    string? CoverProperty,
    string? SummaryProperty);

/// <summary>Creates a site over an item's subtree.</summary>
/// <param name="RootItemId">The item whose subtree is published.</param>
/// <param name="Slug">The label of the default hostname.</param>
/// <param name="Layout">The theme layout: <c>docs</c> or <c>blog</c>.</param>
/// <param name="Settings">Presentation settings; defaults are derived from the root's title when omitted.</param>
public sealed record CreateSiteRequest(Guid RootItemId, string Slug, string Layout, SiteSettingsDto? Settings);

/// <summary>Changes a site. A field left out is left alone.</summary>
/// <param name="Settings">Presentation settings.</param>
/// <param name="Layout">The theme layout.</param>
/// <param name="RepublishMode">One of <c>manual</c>, <c>auto</c> or <c>on_release</c>.</param>
/// <param name="DebounceSeconds">The settle time before an automatic rebuild, 60 to 3600.</param>
/// <param name="ExcludedItemIds">Replaces the excluded items.</param>
/// <param name="DatedCollections">Replaces the dated collections.</param>
public sealed record UpdateSiteRequest(
    SiteSettingsDto? Settings,
    string? Layout,
    string? RepublishMode,
    int? DebounceSeconds,
    IReadOnlyList<Guid>? ExcludedItemIds,
    IReadOnlyList<SiteDatedCollectionDto>? DatedCollections);

/// <summary>Replaces a site's custom hostnames.</summary>
/// <param name="Hostnames">The custom hostnames, lowercase.</param>
public sealed record SetSiteHostnamesRequest(IReadOnlyList<string> Hostnames);

/// <summary>Requests a build.</summary>
/// <param name="IdempotencyKey">Makes a repeated request return the same build.</param>
/// <param name="RefreshPaths">Re-derives the paths of pages whose path a manager did not pin.</param>
/// <param name="AcknowledgeDisclosure">Required on the first publish: the content becomes public and may be cached or archived.</param>
public sealed record PublishSiteRequest(string IdempotencyKey, bool RefreshPaths, bool AcknowledgeDisclosure);

/// <summary>Points a site back at a previous build.</summary>
/// <param name="BuildId">The build to serve again.</param>
public sealed record RollbackSiteRequest(Guid BuildId);

/// <summary>Sets and pins one page's path.</summary>
/// <param name="Path">A lowercase slash-terminated path such as <c>/blog/hello/</c>.</param>
public sealed record SetSitePagePathRequest(string Path);

/// <summary>A hostname of a site.</summary>
/// <param name="Hostname">The hostname.</param>
/// <param name="Url">The public URL of its root.</param>
/// <param name="Kind"><c>default</c> or <c>custom</c>.</param>
/// <param name="Verified">Whether it is served; a custom hostname is pending until verified.</param>
/// <param name="Primary">Whether it is the site's primary hostname, the one canonical links name once it is served.</param>
/// <param name="ServeMode">How it answers while it is not canonical: <c>serve</c> (200) or <c>redirect</c> (308 to the canonical host).</param>
/// <param name="Status"><c>verified</c>, <c>failing</c> (verified, but the last check failed), <c>pending</c> or <c>checking</c> (never checked).</param>
/// <param name="CheckedAt">When its records were last checked.</param>
/// <param name="CheckError">A short code for what the last check found wrong, or null.</param>
/// <param name="Managed">Whether Nix creates and removes its DNS records through the operator's Cloudflare account.</param>
/// <param name="Records">The DNS records to create for a custom hostname; empty for the default one.</param>
public sealed record SiteHostnameResponse(
    string Hostname,
    Uri Url,
    string Kind,
    bool Verified,
    bool Primary,
    string ServeMode,
    string Status,
    DateTimeOffset? CheckedAt,
    string? CheckError,
    bool Managed,
    IReadOnlyList<SiteDnsRecordDto> Records);

/// <summary>One DNS record a manager creates for a custom hostname.</summary>
/// <param name="Type"><c>TXT</c> or <c>CNAME</c>.</param>
/// <param name="Name">The full record name.</param>
/// <param name="Value">The record value.</param>
/// <param name="Purpose"><c>verification</c> or <c>routing</c>.</param>
public sealed record SiteDnsRecordDto(string Type, string Name, string Value, string Purpose);

/// <summary>Attaches a custom hostname.</summary>
/// <param name="Hostname">The hostname, such as <c>docs.example.com</c> or an apex such as <c>example.com</c>.</param>
/// <param name="ServeMode"><c>serve</c> (default) or <c>redirect</c>.</param>
public sealed record AddSiteHostnameRequest(string Hostname, string? ServeMode);

/// <summary>Changes one hostname. A field left out is left alone.</summary>
/// <param name="ServeMode"><c>serve</c> or <c>redirect</c>.</param>
/// <param name="Primary">True to make it the primary hostname.</param>
public sealed record UpdateSiteHostnameRequest(string? ServeMode, bool? Primary);

/// <summary>Asks the operator to approve a site's first publish.</summary>
/// <param name="AcknowledgeDisclosure">Acknowledges that the content becomes public once approved; required.</param>
public sealed record RequestSiteApprovalRequest(bool AcknowledgeDisclosure);

/// <summary>An operator's rejection.</summary>
/// <param name="Note">Why, shown to the site's managers; at most 500 characters.</param>
public sealed record RejectSiteApprovalRequest(string? Note);

/// <summary>Where a site's first-publish approval stands.</summary>
/// <param name="State"><c>pending</c>, <c>approved</c> or <c>rejected</c>.</param>
/// <param name="RequestedAt">When a manager asked.</param>
/// <param name="DecidedAt">When the operator decided.</param>
/// <param name="Note">The operator's note.</param>
public sealed record SiteApprovalDto(string State, DateTimeOffset RequestedAt, DateTimeOffset? DecidedAt, string? Note);

/// <summary>A site waiting for, or just given, an operator's decision.</summary>
/// <param name="SiteId">The site.</param>
/// <param name="WorkspaceId">Its workspace.</param>
/// <param name="Slug">Its slug.</param>
/// <param name="Name">Its name.</param>
/// <param name="Hostnames">Its hostnames.</param>
/// <param name="RequestedBy">The manager who asked; the approved publish runs as them.</param>
/// <param name="Approval">The approval.</param>
/// <param name="Build">The build the approval queued, if any.</param>
public sealed record SiteApprovalResponse(
    Guid SiteId,
    Guid WorkspaceId,
    string Slug,
    string Name,
    IReadOnlyList<string> Hostnames,
    Guid RequestedBy,
    SiteApprovalDto Approval,
    SiteBuildResponse? Build);

/// <summary>The sites waiting for an operator.</summary>
public sealed record SiteApprovalListResponse(IReadOnlyList<SiteApprovalResponse> Approvals);

/// <summary>One person who may decide first publishes.</summary>
/// <param name="PrincipalId">Who.</param>
/// <param name="DisplayName">Their name.</param>
/// <param name="Source"><c>configured</c> (deployment configuration, not revocable here) or <c>granted</c> (Settings).</param>
/// <param name="GrantedAt">When it was granted; absent for configured operators.</param>
/// <param name="GrantedBy">Who granted it; absent for configured operators.</param>
public sealed record SiteOperatorResponse(Guid PrincipalId, string DisplayName, string Source, DateTimeOffset? GrantedAt, Guid? GrantedBy);

/// <summary>The people who may decide first publishes.</summary>
/// <param name="Operators">Configured operators first, then granted ones oldest first.</param>
public sealed record SiteOperatorListResponse(IReadOnlyList<SiteOperatorResponse> Operators);

/// <summary>A build as a manager sees it.</summary>
/// <param name="Id">The build.</param>
/// <param name="SiteId">The site.</param>
/// <param name="Status"><c>queued</c>, <c>building</c>, <c>sealed</c>, <c>live</c>, <c>superseded</c>, <c>failed</c> or <c>purged</c>.</param>
/// <param name="Origin"><c>manual</c> or <c>auto</c>.</param>
/// <param name="PageCount">Pages in the manifest.</param>
/// <param name="FileCount">Objects the worker wrote.</param>
/// <param name="TotalBytes">Bytes the worker wrote.</param>
/// <param name="Loss">What the build could not represent.</param>
/// <param name="FailureCode">Why the build failed, when it did.</param>
/// <param name="CreatedAt">When it was requested.</param>
/// <param name="ActivatedAt">When it went live.</param>
public sealed record SiteBuildResponse(
    Guid Id,
    Guid SiteId,
    string Status,
    string Origin,
    int PageCount,
    int FileCount,
    long TotalBytes,
    IReadOnlyList<string> Loss,
    string? FailureCode,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ActivatedAt);

/// <summary>A site as a reader of its workspace sees it.</summary>
/// <param name="Id">The site.</param>
/// <param name="WorkspaceId">The workspace.</param>
/// <param name="RootItemId">The root item.</param>
/// <param name="Slug">The default hostname label.</param>
/// <param name="Layout">The theme layout.</param>
/// <param name="Settings">Presentation settings.</param>
/// <param name="RepublishMode">The republish mode.</param>
/// <param name="DebounceSeconds">The automatic rebuild settle time.</param>
/// <param name="Status"><c>draft</c>, <c>published</c> or <c>unpublished</c>.</param>
/// <param name="CanManage">Whether the caller may publish, roll back and change the site.</param>
/// <param name="Hostnames">Its hostnames.</param>
/// <param name="ExcludedItemIds">The excluded items.</param>
/// <param name="DatedCollections">The dated collections.</param>
/// <param name="LiveBuild">The build being served.</param>
/// <param name="LatestBuild">The most recent build.</param>
/// <param name="CreatedAt">When the site was created.</param>
/// <param name="UpdatedAt">When it last changed.</param>
/// <param name="PrimaryHostname">The primary hostname; null means the default one.</param>
/// <param name="ApprovalRequired">Whether the next publish needs an operator's approval first.</param>
/// <param name="Approval">The latest approval request, if any.</param>
public sealed record SiteResponse(
    Guid Id,
    Guid WorkspaceId,
    Guid RootItemId,
    string Slug,
    string Layout,
    SiteSettingsDto Settings,
    string RepublishMode,
    int DebounceSeconds,
    string Status,
    bool CanManage,
    IReadOnlyList<SiteHostnameResponse> Hostnames,
    IReadOnlyList<Guid> ExcludedItemIds,
    IReadOnlyList<SiteDatedCollectionDto> DatedCollections,
    SiteBuildResponse? LiveBuild,
    SiteBuildResponse? LatestBuild,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    string? PrimaryHostname,
    bool ApprovalRequired,
    SiteApprovalDto? Approval);

/// <summary>The sites of a workspace.</summary>
/// <param name="Sites">The sites.</param>
public sealed record SiteListResponse(IReadOnlyList<SiteResponse> Sites);

/// <summary>The builds of a site, newest first.</summary>
/// <param name="Builds">The builds.</param>
public sealed record SiteBuildListResponse(IReadOnlyList<SiteBuildResponse> Builds);

/// <summary>One page of a site's path table.</summary>
/// <param name="ItemId">The item.</param>
/// <param name="Path">The published path.</param>
/// <param name="Pinned">Whether a manager chose the path.</param>
/// <param name="Title">The item's current title.</param>
public sealed record SitePageResponse(Guid ItemId, string Path, bool Pinned, string? Title);

/// <summary>A site's path table.</summary>
/// <param name="Pages">The pages, in path order.</param>
public sealed record SitePageListResponse(IReadOnlyList<SitePageResponse> Pages);

/// <summary>A redirect entry in the build manifest.</summary>
/// <param name="From">The old path.</param>
/// <param name="ToItemId">The item whose current path answers it.</param>
public sealed record SiteManifestRedirect(string From, Guid ToItemId);

/// <summary>The build manifest header served to the worker (<c>GET /internal/worker-executions/sites/builds/{jobId}</c>).</summary>
/// <param name="FormatVersion">Always 1.</param>
/// <param name="SiteId">The site.</param>
/// <param name="BuildId">The build.</param>
/// <param name="WorkspaceId">The workspace.</param>
/// <param name="RootItemId">The root item.</param>
/// <param name="Layout">The theme layout.</param>
/// <param name="Settings">The presentation settings at publish time.</param>
/// <param name="CanonicalOrigin">The origin canonical links use.</param>
/// <param name="BuiltAt">The publish instant, the only clock the renderer may use.</param>
/// <param name="PageCount">Pages in the manifest.</param>
/// <param name="DatedCollections">The dated collections.</param>
/// <param name="Redirects">The permanent redirects whose target is in this build.</param>
public sealed record SiteBuildManifest(
    int FormatVersion,
    Guid SiteId,
    Guid BuildId,
    Guid WorkspaceId,
    Guid RootItemId,
    string Layout,
    SiteSettingsDto Settings,
    string CanonicalOrigin,
    DateTimeOffset BuiltAt,
    int PageCount,
    IReadOnlyList<SiteDatedCollectionDto> DatedCollections,
    IReadOnlyList<SiteManifestRedirect> Redirects);

/// <summary>The content position a body is read at.</summary>
/// <param name="DocId">The content document.</param>
/// <param name="Seq">The position in its update log.</param>
public sealed record SiteContentPosition(Guid DocId, long Seq);

/// <summary>An image a page's properties reference, resolved at publish time.</summary>
/// <param name="FileItemId">The file item.</param>
/// <param name="FileVersionId">The version that was current.</param>
/// <param name="Sha256">The content digest.</param>
/// <param name="MediaType">The media type.</param>
/// <param name="ByteLength">The size in bytes.</param>
public sealed record SitePropertyFile(Guid FileItemId, Guid FileVersionId, string Sha256, string MediaType, long ByteLength);

/// <summary>One page of the manifest, as the worker reads it.</summary>
/// <param name="Ordinal">The pre-order position.</param>
/// <param name="ItemId">The item.</param>
/// <param name="ParentItemId">The parent page's item.</param>
/// <param name="Path">The public path.</param>
/// <param name="Title">The title.</param>
/// <param name="Type">The item type.</param>
/// <param name="Seq">The sibling order key, as a decimal string.</param>
/// <param name="CreatedAt">When the item was created.</param>
/// <param name="UpdatedAt">When the item last changed.</param>
/// <param name="Properties">The item's properties.</param>
/// <param name="Schema">The effective schema snapshot, for a page with views.</param>
/// <param name="Views">The view set snapshot, for a page with views.</param>
/// <param name="Chart">The chart snapshot, only when nothing under the container is hidden.</param>
/// <param name="Content">Where the body is read.</param>
/// <param name="DatedCollectionId">The dated collection the page is a post of.</param>
/// <param name="PublishedAt">The post's publication instant.</param>
/// <param name="PropertyFiles">The property images.</param>
public sealed record SiteWorkerPage(
    int Ordinal,
    Guid ItemId,
    Guid? ParentItemId,
    string Path,
    string Title,
    string Type,
    string Seq,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    JsonElement Properties,
    JsonElement? Schema,
    JsonElement? Views,
    JsonElement? Chart,
    SiteContentPosition? Content,
    Guid? DatedCollectionId,
    DateTimeOffset? PublishedAt,
    IReadOnlyList<SitePropertyFile> PropertyFiles);

/// <summary>A page of manifest pages.</summary>
/// <param name="Pages">The pages, by ordinal.</param>
/// <param name="Next">The ordinal to pass as <c>after</c> for the next page, or null at the end.</param>
public sealed record SiteWorkerPageList(IReadOnlyList<SiteWorkerPage> Pages, int? Next);

/// <summary>Where and how a worker reads one page's body.</summary>
/// <param name="SourceUrl">The collaboration bundle URL, pinned to the manifest's content position.</param>
/// <param name="BearerToken">A short-lived delegation for that URL.</param>
/// <param name="ExpiresAt">When the delegation ends.</param>
public sealed record SiteWorkerBody(Uri SourceUrl, string BearerToken, DateTimeOffset ExpiresAt);

/// <summary>A capability to read one image a page references.</summary>
/// <param name="FileItemId">The file item.</param>
/// <param name="FileVersionId">The version the capability reads.</param>
/// <param name="Sha256">The content digest.</param>
/// <param name="MediaType">The media type.</param>
/// <param name="ByteLength">The size in bytes.</param>
/// <param name="FileName">The file name, which a published download is named after.</param>
/// <param name="Url">The read capability.</param>
/// <param name="ExpiresAt">When it ends.</param>
public sealed record SiteWorkerFile(
    Guid FileItemId,
    Guid FileVersionId,
    string Sha256,
    string MediaType,
    long ByteLength,
    string FileName,
    Uri Url,
    DateTimeOffset ExpiresAt);

/// <summary>One object a worker wants to write.</summary>
/// <param name="Path">For <c>build</c>, the path under the build prefix; for <c>asset</c>, <c>&lt;sha256&gt;.&lt;ext&gt;</c>.</param>
/// <param name="Kind"><c>build</c> or <c>asset</c>.</param>
/// <param name="ByteLength">The size in bytes, at most 50 MiB.</param>
/// <param name="Sha256">The content digest.</param>
/// <param name="MediaType">The media type, which must match the extension.</param>
public sealed record SiteUploadEntry(string Path, string Kind, long ByteLength, string Sha256, string MediaType);

/// <summary>A batch of objects a worker wants to write.</summary>
/// <param name="Entries">At most 100 entries.</param>
public sealed record SiteUploadRequest(IReadOnlyList<SiteUploadEntry> Entries);

/// <summary>A capability to write one object.</summary>
/// <param name="Path">The entry's path, as requested.</param>
/// <param name="Key">The object key Core derived.</param>
/// <param name="UploadUrl">The create-only, checksum-bound write capability.</param>
/// <param name="ExpiresAt">When it ends.</param>
public sealed record SiteUploadTarget(string Path, string Key, Uri UploadUrl, DateTimeOffset ExpiresAt);

/// <summary>The write capabilities for a batch.</summary>
/// <param name="Targets">One per entry, in order.</param>
public sealed record SiteUploadResponse(IReadOnlyList<SiteUploadTarget> Targets);

/// <summary>A worker's claim that a build is complete.</summary>
/// <param name="FileCount">Objects written.</param>
/// <param name="TotalBytes">Bytes written.</param>
/// <param name="BuildIndexSha256">The digest of <c>_nix/build.json</c>.</param>
/// <param name="Loss">What the build could not represent.</param>
public sealed record SiteSealRequest(int FileCount, long TotalBytes, string BuildIndexSha256, IReadOnlyList<string> Loss);

/// <summary>A host manifest the worker must write to take the build live.</summary>
/// <param name="Hostname">The hostname it serves.</param>
/// <param name="Key">The object key.</param>
/// <param name="Body">The exact bytes to write, as UTF-8 text.</param>
/// <param name="UploadUrl">The replacing, checksum-bound write capability.</param>
/// <param name="ExpiresAt">When it ends.</param>
public sealed record SiteHostWrite(string Hostname, string Key, string Body, Uri UploadUrl, DateTimeOffset ExpiresAt);

/// <summary>The host manifests to write after a seal.</summary>
/// <param name="Writes">One per served hostname.</param>
public sealed record SiteSealResponse(IReadOnlyList<SiteHostWrite> Writes);

/// <summary>The host manifest of a hostname, mapping it to a build (<c>sites/_hosts/&lt;hostname&gt;.json</c>).</summary>
/// <param name="Version">Always 1.</param>
/// <param name="SiteId">The site.</param>
/// <param name="BuildId">The build.</param>
/// <param name="Generation">Increases with every activation of the site.</param>
/// <param name="BuildPrefix">The key prefix of the build.</param>
/// <param name="AssetsPrefix">The key prefix of the site's shared images.</param>
/// <param name="CanonicalHost">The hostname canonical links use.</param>
/// <param name="ActivatedAt">When the activation was planned.</param>
/// <param name="RedirectTo">For a redirect alias, the origin (<c>https://host</c>) visitors are sent to with a 308; otherwise null.</param>
public sealed record SiteHostManifest(
    int Version,
    Guid SiteId,
    Guid BuildId,
    int Generation,
    string BuildPrefix,
    string AssetsPrefix,
    string CanonicalHost,
    DateTimeOffset ActivatedAt,
    string? RedirectTo);

/// <summary>One stored operation of an activation.</summary>
/// <param name="Op"><c>put</c> or <c>delete</c>.</param>
/// <param name="Hostname">The hostname.</param>
/// <param name="Key">The host manifest key.</param>
/// <param name="Body">The exact bytes of a <c>put</c>.</param>
/// <param name="Sha256">The digest of <paramref name="Body"/>.</param>
/// <param name="ByteLength">The length of <paramref name="Body"/> in UTF-8 bytes.</param>
public sealed record SiteActivationOpRecord(string Op, string Hostname, string Key, string? Body, string? Sha256, long ByteLength);

/// <summary>An operation a worker applies, with its capability.</summary>
/// <param name="Op"><c>put</c> or <c>delete</c>.</param>
/// <param name="Hostname">The hostname.</param>
/// <param name="Key">The host manifest key.</param>
/// <param name="Body">The exact bytes of a <c>put</c>.</param>
/// <param name="Url">The write or delete capability.</param>
/// <param name="ExpiresAt">When it ends.</param>
/// <param name="ReadUrl">
/// For a <c>delete</c>: a capability to read the manifest first. The worker deletes only a manifest
/// whose <c>siteId</c> is this site's, so a hostname another site has since verified is never taken down.
/// </param>
public sealed record SiteActivationOp(string Op, string Hostname, string Key, string? Body, Uri Url, DateTimeOffset ExpiresAt, Uri? ReadUrl);

/// <summary>The operations of a rollback or unpublish.</summary>
/// <param name="ActivationId">The activation.</param>
/// <param name="Reason"><c>rollback</c> or <c>unpublish</c>.</param>
/// <param name="Ops">The operations to apply.</param>
/// <param name="SiteId">The site whose manifests these are.</param>
public sealed record SiteActivationResponse(Guid ActivationId, string Reason, IReadOnlyList<SiteActivationOp> Ops, Guid SiteId);

/// <summary>An object to delete, with its capability.</summary>
/// <param name="Key">The object key.</param>
/// <param name="DeleteUrl">The delete capability.</param>
/// <param name="ExpiresAt">When it ends.</param>
public sealed record SitePurgeTarget(string Key, Uri DeleteUrl, DateTimeOffset ExpiresAt);

/// <summary>A page of objects to delete.</summary>
/// <param name="Objects">The objects, in key order.</param>
/// <param name="Next">The key to pass as <c>after</c>, or null at the end.</param>
public sealed record SitePurgeObjectsResponse(IReadOnlyList<SitePurgeTarget> Objects, string? Next);

/// <summary>Objects the worker deleted.</summary>
/// <param name="Keys">The deleted keys.</param>
public sealed record SitePurgeDeletedRequest(IReadOnlyList<string> Keys);

/// <summary>How many object rows were forgotten.</summary>
/// <param name="Removed">The number of rows removed.</param>
public sealed record SitePurgeDeletedResponse(int Removed);

/// <summary>The payload of a <c>site.build</c> job.</summary>
/// <param name="SiteId">The site.</param>
/// <param name="BuildId">The build.</param>
public sealed record SiteBuildJobPayload(Guid SiteId, Guid BuildId);

/// <summary>The payload of a <c>site.activate</c> job.</summary>
/// <param name="SiteId">The site.</param>
/// <param name="ActivationId">The activation.</param>
public sealed record SiteActivateJobPayload(Guid SiteId, Guid ActivationId);

/// <summary>The payload of a <c>site.purge</c> job.</summary>
/// <param name="SiteId">The site.</param>
/// <param name="PurgeId">The purge.</param>
public sealed record SitePurgeJobPayload(Guid SiteId, Guid PurgeId);

/// <summary>Source-generated serialization for the sites contracts and stored documents.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.Never)]
[JsonSerializable(typeof(CreateSiteRequest))]
[JsonSerializable(typeof(UpdateSiteRequest))]
[JsonSerializable(typeof(SetSiteHostnamesRequest))]
[JsonSerializable(typeof(PublishSiteRequest))]
[JsonSerializable(typeof(RollbackSiteRequest))]
[JsonSerializable(typeof(SetSitePagePathRequest))]
[JsonSerializable(typeof(SiteResponse))]
[JsonSerializable(typeof(SiteListResponse))]
[JsonSerializable(typeof(SiteBuildResponse))]
[JsonSerializable(typeof(SiteBuildListResponse))]
[JsonSerializable(typeof(SitePageResponse))]
[JsonSerializable(typeof(SitePageListResponse))]
[JsonSerializable(typeof(SiteSettingsDto))]
[JsonSerializable(typeof(SiteBuildManifest))]
[JsonSerializable(typeof(SiteWorkerPageList))]
[JsonSerializable(typeof(SiteWorkerBody))]
[JsonSerializable(typeof(SiteWorkerFile))]
[JsonSerializable(typeof(SiteUploadRequest))]
[JsonSerializable(typeof(SiteUploadResponse))]
[JsonSerializable(typeof(SiteSealRequest))]
[JsonSerializable(typeof(SiteSealResponse))]
[JsonSerializable(typeof(SiteHostManifest))]
[JsonSerializable(typeof(SiteActivationResponse))]
[JsonSerializable(typeof(SitePurgeObjectsResponse))]
[JsonSerializable(typeof(SitePurgeDeletedRequest))]
[JsonSerializable(typeof(SitePurgeDeletedResponse))]
[JsonSerializable(typeof(SiteBuildJobPayload))]
[JsonSerializable(typeof(SiteActivateJobPayload))]
[JsonSerializable(typeof(SitePurgeJobPayload))]
[JsonSerializable(typeof(SiteActivationOpRecord[]))]
[JsonSerializable(typeof(SitePropertyFile[]))]
[JsonSerializable(typeof(string[]))]
[JsonSerializable(typeof(SiteManagedRecords))]
[JsonSerializable(typeof(AddSiteHostnameRequest))]
[JsonSerializable(typeof(UpdateSiteHostnameRequest))]
[JsonSerializable(typeof(RequestSiteApprovalRequest))]
[JsonSerializable(typeof(RejectSiteApprovalRequest))]
[JsonSerializable(typeof(SiteApprovalResponse))]
[JsonSerializable(typeof(SiteApprovalListResponse))]
[JsonSerializable(typeof(SiteOperatorListResponse))]
internal sealed partial class SitesJsonContext : JsonSerializerContext;
