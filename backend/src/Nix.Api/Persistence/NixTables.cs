using System.Collections.Immutable;

namespace Nix.Persistence;

/// <summary>
/// The physical table names of the schema and their explicit security classification.
/// </summary>
/// <remarks>
/// <para>
/// Three places need to agree on these strings: the entity configurations that map to them, the
/// hand-written SQL that queries them, and the integration suite that checks each one carries a
/// row-level security policy. Spelling them once means a rename cannot leave a table silently
/// unprotected because the test's copy of the name no longer matches anything.
/// </para>
/// <para>
/// <see cref="TenantScoped"/> is the list the tenant isolation tests iterate. Customer state belongs
/// in it. <see cref="CapabilityOnly"/> is the narrow pre-authentication or instance-wide operational
/// exception: anonymous login challenges have no tenant until a person approves them, and backup
/// results belong to no tenant, so only exact security-definer functions can reach these tables.
/// They have forced RLS, no ordinary policies and no runtime or PUBLIC DML.
/// An exhaustive database test checks both classes; a new table cannot silently escape scrutiny.
/// </para>
/// </remarks>
public static class NixTables
{
    /// <summary>The column every tenant-scoped table carries, and every policy filters on.</summary>
    public const string TenantIdColumn = "tenant_id";

    /// <summary>Customer organisations.</summary>
    public const string Tenant = "tenant";

    /// <summary>Containers inside a tenant.</summary>
    public const string Workspace = "workspace";

    /// <summary>Registered OIDC issuers.</summary>
    public const string IdentityProvider = "identity_provider";

    /// <summary>Core-owned browser sessions.</summary>
    public const string BrowserSession = "browser_session";

    /// <summary>Anonymous, single-use browser approval challenges, accessed only by exact secret hashes.</summary>
    public const string CliLoginPairing = "cli_login_pairing";

    /// <summary>CLI-to-browser revocation links, accessed only inside session capability functions.</summary>
    public const string CliSessionLink = "cli_session_link";

    /// <summary>Instance-wide nightly backup results, written and read only through definer functions.</summary>
    public const string BackupRuns = "backup_runs";

    /// <summary>Identities provisioned from an issuer.</summary>
    public const string Principal = "principal";

    /// <summary>Named sets of principals.</summary>
    public const string PrincipalGroup = "principal_group";

    /// <summary>Principal-to-group membership.</summary>
    public const string GroupMembership = "group_membership";

    /// <summary>Tenant-wide role grants.</summary>
    public const string TenantRole = "tenant_role";

    /// <summary>Workspace-level role grants.</summary>
    public const string WorkspaceMember = "workspace_member";

    /// <summary>Durable workspace invitation history.</summary>
    public const string WorkspaceInvitation = "workspace_invitation";

    /// <summary>The universal object.</summary>
    public const string Item = "item";

    /// <summary>Immutable creation keys retained through item deletion for safe retries.</summary>
    public const string ItemCreationReceipt = "item_creation_receipt";

    /// <summary>Derived ancestor-descendant edges of the item tree.</summary>
    public const string ItemClosure = "item_closure";

    /// <summary>Access control entries.</summary>
    public const string AclEntry = "acl_entry";

    /// <summary>Insert-only record of what was done.</summary>
    public const string AuditEvent = "audit_event";

    /// <summary>The body of a native item.</summary>
    public const string ContentDoc = "content_doc";

    /// <summary>Append-only log of conflict-free updates. The source of truth for content.</summary>
    public const string ContentUpdate = "content_update";

    /// <summary>Materialisations of the update log. Derived, rebuildable, never authoritative.</summary>
    public const string ContentSnapshot = "content_snapshot";

    /// <summary>A revision somebody named. Pins a snapshot so retention can never remove it.</summary>
    public const string ContentVersion = "content_version";

    /// <summary>Item-to-item reference edges, extracted from documents. Derived, rebuildable.</summary>
    public const string ItemLink = "item_link";

    /// <summary>The searchable text of each item's document. Derived, rebuildable.</summary>
    public const string ItemSearch = "item_search";

    /// <summary>Retrieval chunks of each note body and their embeddings. Derived, rebuildable.</summary>
    public const string ItemChunk = "item_chunk";

    /// <summary>A principal's personal set of reusable Excalidraw shapes.</summary>
    public const string CanvasLibrary = "canvas_library";

