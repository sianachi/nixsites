using Microsoft.EntityFrameworkCore;
using Nix.Domain.Audit;
using Nix.Domain.Authorization;
using Nix.Domain.Bookmarks;
using Nix.Domain.Comments;
using Nix.Domain.Content;
using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Nix.Domain.Links;
using Nix.Domain.Locks;
using Nix.Domain.Notifications;
using Nix.Domain.Plugins;
using Nix.Domain.Scheduling;
using Nix.Domain.Sites;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Domain.Transcriptions;
using Nix.Domain.Views;
using Nix.Domain.Workers;
using Nix.Persistence.Configurations;
using Nix.Persistence.Conversion;

namespace Nix.Persistence;

/// <summary>
/// The application's EF Core context: envelope CRUD, and the anchor for the migration history.
/// </summary>
/// <remarks>
/// <para>
/// Holds the M0 schema: tenancy and identity, the item tree and its access control entries, and
/// the audit trail. Per ADR-0002 the whole phase arrives in one migration, so the goals that build
/// on this - authentication, the tree, authorization, audit - add code against tables that already
/// exist rather than each carrying schema of its own.
/// </para>
/// <para>
/// Two rules govern what may be added here:
/// </para>
/// <list type="bullet">
///   <item>
///     <description>
///     EF Core global query filters are ergonomics, not security. They are bypassed by
///     <c>IgnoreQueryFilters()</c> and do not apply to raw SQL at all. Row-level security in the
///     database is the tenant boundary; a filter here is a convenience on top of it and must
///     never be the reason a table is considered isolated.
///     </description>
///   </item>
///   <item>
///     <description>
///     Closure maintenance, permission predicates, and search are hand-written SQL, not LINQ.
///     They live under <c>Persistence/Sql/Statements</c> and run through
///     <c>Nix.Persistence.Sql.NixSqlExecutor</c>, which shares this context's
///     connection and transaction and therefore the same <c>SET LOCAL</c> session context.
///     </description>
///   </item>
/// </list>
/// <para>
/// Tracking is off by default: reads are the common case and change tracking on them is pure
/// cost. Update flows opt in per query with <c>AsTracking()</c>.
/// </para>
/// </remarks>
public sealed class NixDbContext : DbContext
{
    /// <summary>
    /// Initializes a new instance of the <see cref="NixDbContext"/> class.
    /// </summary>
    /// <param name="options">Provider and interceptor configuration.</param>
    public NixDbContext(DbContextOptions<NixDbContext> options)
        : base(options)
    {
    }

    /// <summary>Gets the customer organisations.</summary>
    public DbSet<Tenant> Tenants => Set<Tenant>();

    /// <summary>Gets the containers inside a tenant.</summary>
    public DbSet<Workspace> Workspaces => Set<Workspace>();

    /// <summary>Gets the registered OIDC issuers.</summary>
    public DbSet<IdentityProvider> IdentityProviders => Set<IdentityProvider>();

    /// <summary>Gets the provisioned identities.</summary>
    public DbSet<Principal> Principals => Set<Principal>();

    /// <summary>Gets the named sets of principals.</summary>
    public DbSet<PrincipalGroup> PrincipalGroups => Set<PrincipalGroup>();

    /// <summary>Gets the principal-to-group memberships.</summary>
    public DbSet<GroupMembership> GroupMemberships => Set<GroupMembership>();

    /// <summary>Gets the tenant-wide role grants.</summary>
    public DbSet<TenantRoleGrant> TenantRoleGrants => Set<TenantRoleGrant>();

    /// <summary>Gets the workspace-level role grants.</summary>
    public DbSet<WorkspaceMember> WorkspaceMembers => Set<WorkspaceMember>();

    /// <summary>Gets durable workspace invitation history.</summary>
    public DbSet<WorkspaceInvitation> WorkspaceInvitations => Set<WorkspaceInvitation>();

    /// <summary>Gets the items.</summary>
    public DbSet<Item> Items => Set<Item>();

    /// <summary>Gets the derived ancestry edges of the item tree.</summary>
    public DbSet<ItemClosureEdge> ItemClosure => Set<ItemClosureEdge>();