    /// <summary>A principal's private companion configurations.</summary>
    public const string PetPreferences = "pet_preferences";

    /// <summary>A principal's reminder, quiet-hours and mute settings.</summary>
    public const string PrincipalPreferences = "principal_preferences";

    /// <summary>A principal's synced interface settings.</summary>
    public const string PrincipalUiSettings = "principal_ui_settings";

    /// <summary>One person's workspace groups and pins; a convenience, never a permission.</summary>
    public const string WorkspaceArrangement = "workspace_arrangement";

    /// <summary>One person's protected API key per model provider for their pets.</summary>
    public const string PetProviderCredential = "pet_provider_credential";

    /// <summary>One entry in a principal's private inbox.</summary>
    public const string Notification = "notification";

    /// <summary>One device registered for Web Push.</summary>
    public const string PushSubscription = "push_subscription";

    /// <summary>The per-principal notification inbox revision counter.</summary>
    public const string NotificationInbox = "notification_inbox";

    /// <summary>A planned instant at which a reminder or automation rule should fire. Derived, rebuildable.</summary>
    public const string ScheduledTrigger = "scheduled_trigger";

    /// <summary>One owner-private automation rule (ADR-0051 section 6).</summary>
    public const string AutomationRule = "automation_rule";

    /// <summary>One record of an automation rule firing or deciding not to.</summary>
    public const string AutomationRun = "automation_run";

    /// <summary>What a property rule last saw on one item.</summary>
    public const string AutomationItemState = "automation_item_state";

    /// <summary>One principal's OAuth grant to an external calendar account (ADR-0052).</summary>
    public const string CalendarConnection = "calendar_connection";

    /// <summary>A binding between an external calendar and a Nix container.</summary>
    public const string CalendarLink = "calendar_link";

    /// <summary>Which item mirrors which external event.</summary>
    public const string CalendarEventMap = "calendar_event_map";

    /// <summary>The visible calendar sync log, retained 30 days.</summary>
    public const string CalendarSyncLog = "calendar_sync_log";

    /// <summary>One row per item a principal has kept.</summary>
    public const string Bookmark = "bookmark";

    /// <summary>Comments on notes, threads headed by a root row.</summary>
    public const string NoteComment = "note_comment";

    /// <summary>Per-note counter that lets a watch notice comment changes.</summary>
    public const string NoteCommentRevision = "note_comment_revision";

    /// <summary>Passwords item bodies are held behind.</summary>
    public const string ItemLock = "item_lock";

    /// <summary>Short-lived per-credential grants past an item lock.</summary>
    public const string ItemUnlock = "item_unlock";

    /// <summary>Historical transcription state retained after the feature was retired.</summary>
    public const string ItemTranscription = "item_transcription";

    /// <summary>One revocable capability per published item view.</summary>
    public const string PublicFormLink = "public_form_link";

    /// <summary>One credential a principal issued for a non-browser client.</summary>
    public const string PersonalAccessToken = "personal_access_token";

    /// <summary>Workspace-visible catalog entries backed by hidden item trees.</summary>
    public const string WorkspaceTemplate = "workspace_template";

    /// <summary>Staged capture/import protocols.</summary>
    public const string TemplateOperation = "template_operation";

    /// <summary>Complete mappings for staged capture/import bodies.</summary>
    public const string TemplateOperationItem = "template_operation_item";

    /// <summary>Idempotent template applications.</summary>
    public const string TemplateApplication = "template_application";

    /// <summary>Stable source-to-target mappings for applications.</summary>
    public const string TemplateApplicationItem = "template_application_item";
    public const string TemplateFileTransfer = "template_file_transfer";

    /// <summary>Backend-owned asynchronous worker jobs.</summary>
    public const string WorkerJob = "worker_job";

    /// <summary>Backend-owned durable events for rebuildable derived data.</summary>
    public const string WorkerOutboxEvent = "worker_outbox_event";

    public const string FileBody = "file_body";
    public const string FileVersion = "file_version";
    public const string FileUpload = "file_upload";
    public const string DocumentImport = "document_import";
    public const string DocumentImportItem = "document_import_item";
    public const string DocumentImportFileVersion = "document_import_file_version";
    public const string PluginPublisher = "plugin_publisher";
    public const string PluginComponent = "plugin_component";
    public const string PluginInstallation = "plugin_installation";
    public const string PluginCapabilityGrant = "plugin_capability_grant";
    public const string PluginEventReceipt = "plugin_event_receipt";
    public const string PluginEventInbox = "plugin_event_inbox";
    public const string PluginInvocation = "plugin_invocation";

    /// <summary>A static publication of one item subtree (ADR-0063).</summary>
    public const string Site = "site";

    /// <summary>A hostname that resolves to a site.</summary>
    public const string SiteHostname = "site_hostname";

    /// <summary>An item a manager keeps out of a site.</summary>
    public const string SiteExclusion = "site_exclusion";

    /// <summary>A collection of dated posts.</summary>
    public const string SiteDatedCollection = "site_dated_collection";

    /// <summary>The stable public path of one item.</summary>
    public const string SitePage = "site_page";

    /// <summary>A permanent redirect from an old path.</summary>
    public const string SiteRedirect = "site_redirect";

    /// <summary>One build of a site.</summary>
    public const string SiteBuild = "site_build";

    /// <summary>One page of a build manifest; immutable.</summary>
    public const string SiteBuildPage = "site_build_page";

    /// <summary>A file a build may copy; insert-only.</summary>
    public const string SiteBuildFile = "site_build_file";

    /// <summary>An object a build wrote to the sites bucket.</summary>
    public const string SiteBuildObject = "site_build_object";

    /// <summary>A set of host-manifest operations a worker applies.</summary>
    public const string SiteActivation = "site_activation";

    /// <summary>A principal granted the right to decide first publishes.</summary>
    public const string SiteOperator = "site_operator";

    /// <summary>
    /// Every table that holds customer data, and therefore every table that must carry an
    /// isolation policy.
    /// </summary>
    public static ImmutableArray<string> TenantScoped { get; } =
    [
        Tenant,
        Workspace,
        IdentityProvider,
        BrowserSession,
        Principal,
        PrincipalGroup,
        GroupMembership,
        TenantRole,
        WorkspaceMember,
        WorkspaceInvitation,
        Item,
        ItemCreationReceipt,
        ItemClosure,
        AclEntry,
        AuditEvent,
        ContentDoc,
        ContentUpdate,
        ContentSnapshot,
        ContentVersion,
        ItemLink,
        ItemSearch,
        ItemChunk,
        CanvasLibrary,
        PetPreferences,
        PrincipalPreferences,
        PrincipalUiSettings,
        WorkspaceArrangement,
        PetProviderCredential,
        Notification,
        PushSubscription,
        NotificationInbox,
        ScheduledTrigger,
        AutomationRule,
        AutomationRun,
        AutomationItemState,
        CalendarConnection,
        CalendarLink,
        CalendarEventMap,
        CalendarSyncLog,
        Bookmark,
        NoteComment,
        NoteCommentRevision,
        ItemLock,
        ItemUnlock,
        ItemTranscription,
        PublicFormLink,
        PersonalAccessToken,
        WorkspaceTemplate,
        TemplateOperation,
        TemplateOperationItem,
        TemplateApplication,
        TemplateApplicationItem,
        TemplateFileTransfer,
        WorkerJob,
        WorkerOutboxEvent,
        FileBody,
        FileVersion,
        FileUpload,
        DocumentImport,
        DocumentImportItem,
        DocumentImportFileVersion,
        PluginPublisher,
        PluginComponent,
        PluginInstallation,
        PluginCapabilityGrant,
        PluginEventReceipt,
        PluginEventInbox,
        PluginInvocation,
        Site,
        SiteHostname,
        SiteExclusion,
        SiteDatedCollection,
        SitePage,
        SiteRedirect,
        SiteBuild,
        SiteBuildPage,
        SiteBuildFile,
        SiteBuildObject,
        SiteActivation,
        SiteOperator,
    ];

    /// <summary>Pre-authentication capability state with no direct application, collaboration or PUBLIC access.</summary>
    /// <remarks>
    /// Pairings begin anonymously. The child revocation marker remains capability-only so an
    /// ambient tenant cannot read, rewrite or erase the evidence connecting a CLI to its approving
    /// browser. Exact security-definer functions derive identity from a standing source session;
    /// they never accept a caller-supplied tenant or principal. Both tables force RLS with no policies.
    /// </remarks>
    public static ImmutableArray<string> CapabilityOnly { get; } = [CliLoginPairing, CliSessionLink, BackupRuns];