    /// <summary>Gets the access control entries.</summary>
    public DbSet<AclEntry> AclEntries => Set<AclEntry>();

    /// <summary>Gets the audit trail.</summary>
    /// <remarks>
    /// Writable through this set and readable only by a role that is not the application's: the
    /// migration revokes everything but <c>INSERT</c> on the table from <c>nix_app</c>. A query
    /// against this set from the API will fail with insufficient privilege, which is the intended
    /// answer until the audit export goal introduces a read path of its own.
    /// </remarks>
    public DbSet<AuditEvent> AuditEvents => Set<AuditEvent>();

    /// <summary>Gets the document bodies of native items.</summary>
    public DbSet<ContentDoc> ContentDocs => Set<ContentDoc>();

    /// <summary>
    /// Gets the append-only log of conflict-free updates.
    /// </summary>
    /// <remarks>
    /// Readable here and not writable: the runtime role holds SELECT only on the content tables.
    /// Updates are authored by the collaboration service, which is the only thing that can
    /// validate one - validating means applying it, and that needs a CRDT runtime.
    /// </remarks>
    public DbSet<ContentUpdate> ContentUpdates => Set<ContentUpdate>();

    /// <summary>Gets the materialised snapshots. Derived from the log and rebuildable from it.</summary>
    public DbSet<ContentSnapshot> ContentSnapshots => Set<ContentSnapshot>();

    /// <summary>
    /// Gets the named versions.
    /// </summary>
    /// <remarks>
    /// Readable here and not writable, for the same reason as the other content tables: naming a
    /// version means pinning a snapshot, which the collaboration service is the only thing able to
    /// produce.
    /// </remarks>
    public DbSet<ContentVersion> ContentVersions => Set<ContentVersion>();

    /// <summary>
    /// Gets the item-to-item reference edges backlinks are read from.
    /// </summary>
    /// <remarks>
    /// Mapped so the model owns the schema, and never queried through here: the backlinks read is
    /// a hand-written statement in <c>SearchSql</c>, because it filters on what the acting principal
    /// may see and that filtering belongs inside the query rather than after it.
    /// </remarks>
    public DbSet<ItemLink> ItemLinks => Set<ItemLink>();

    /// <summary>Gets the per-item searchable text. Derived from the log and rebuildable from it.</summary>
    public DbSet<ItemSearchEntry> ItemSearchEntries => Set<ItemSearchEntry>();

    /// <summary>Gets every principal's personal canvas library.</summary>
    public DbSet<CanvasLibrary> CanvasLibraries => Set<CanvasLibrary>();

    /// <summary>The items each principal has kept.</summary>
    public DbSet<Bookmark> Bookmarks => Set<Bookmark>();

    /// <summary>Gets the comments on notes.</summary>
    public DbSet<NoteComment> NoteComments => Set<NoteComment>();

    /// <summary>Gets the per-note comment change counters.</summary>
    public DbSet<NoteCommentRevision> NoteCommentRevisions => Set<NoteCommentRevision>();

    /// <summary>Gets the passwords item bodies are held behind.</summary>
    public DbSet<ItemLock> ItemLocks => Set<ItemLock>();

    /// <summary>Preserves historical transcription rows after the feature was retired.</summary>
    public DbSet<ItemTranscription> ItemTranscriptions => Set<ItemTranscription>();

    /// <summary>Gets the short-lived grants past item locks.</summary>
    public DbSet<ItemUnlock> ItemUnlocks => Set<ItemUnlock>();

    /// <summary>Gets the revocable capabilities for published interactive forms.</summary>
    public DbSet<PublicFormLink> PublicFormLinks => Set<PublicFormLink>();

    /// <summary>Gets the credentials principals issued for non-browser clients.</summary>
    public DbSet<PersonalAccessToken> PersonalAccessTokens => Set<PersonalAccessToken>();

    /// <summary>Core-owned browser sessions.</summary>
    public DbSet<BrowserSession> BrowserSessions => Set<BrowserSession>();

    /// <summary>Gets workspace template catalog entries.</summary>
    public DbSet<WorkspaceTemplate> WorkspaceTemplates => Set<WorkspaceTemplate>();

    /// <summary>Gets staged template capture/import operations.</summary>
    public DbSet<TemplateOperation> TemplateOperations => Set<TemplateOperation>();

    /// <summary>Gets complete mappings for capture/import staging.</summary>
    public DbSet<TemplateOperationItem> TemplateOperationItems => Set<TemplateOperationItem>();

    /// <summary>Gets idempotent template applications.</summary>
    public DbSet<TemplateApplication> TemplateApplications => Set<TemplateApplication>();

    /// <summary>Gets immutable staged template file-version copies.</summary>
    public DbSet<TemplateFileTransfer> TemplateFileTransfers => Set<TemplateFileTransfer>();

    /// <summary>Gets source-to-target item mappings for template applications.</summary>
    public DbSet<TemplateApplicationItem> TemplateApplicationItems => Set<TemplateApplicationItem>();

    /// <summary>Gets durable worker jobs.</summary>
    public DbSet<WorkerJob> WorkerJobs => Set<WorkerJob>();

    /// <summary>Gets durable worker outbox events.</summary>
    public DbSet<WorkerOutboxEvent> WorkerOutboxEvents => Set<WorkerOutboxEvent>();

    public DbSet<FileBody> FileBodies => Set<FileBody>();
    public DbSet<FileVersion> FileVersions => Set<FileVersion>();
    public DbSet<FileUpload> FileUploads => Set<FileUpload>();

    public DbSet<DocumentImport> DocumentImports => Set<DocumentImport>();
    public DbSet<DocumentImportItem> DocumentImportItems => Set<DocumentImportItem>();
    public DbSet<DocumentImportFileVersion> DocumentImportFileVersions => Set<DocumentImportFileVersion>();

    /// <summary>Gets tenant-pinned plugin publisher keys.</summary>
    public DbSet<PluginPublisher> PluginPublishers => Set<PluginPublisher>();

    /// <summary>Gets immutable signed WebAssembly component versions.</summary>
    public DbSet<PluginComponent> PluginComponents => Set<PluginComponent>();

    /// <summary>Gets workspace-scoped plugin installations.</summary>
    public DbSet<PluginInstallation> PluginInstallations => Set<PluginInstallation>();

    /// <summary>Gets explicit plugin host capability grants.</summary>
    public DbSet<PluginCapabilityGrant> PluginCapabilityGrants => Set<PluginCapabilityGrant>();

    /// <summary>Gets immutable identifier-only plugin event receipts.</summary>
    public DbSet<PluginEventReceipt> PluginEventReceipts => Set<PluginEventReceipt>();

    /// <summary>Gets durable event-and-installation deduplication state.</summary>
    public DbSet<PluginEventInbox> PluginEventInbox => Set<PluginEventInbox>();

    /// <summary>Gets lease-bounded plugin invocation attempts.</summary>
    public DbSet<PluginInvocation> PluginInvocations => Set<PluginInvocation>();

    /// <summary>Gets the static publications of item subtrees.</summary>
    public DbSet<Site> Sites => Set<Site>();

    /// <summary>Gets the hostnames that resolve to sites.</summary>
    public DbSet<SiteHostname> SiteHostnames => Set<SiteHostname>();

    /// <summary>Gets the items kept out of sites.</summary>
    public DbSet<SiteExclusion> SiteExclusions => Set<SiteExclusion>();

    /// <summary>Gets the dated collections of sites.</summary>
    public DbSet<SiteDatedCollectionSetting> SiteDatedCollectionSettings => Set<SiteDatedCollectionSetting>();

    /// <summary>Gets the stable public paths of site pages.</summary>
    public DbSet<SitePage> SitePages => Set<SitePage>();

    /// <summary>Gets the permanent redirects of sites.</summary>
    public DbSet<SiteRedirect> SiteRedirects => Set<SiteRedirect>();

    /// <summary>Gets the builds of sites.</summary>
    public DbSet<SiteBuild> SiteBuilds => Set<SiteBuild>();