    /// <summary>
    /// Read and write, sorted the way <c>information_schema.table_privileges</c> reports them.
    /// </summary>
    /// <remarks>
    /// Declared before the dictionary that reads it. Static property initializers run in
    /// declaration order, so the other way round leaves this one still <c>default</c> - an
    /// <c>ImmutableArray</c> that throws on enumeration rather than reading as empty.
    /// </remarks>
    private static ImmutableArray<string> FullDml { get; } = ["DELETE", "INSERT", "SELECT", "UPDATE"];

    /// <summary>Read without write, sorted the way the catalogue reports it.</summary>
    private static ImmutableArray<string> ReadOnly { get; } = ["SELECT"];

    /// <summary>Read, create and transition, but never erase history.</summary>
    private static ImmutableArray<string> RevocableHistory { get; } = ["INSERT", "SELECT", "UPDATE"];

    /// <summary>Immutable registration data: create and read, never rewrite or erase.</summary>
    private static ImmutableArray<string> ImmutableRegistration { get; } = ["INSERT", "SELECT"];

    /// <summary>Replaceable grants: add, read and revoke, never rewrite in place.</summary>
    private static ImmutableArray<string> ReplaceableGrant { get; } = ["DELETE", "INSERT", "SELECT"];

    /// <summary>
    /// The privileges the runtime role is expected to hold on each table, from the development
    /// document's table ownership matrix.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Written out per table rather than assumed, because the database seed's
    /// <c>ALTER DEFAULT PRIVILEGES</c> makes grants fail <i>open</i>: a table a migration forgets
    /// to narrow arrives with full DML for the application. Stating the intended set here and
    /// asserting it against <c>information_schema</c> turns that from a silent default into a
    /// failing test.
    /// </para>
    /// <para>
    /// The matrix is not uniform and gets less so: <c>audit_event</c> is insert-only now, and the
    /// M1 content tables are read-only for Core because the collaboration service owns writing
    /// them. A table added without a line here fails the grants test rather than inheriting
    /// whatever the default happened to be.
    /// </para>
    /// </remarks>
    public static ImmutableDictionary<string, ImmutableArray<string>> ExpectedApplicationPrivileges { get; } =
        new Dictionary<string, ImmutableArray<string>>(StringComparer.Ordinal)
        {
            [Tenant] = FullDml,
            [Workspace] = FullDml,
            [IdentityProvider] = FullDml,
            [BrowserSession] = ["INSERT", "SELECT", "UPDATE"],
            [CliLoginPairing] = [],
            [CliSessionLink] = [],
            [BackupRuns] = [],
            [Principal] = FullDml,
            [PrincipalGroup] = FullDml,
            [GroupMembership] = FullDml,
            [TenantRole] = FullDml,
            [WorkspaceMember] = FullDml,
            [WorkspaceInvitation] = RevocableHistory,
            [Item] = FullDml,
            [ItemCreationReceipt] = ImmutableRegistration,

            // A bookmark is personal state the application both reads and writes on the reader's
            // behalf: keeping one is the whole feature, and there is no other service that owns it.
            [Bookmark] = FullDml,
            [NoteComment] = FullDml,
            [NoteCommentRevision] = FullDml,

            // Core alone sets, checks and removes locks, and issues and expires the grants past
            // them. The collaboration service reads which items are locked (column-level, never
            // the verifier) and nothing else.
            [ItemLock] = FullDml,
            [ItemUnlock] = FullDml,

            // Preserve the historical table's grants; its rows still cascade with audio items.
            [ItemTranscription] = FullDml,
            [PublicFormLink] = FullDml,
            [WorkspaceTemplate] = FullDml,
            [TemplateOperation] = FullDml,
            [TemplateOperationItem] = FullDml,
            [TemplateApplication] = FullDml,
            [TemplateApplicationItem] = FullDml,
            [TemplateFileTransfer] = FullDml,
            [WorkerJob] = FullDml,
            [WorkerOutboxEvent] = FullDml,
            [FileBody] = FullDml,
            [FileVersion] = FullDml,
            [FileUpload] = FullDml,
            [DocumentImport] = FullDml,
            [DocumentImportItem] = FullDml,
            [DocumentImportFileVersion] = FullDml,
            [PluginPublisher] = ImmutableRegistration,
            [PluginComponent] = ImmutableRegistration,
            // Only enabled and updated_at carry column-level UPDATE. A table-level grant would
            // let an application bug rewrite the installed component identity or version.
            [PluginInstallation] = ImmutableRegistration,
            [PluginCapabilityGrant] = ReplaceableGrant,
            [PluginEventReceipt] = ReadOnly,
            [PluginEventInbox] = ReadOnly,
            [PluginInvocation] = ReadOnly,
            [ItemClosure] = FullDml,
            [AclEntry] = FullDml,

            // Insert-only: an audit trail the application can rewrite records only what an
            // attacker who reached the application was willing to leave behind.
            [AuditEvent] = ["INSERT"],

            // Read-only for the application, per the table ownership matrix. Content is written by
            // the collaboration service, which is the only thing that can validate an update -
            // doing so means applying it, which needs a CRDT runtime. Core serves what is there
            // and never authors it, so a bug in Core cannot corrupt a document.
            [ContentDoc] = ReadOnly,
            [ContentUpdate] = ReadOnly,
            [ContentSnapshot] = ReadOnly,

            // Read-only for the same reason: a version names a point in a log only the
            // collaboration service writes to, and pins a snapshot only it can produce.
            [ContentVersion] = ReadOnly,

            // Read-only for the same reason as the content tables, one step further along: an edge
            // and a search vector are extracted from a materialised document, and materialising a
            // document needs the CRDT runtime only the collaboration service has. Core reads what
            // was derived and never derives it.
            [ItemLink] = ReadOnly,
            [ItemSearch] = ReadOnly,
            // Embeddings are written only through nix_set_chunk_embedding, a definer function.
            [ItemChunk] = ReadOnly,

            // A principal's own library, read and written by Core alone - nothing else ever
            // touches it.
            [CanvasLibrary] = FullDml,
            [PetPreferences] = FullDml,

            // A principal's own reminder settings, inbox and registered devices - read and
            // written by Core alone, the same reasoning as pet_preferences and canvas_library.
            [PrincipalPreferences] = FullDml,
            [PrincipalUiSettings] = FullDml,
            [WorkspaceArrangement] = FullDml,
            [PetProviderCredential] = FullDml,
            [Notification] = FullDml,
            [PushSubscription] = FullDml,
            [NotificationInbox] = FullDml,

            // Derived, rebuildable planning state the dispatcher and planner read and write
            // directly; cross-tenant discovery goes only through the SECURITY DEFINER lease and
            // finish functions, never a table-level grant.
            [ScheduledTrigger] = FullDml,

            // An owner's own rules, their run log and per-item state, read and written by Core
            // alone under the owner's session; cross-owner work (planning, retention, the property
            // feed) goes only through the SECURITY DEFINER functions in AutomationSecuritySql.
            [AutomationRule] = FullDml,
            [AutomationRun] = FullDml,
            [AutomationItemState] = FullDml,

            // An owner's own calendar grants, links, event map and sync log, read and written by
            // Core alone under the owner's session (a request, a worker execution or the
            // dispatcher's per-trigger one); cross-owner work (planning, retention, the dirty
            // feed) goes only through the SECURITY DEFINER functions in CalendarSyncSecuritySql.
            [CalendarConnection] = FullDml,
            [CalendarLink] = FullDml,
            [CalendarEventMap] = FullDml,
            [CalendarSyncLog] = FullDml,

            // Revoked, never deleted: the rows are the audit of what has been able to act as a
            // principal, and an application that can erase that record can erase evidence.
            // Purging rides the principal's own cascade, which does not need this grant.
            [PersonalAccessToken] = ["INSERT", "SELECT", "UPDATE"],

            // Sites are written by Core alone; the collaboration service has no grant on any of
            // them. A build's manifest rows and the files it may copy are immutable once written,
            // so the application can add them and read them back but never rewrite what a worker
            // was told it could publish.
            [Site] = FullDml,
            [SiteHostname] = FullDml,
            [SiteExclusion] = FullDml,
            [SiteDatedCollection] = FullDml,
            [SitePage] = FullDml,
            [SiteRedirect] = FullDml,
            [SiteBuild] = ImmutableRegistration, // plus column-level UPDATE of its lifecycle columns only
            [SiteBuildPage] = ImmutableRegistration,
            [SiteBuildFile] = ImmutableRegistration,
            [SiteBuildObject] = ReplaceableGrant,
            [SiteActivation] = FullDml,

            // Granted and revoked, never edited: a row is the whole fact.
            [SiteOperator] = ["DELETE", "INSERT", "SELECT"],
        }.ToImmutableDictionary(StringComparer.Ordinal);

}