    /// <summary>Gets the immutable manifest pages of builds.</summary>
    public DbSet<SiteBuildPage> SiteBuildPages => Set<SiteBuildPage>();

    /// <summary>Gets the files builds may copy.</summary>
    public DbSet<SiteBuildFile> SiteBuildFiles => Set<SiteBuildFile>();

    /// <summary>Gets the objects builds wrote.</summary>
    public DbSet<SiteBuildObject> SiteBuildObjects => Set<SiteBuildObject>();

    /// <summary>Gets the host-manifest operation sets.</summary>
    public DbSet<SiteActivation> SiteActivations => Set<SiteActivation>();

    /// <summary>Gets the principals granted site approval rights.</summary>
    public DbSet<SiteOperatorGrant> SiteOperators => Set<SiteOperatorGrant>();

    /// <inheritdoc />
    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    {
        ArgumentNullException.ThrowIfNull(optionsBuilder);

        base.OnConfiguring(optionsBuilder);
        optionsBuilder.UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking);
    }

    /// <summary>
    /// Registers the conversions that apply to a type wherever it appears, rather than per
    /// property.
    /// </summary>
    /// <param name="configurationBuilder">The convention builder.</param>
    /// <remarks>
    /// Every typed identifier is mapped here, once. The alternative - a <c>HasConversion</c> call
    /// on each identifier property in each configuration - is the same instruction repeated forty
    /// times, and the failure mode of forgetting one is a property EF cannot map at all, which
    /// surfaces as a model error rather than as anything subtle. Registering by type also means a
    /// new identifier is one line here and nothing else.
    /// </remarks>
    protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    {
        ArgumentNullException.ThrowIfNull(configurationBuilder);

        base.ConfigureConventions(configurationBuilder);

        configurationBuilder.Properties<TenantId>().HaveConversion<NixIdConverter<TenantId>>();
        configurationBuilder.Properties<WorkspaceId>().HaveConversion<NixIdConverter<WorkspaceId>>();
        configurationBuilder.Properties<PrincipalId>().HaveConversion<NixIdConverter<PrincipalId>>();
        configurationBuilder.Properties<PrincipalGroupId>().HaveConversion<NixIdConverter<PrincipalGroupId>>();
        configurationBuilder.Properties<IdentityProviderId>().HaveConversion<NixIdConverter<IdentityProviderId>>();
        configurationBuilder.Properties<WorkspaceInvitationId>()
            .HaveConversion<NixIdConverter<WorkspaceInvitationId>>();
        configurationBuilder.Properties<ItemId>().HaveConversion<NixIdConverter<ItemId>>();
        configurationBuilder.Properties<AclEntryId>().HaveConversion<NixIdConverter<AclEntryId>>();
        configurationBuilder.Properties<AuditEventId>().HaveConversion<NixIdConverter<AuditEventId>>();
        configurationBuilder.Properties<ContentDocId>().HaveConversion<NixIdConverter<ContentDocId>>();
        configurationBuilder.Properties<PersonalAccessTokenId>().HaveConversion<NixIdConverter<PersonalAccessTokenId>>();
        configurationBuilder.Properties<BrowserSessionId>().HaveConversion<NixIdConverter<BrowserSessionId>>();
        configurationBuilder.Properties<DocumentImportId>().HaveConversion<NixIdConverter<DocumentImportId>>();
        configurationBuilder.Properties<TemplateId>().HaveConversion<NixIdConverter<TemplateId>>();
        configurationBuilder.Properties<TemplateOperationId>().HaveConversion<NixIdConverter<TemplateOperationId>>();
        configurationBuilder.Properties<TemplateApplicationId>().HaveConversion<NixIdConverter<TemplateApplicationId>>();
        configurationBuilder.Properties<WorkerJobId>().HaveConversion<NixIdConverter<WorkerJobId>>();
        configurationBuilder.Properties<WorkerOutboxEventId>().HaveConversion<NixIdConverter<WorkerOutboxEventId>>();
        configurationBuilder.Properties<FileVersionId>().HaveConversion<NixIdConverter<FileVersionId>>();
        configurationBuilder.Properties<FileUploadId>().HaveConversion<NixIdConverter<FileUploadId>>();
        configurationBuilder.Properties<PluginInstallationId>().HaveConversion<NixIdConverter<PluginInstallationId>>();
        configurationBuilder.Properties<PluginInvocationId>().HaveConversion<NixIdConverter<PluginInvocationId>>();
    }

    /// <inheritdoc />
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);

        base.OnModelCreating(modelBuilder);

        // One table's mapping is one file, under Persistence/Configurations, listed here rather
        // than discovered by ApplyConfigurationsFromAssembly. Reflection would save these twelve
        // lines and cost two things worth more: the set of mapped tables would no longer be
        // readable in one place, and every configuration would look unreferenced to the analysers,
        // which is a real signal to lose across a schema this security-sensitive.
        //
        // A forgotten line here does NOT fail loudly on its own - EF would map the entity by
        // convention and the next scaffold would emit a new, unprotected table. What catches it is
        // the integration suite: The_security_classification_names_every_table_the_database
        // _actually_has compares the live catalogue against NixTables.TenantScoped and
        // NixTables.CapabilityOnly, so an undeclared table fails there. Both classes prove their
        // isolation or exact-capability boundary and their explicit runtime privilege matrix.
        modelBuilder.ApplyConfiguration(new TenantConfiguration());
        modelBuilder.ApplyConfiguration(new WorkspaceConfiguration());
        modelBuilder.ApplyConfiguration(new IdentityProviderConfiguration());
        modelBuilder.ApplyConfiguration(new PrincipalConfiguration());
        modelBuilder.ApplyConfiguration(new PrincipalGroupConfiguration());
        modelBuilder.ApplyConfiguration(new GroupMembershipConfiguration());
        modelBuilder.ApplyConfiguration(new TenantRoleGrantConfiguration());
        modelBuilder.ApplyConfiguration(new WorkspaceMemberConfiguration());
        modelBuilder.ApplyConfiguration(new WorkspaceInvitationConfiguration());
        modelBuilder.ApplyConfiguration(new ItemConfiguration());
        modelBuilder.ApplyConfiguration(new ItemClosureEdgeConfiguration());
        modelBuilder.ApplyConfiguration(new AclEntryConfiguration());
        modelBuilder.ApplyConfiguration(new AuditEventConfiguration());
        modelBuilder.ApplyConfiguration(new ContentDocConfiguration());
        modelBuilder.ApplyConfiguration(new ContentUpdateConfiguration());
        modelBuilder.ApplyConfiguration(new ContentSnapshotConfiguration());
        modelBuilder.ApplyConfiguration(new ContentVersionConfiguration());
        modelBuilder.ApplyConfiguration(new ItemLinkConfiguration());
        modelBuilder.ApplyConfiguration(new ItemSearchEntryConfiguration());
        modelBuilder.ApplyConfiguration(new CanvasLibraryConfiguration());
        modelBuilder.ApplyConfiguration(new PetPreferencesConfiguration());
        modelBuilder.ApplyConfiguration(new PrincipalPreferencesConfiguration());
        modelBuilder.ApplyConfiguration(new PrincipalUiSettingsConfiguration());
        modelBuilder.ApplyConfiguration(new WorkspaceArrangementConfiguration());
        modelBuilder.ApplyConfiguration(new PetProviderCredentialConfiguration());
        modelBuilder.ApplyConfiguration(new NotificationConfiguration());
        modelBuilder.ApplyConfiguration(new PushSubscriptionConfiguration());
        modelBuilder.ApplyConfiguration(new NotificationInboxConfiguration());
        modelBuilder.ApplyConfiguration(new ScheduledTriggerConfiguration());
        modelBuilder.ApplyConfiguration(new AutomationRuleConfiguration());
        modelBuilder.ApplyConfiguration(new AutomationRunConfiguration());
        modelBuilder.ApplyConfiguration(new AutomationItemStateConfiguration());
        modelBuilder.ApplyConfiguration(new CalendarConnectionConfiguration());
        modelBuilder.ApplyConfiguration(new CalendarLinkConfiguration());
        modelBuilder.ApplyConfiguration(new CalendarEventMapConfiguration());
        modelBuilder.ApplyConfiguration(new CalendarSyncLogConfiguration());
        modelBuilder.ApplyConfiguration(new BookmarkConfiguration());
        modelBuilder.ApplyConfiguration(new NoteCommentConfiguration());
        modelBuilder.ApplyConfiguration(new NoteCommentRevisionConfiguration());
        modelBuilder.ApplyConfiguration(new ItemLockConfiguration());
        modelBuilder.ApplyConfiguration(new ItemUnlockConfiguration());
        modelBuilder.ApplyConfiguration(new ItemTranscriptionConfiguration());
        modelBuilder.ApplyConfiguration(new PublicFormLinkConfiguration());
        modelBuilder.ApplyConfiguration(new PersonalAccessTokenConfiguration());
        modelBuilder.ApplyConfiguration(new BrowserSessionConfiguration());
        modelBuilder.ApplyConfiguration(new WorkspaceTemplateConfiguration());
        modelBuilder.ApplyConfiguration(new TemplateOperationConfiguration());
        modelBuilder.ApplyConfiguration(new TemplateOperationItemConfiguration());
        modelBuilder.ApplyConfiguration(new TemplateApplicationConfiguration());
        modelBuilder.ApplyConfiguration(new TemplateApplicationItemConfiguration());
        modelBuilder.ApplyConfiguration(new TemplateFileTransferConfiguration());
        modelBuilder.ApplyConfiguration(new WorkerJobConfiguration());
        modelBuilder.ApplyConfiguration(new WorkerOutboxEventConfiguration());
        modelBuilder.ApplyConfiguration(new FileBodyConfiguration());
        modelBuilder.ApplyConfiguration(new FileVersionConfiguration());
        modelBuilder.ApplyConfiguration(new FileUploadConfiguration());
        modelBuilder.ApplyConfiguration(new DocumentImportConfiguration());
        modelBuilder.ApplyConfiguration(new DocumentImportItemConfiguration());
        modelBuilder.ApplyConfiguration(new DocumentImportFileVersionConfiguration());
        modelBuilder.ApplyConfiguration(new PluginPublisherConfiguration());
        modelBuilder.ApplyConfiguration(new PluginComponentConfiguration());
        modelBuilder.ApplyConfiguration(new PluginInstallationConfiguration());
        modelBuilder.ApplyConfiguration(new PluginCapabilityGrantConfiguration());
        modelBuilder.ApplyConfiguration(new PluginEventReceiptConfiguration());
        modelBuilder.ApplyConfiguration(new PluginEventInboxConfiguration());
        modelBuilder.ApplyConfiguration(new PluginInvocationConfiguration());
        modelBuilder.ApplyConfiguration(new SiteConfiguration());
        modelBuilder.ApplyConfiguration(new SiteHostnameConfiguration());
        modelBuilder.ApplyConfiguration(new SiteExclusionConfiguration());
        modelBuilder.ApplyConfiguration(new SiteDatedCollectionSettingConfiguration());
        modelBuilder.ApplyConfiguration(new SitePageConfiguration());
        modelBuilder.ApplyConfiguration(new SiteRedirectConfiguration());
        modelBuilder.ApplyConfiguration(new SiteBuildConfiguration());
        modelBuilder.ApplyConfiguration(new SiteBuildPageConfiguration());
        modelBuilder.ApplyConfiguration(new SiteBuildFileConfiguration());
        modelBuilder.ApplyConfiguration(new SiteBuildObjectConfiguration());
        modelBuilder.ApplyConfiguration(new SiteActivationConfiguration());
        modelBuilder.ApplyConfiguration(new SiteOperatorGrantConfiguration());

        // Template trees and half-hydrated regular items are implementation state, not workspace
        // content. Special template/application paths opt out explicitly; every ordinary EF item
        // query is safe by default. RLS remains the tenant boundary beneath this ergonomic filter.
        modelBuilder.Entity<Item>().HasQueryFilter(
            item => item.TemplateId == null && item.LifecycleState != ItemLifecycleState.Provisioning);
    }
}
