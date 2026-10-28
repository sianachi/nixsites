using System.Text.Json;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Tests.Harness;
using static Nix.Authentication.AccessTokenScopePolicy;

namespace Nix.Tests.Authentication;

/// <summary>
/// The scope ceiling's classification of every route, held exhaustive against the published
/// contract: an endpoint nobody classified is an endpoint this suite refuses to let ship.
/// </summary>
public sealed class AccessTokenScopePolicyTests
{
    /// <summary>
    /// Every operation in the contract, classified deliberately.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Adding an endpoint fails this test until its row is added here</b> - that is the
    /// mechanism, not an inconvenience. The policy classifies by shape, so a new route always
    /// gets an answer; this table is where a person confirms the answer is the intended one
    /// rather than an accident of its path.
    /// </para>
    /// <para>
    /// Routes outside <c>/api/v1</c> (health, the public form surface, the exchange itself)
    /// never pass through the unit-of-work middleware, so the policy never actually gates them -
    /// they are classified here anyway so the table stays a total function of the contract and
    /// a route that moves under <c>/api/v1</c> changes a row instead of appearing from nowhere.
    /// </para>
    /// </remarks>
    private static readonly Dictionary<string, Requirement> ExpectedByOperation = new(StringComparer.Ordinal)
    {
        ["CreateConversation"] = Requirement.Write,
        ["ImportConversation"] = Requirement.Write,
        ["ConfigureConversation"] = Requirement.Write,
        ["GetConversation"] = Requirement.Read,
        ["GetConversationMessages"] = Requirement.Read,
        ["WatchConversation"] = Requirement.Read,
        ["SendConversation"] = Requirement.InteractiveOnly,
        ["CancelConversation"] = Requirement.Write,
        ["ChangeConversationSources"] = Requirement.Write,

        // Reads: everything a read-only agent may do.
        ["GetHealthCheck"] = Requirement.Read,
        ["GetServiceStatus"] = Requirement.Read,
        ["GetLiveness"] = Requirement.Read,
        ["GetItem"] = Requirement.Read,
        ["ListItemMoveWorkspaces"] = Requirement.Read,
        ["GetHabitTracker"] = Requirement.Read,
        ["SetHabitSettings"] = Requirement.Write,
        ["SetHabitStatus"] = Requirement.Write,
        ["SetHabitCheckIn"] = Requirement.Write,
        ["DeleteHabitCheckIn"] = Requirement.Write,
        ["GetFinance"] = Requirement.Read,
        ["SetFinanceSettings"] = Requirement.Write,
        ["GetFinanceAccounts"] = Requirement.Read,
        ["CreateFinanceAccount"] = Requirement.Write,
        ["SetFinanceAccount"] = Requirement.Write,
        ["GetFinanceLoan"] = Requirement.Read,
        ["CreateBudgetLine"] = Requirement.Write,
        ["SetBudgetLine"] = Requirement.Write,
        ["SetBudgetActual"] = Requirement.Write,
        ["ListFinanceTransactions"] = Requirement.Read,
        ["CreateFinanceTransaction"] = Requirement.Write,
        ["SetFinanceTransaction"] = Requirement.Write,
        ["DeleteFinanceTransaction"] = Requirement.Write,
        ["GetFinanceBudget"] = Requirement.Read,
        ["GetFinanceCashFlow"] = Requirement.Read,
        ["GetFinanceDashboard"] = Requirement.Read,
        ["GetFinanceMonth"] = Requirement.Read,
        ["SetFinanceMonth"] = Requirement.Write,
        ["PostFinanceScheduled"] = Requirement.Write,
        ["ImportFinanceStatement"] = Requirement.Write,
        ["GetFile"] = Requirement.Read,
        ["GetFileUpload"] = Requirement.Read,
        ["AuthorizeFileDownload"] = Requirement.Read,
        ["AuthorizeFileThumbnail"] = Requirement.Read,
        ["GetDocumentImport"] = Requirement.Read,
        ["AuthorizeDocumentImportPreview"] = Requirement.Read,
        ["GetTemplateImport"] = Requirement.Read,
        ["ListExportFormats"] = Requirement.Read,
        ["GetExport"] = Requirement.Read,
        ["AuthorizeExportDownload"] = Requirement.Read,
        ["GetOperation"] = Requirement.Read,
        ["GetBacklinks"] = Requirement.Read,
        ["GetItemPermissions"] = Requirement.Read,
        ["RunItemQuery"] = Requirement.Read,

        // Reads sent as POSTs because rules do not fit a URL; they change nothing, so a write-only
        // ingest token must not be able to use them to read the workspace out.
        ["RunWorkspaceQuery"] = Requirement.Read,
        ["AggregateWorkspaceQuery"] = Requirement.Read,

        // A summary of children the caller can already list. Nothing about a chart discloses more
        // than the listing beside it, so it is a read like the listing.
        ["RunItemChart"] = Requirement.Read,
        ["GetEffectiveSchema"] = Requirement.Read,
        ["GetContainerViews"] = Requirement.Read,
        ["GetCurrentPrincipal"] = Requirement.Read,
        ["GetBookmarks"] = Requirement.Read,
        ["GetCanvasLibrary"] = Requirement.Read,
        ["SearchItems"] = Requirement.Read,
        ["ResolveReferences"] = Requirement.Read,
        ["GetRelatedItems"] = Requirement.Read,

        // A POST only because a passage of text does not fit in a URL. It reads titles and changes
        // nothing, so it is a read: classified as the default write, a write-only ingest token
        // would be admitted to a route that returns titles.
        ["FindMentions"] = Requirement.Read,
        ["ListTenantRoles"] = Requirement.Read,
        ["ListWorkspaces"] = Requirement.Read,
        ["GetWorkspace"] = Requirement.Read,
        ["GetWorkspaceCalendar"] = Requirement.Read,
        ["GetWorkspaceGraph"] = Requirement.Read,
        ["ListItems"] = Requirement.Read,
        ["ListTrash"] = Requirement.Read,
        ["ListWorkspaceMembers"] = Requirement.Read,
        ["ListWorkspaceAssignablePrincipals"] = Requirement.Read,
        ["ListWorkspaceInvitations"] = Requirement.Read,
        ["GetAccessTokenSigningKeys"] = Requirement.Read,
        ["GetPublicForm"] = Requirement.Read,
        ["ListTemplates"] = Requirement.Read,
        ["PreviewTemplateCapture"] = Requirement.Read,
        ["GetTemplate"] = Requirement.Read,
        ["GetTemplateItem"] = Requirement.Read,
        ["ListWorkspacePlugins"] = Requirement.Read,

        // Writes: content and structure, but never who-sees-what.
        ["UpdateItem"] = Requirement.Write,
        // The note body is the document. Reading it is a read. Replacing or appending it is a
        // write, the same scope as renaming the item. A read-only token must not change prose.
        ["GetItemBody"] = Requirement.Read,
        ["ReplaceItemBody"] = Requirement.Write,
        ["AppendItemBody"] = Requirement.Write,
        ["DeleteItem"] = Requirement.Write,
        ["SetItemProtection"] = Requirement.Write,
        ["PurgeItem"] = Requirement.Write,
        ["KeepItem"] = Requirement.Write,
        ["ReleaseItem"] = Requirement.Write,

        // Reading whether a body is locked is a read. Unlocking, relocking and managing a lock are
        // writes: an unlock issues a grant, and a read-only token opening bodies it was not given
        // would be a read scope that reaches further than it says.
        ["GetItemLock"] = Requirement.Read,
        ["SetItemLock"] = Requirement.Write,
        ["RemoveItemLock"] = Requirement.Write,
        ["UnlockItem"] = Requirement.Write,
        ["RelockItem"] = Requirement.Write,
        // Both recurrence writes are ordinary item edits under a token's write scope: setting a
        // rule changes what an item does, and completing an occurrence records work against it.
        // Neither is administrative - a token that may edit an item may schedule it.
        ["SetItemRecurrence"] = Requirement.Write,
        ["CompleteRecurrenceOccurrence"] = Requirement.Write,
        ["SetItemProperties"] = Requirement.Write,
        ["RestoreItem"] = Requirement.Write,
        ["SetItemSchema"] = Requirement.Write,
        ["AppendViewSetup"] = Requirement.Write,
        ["ReplaceViewSetup"] = Requirement.Write,
        ["SetContainerViews"] = Requirement.Write,
        ["SaveCanvasLibrary"] = Requirement.Write,
        ["GetPetSettings"] = Requirement.Read,
        ["SavePetSettings"] = Requirement.Write,
        ["GetPetConnection"] = Requirement.InteractiveOnly,
        ["ListPetProviderKeys"] = Requirement.Read,
        ["SavePetProviderKey"] = Requirement.InteractiveOnly,
        ["RemovePetProviderKey"] = Requirement.InteractiveOnly,
        ["PetRuntime"] = Requirement.InteractiveOnly,
        ["PetNoteRuntime"] = Requirement.InteractiveOnly,
        ["PetInlineWrite"] = Requirement.InteractiveOnly,
        ["WatchPetRuntime"] = Requirement.InteractiveOnly,
        ["WatchPetNoteRuntime"] = Requirement.InteractiveOnly,

        // Reading either is a normal Read; a PAT-driven automation should never be able to
        // change where reminders are pushed or which devices receive them.
        ["GetPreferences"] = Requirement.Read,
        ["SavePreferences"] = Requirement.InteractiveOnly,
        ["GetWorkspaceArrangement"] = Requirement.Read,
        ["SaveWorkspaceArrangement"] = Requirement.InteractiveOnly,
        ["GetUiSettings"] = Requirement.Read,
        ["PatchUiSettings"] = Requirement.InteractiveOnly,
        ["ListNotifications"] = Requirement.Read,
        ["MarkNotificationRead"] = Requirement.Write,
        ["MarkAllNotificationsRead"] = Requirement.Write,
        ["WatchNotifications"] = Requirement.Read,
        ["AddPushSubscription"] = Requirement.InteractiveOnly,
        ["RemovePushSubscription"] = Requirement.InteractiveOnly,
        ["GetPushPublicKey"] = Requirement.Read,
        ["CreateItem"] = Requirement.Write,
        ["CreateStructuredItem"] = Requirement.Write,
        ["SubmitPublicForm"] = Requirement.Write,
        ["ExchangeAccessToken"] = Requirement.Write,
        ["DeleteTemplate"] = Requirement.Write,
        ["CreateWorkspace"] = Requirement.Write,
        ["RenameWorkspace"] = Requirement.Write,
        ["OpenDailyNote"] = Requirement.Write,
        ["GetDailyNoteSettings"] = Requirement.Read,
        ["SaveDailyNoteSettings"] = Requirement.Write,
        ["BeginFileUpload"] = Requirement.Write,
        ["CompleteFileUpload"] = Requirement.Write,
        ["CancelFileUpload"] = Requirement.Write,
        ["BeginDocumentImport"] = Requirement.Write,
        ["PreviewDocumentImport"] = Requirement.Write,
        ["CommitDocumentImport"] = Requirement.Write,
        ["CancelDocumentImport"] = Requirement.Write,
        ["BeginTemplateImport"] = Requirement.Write,
        ["PreviewTemplateImport"] = Requirement.Write,
        ["CommitTemplateImport"] = Requirement.Write,
        ["CancelTemplateImport"] = Requirement.Write,
        ["BeginExport"] = Requirement.Write,

        ["CancelExport"] = Requirement.Write,
        ["CancelOperation"] = Requirement.Write,

        // A POST that only previews an application; classified Write because it is not a GET, which
        // over-restricts a read-only token from previewing rather than under-restricting - the
        // policy's deliberate one-sided failure mode.
        ["PreflightTemplateApplication"] = Requirement.Write,

        // Admin: what changes or exposes who can see what - permission entries, the public-link
        // surface whichever method reaches it (its GET reads back a live anonymous-write URL), and
        // a move, which re-parents an item into another audience through inheritance.
        ["UpsertAclEntry"] = Requirement.Admin,
        ["DeleteAclEntry"] = Requirement.Admin,
        ["GetPublicFormStatus"] = Requirement.Admin,
        ["PublishPublicForm"] = Requirement.Admin,
        ["RevokePublicForm"] = Requirement.Admin,
        ["MoveItem"] = Requirement.Admin,
        ["CreateWorkspaceInvitation"] = Requirement.Admin,
        ["SetWorkspaceSharing"] = Requirement.Admin,
        ["ListWorkspaceInvitees"] = Requirement.Admin,
        ["RevokeWorkspaceInvitation"] = Requirement.Admin,
        ["AcceptWorkspaceInvitation"] = Requirement.Admin,
        ["DeclineWorkspaceInvitation"] = Requirement.Admin,
        ["ChangeWorkspaceMemberRole"] = Requirement.Admin,
        ["RemoveWorkspaceMember"] = Requirement.Admin,
        ["LeaveWorkspace"] = Requirement.Admin,
        ["RecoverWorkspace"] = Requirement.Admin,
        ["ArchiveWorkspace"] = Requirement.Admin,
        ["RestoreWorkspace"] = Requirement.Admin,
        ["PurgeWorkspace"] = Requirement.Admin,

        // Sites publish a subtree to the public internet (ADR-0063): every change is admin for a
        // token, like publishing a view; reading a site, its builds and its paths is a read.
        ["GetItemSite"] = Requirement.Read,
        ["ListWorkspaceSites"] = Requirement.Read,
        ["GetSite"] = Requirement.Read,
        ["ListSiteBuilds"] = Requirement.Read,
        ["GetSiteBuild"] = Requirement.Read,
        ["ListSitePages"] = Requirement.Read,
        ["CreateSite"] = Requirement.Admin,
        ["UpdateSite"] = Requirement.Admin,
        ["DeleteSite"] = Requirement.Admin,
        ["SetSiteHostnames"] = Requirement.Admin,
        ["PublishSite"] = Requirement.Admin,
        ["RollbackSite"] = Requirement.Admin,
        ["UnpublishSite"] = Requirement.Admin,
        ["SetSitePagePath"] = Requirement.Admin,
        ["AddSiteHostname"] = Requirement.Admin,
        ["RemoveSiteHostname"] = Requirement.Admin,
        ["UpdateSiteHostname"] = Requirement.Admin,
        ["VerifySiteHostname"] = Requirement.Admin,
        ["RequestSiteApproval"] = Requirement.Admin,
        ["ListSiteApprovals"] = Requirement.Read,
        ["ListBackupRuns"] = Requirement.Read,
        ["ListSiteOperators"] = Requirement.Read,
        ["GrantSiteOperator"] = Requirement.Admin,
        ["RevokeSiteOperator"] = Requirement.Admin,
        ["GrantTenantAdmin"] = Requirement.Admin,
        ["RevokeTenantAdmin"] = Requirement.Admin,
        ["ApproveSitePublish"] = Requirement.Admin,
        ["RejectSitePublish"] = Requirement.Admin,
        ["BeginPluginComponentUpload"] = Requirement.Admin,
        ["RegisterWorkspacePlugin"] = Requirement.Admin,
        ["SetWorkspacePluginEnabled"] = Requirement.Admin,
        ["ReplaceWorkspacePluginCapabilities"] = Requirement.Admin,

        // Automations act later as their owner, unattended, with that owner's write access
        // (ADR-0051 section 6): creating, changing, running or deleting one is an admin-scope
        // capability for a token, never an ordinary write. Reading them stays a read.
        ["ListAutomations"] = Requirement.Read,
        ["GetAutomation"] = Requirement.Read,
        ["ListAutomationRuns"] = Requirement.Read,
        ["CreateAutomation"] = Requirement.Admin,
        ["UpdateAutomation"] = Requirement.Admin,
        ["DeleteAutomation"] = Requirement.Admin,
        ["RunAutomation"] = Requirement.Admin,
        ["TestAutomation"] = Requirement.Admin,

        // Calendar sync (ADR-0052): a token may read accounts, calendars, links and the log;
        // connecting or disconnecting an account is interactive-only (it hands a third party an
        // OAuth grant); creating, changing or deleting a link is admin (a link pushes workspace
        // data to a third party unattended); asking a link to sync now is an ordinary write.
        ["ListCalendarConnections"] = Requirement.Read,
        ["ListExternalCalendars"] = Requirement.Read,
        ["ListCalendarLinks"] = Requirement.Read,
        ["ListCalendarLinkLog"] = Requirement.Read,
        ["AuthorizeCalendarConnection"] = Requirement.InteractiveOnly,
        ["DeleteCalendarConnection"] = Requirement.InteractiveOnly,
        ["CreateCalendarLink"] = Requirement.Admin,
        ["UpdateCalendarLink"] = Requirement.Admin,
        ["DeleteCalendarLink"] = Requirement.Admin,
        ["ListWorkspaceCalendarLinks"] = Requirement.Read,
        ["UnlinkWorkspaceCalendar"] = Requirement.Admin,
        ["SyncCalendarLink"] = Requirement.Write,

        // A token never manages tokens, whatever it holds.
        ["ListAccessTokens"] = Requirement.InteractiveOnly,
        ["CreateAccessToken"] = Requirement.InteractiveOnly,
        ["RevokeAccessToken"] = Requirement.InteractiveOnly,
    };

    [Fact]
    public void Every_operation_in_the_contract_is_classified_and_classified_as_intended()
    {
        var contract = JsonDocument.Parse(File.ReadAllText(PublishedContract.Path()));
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var path in contract.RootElement.GetProperty("paths").EnumerateObject())
        {
            foreach (var operation in path.Value.EnumerateObject())
            {
                if (!IsHttpMethod(operation.Name))
                {
                    continue;
                }

                var operationId = operation.Value.GetProperty("operationId").GetString();
                Assert.False(string.IsNullOrEmpty(operationId), $"{path.Name} has no operationId.");
                Assert.True(
                    ExpectedByOperation.TryGetValue(operationId, out var expected),
                    $"Operation '{operationId}' ({operation.Name.ToUpperInvariant()} {path.Name}) "
                    + "is not classified. Add it to ExpectedByOperation with the scope a personal "
                    + "access token must hold - this table is where that decision is made "
                    + "deliberately.");

                var actual = Classify(operation.Name.ToUpperInvariant(), path.Name);
                Assert.True(
                    expected == actual,
                    $"Operation '{operationId}' classifies as {actual}, but the table says "
                    + $"{expected}. One of them is wrong; decide which.");

                seen.Add(operationId!);
            }
        }

        // Both directions: a row for an operation the contract no longer has is a stale decision.
        var stale = ExpectedByOperation.Keys.Except(seen, StringComparer.Ordinal).ToList();
        Assert.True(stale.Count == 0, "Classified but not in the contract: " + string.Join(", ", stale));
    }

    [Theory]
    [InlineData("PUT", "/api/v1/me/preferences")]
    [InlineData("PUT", "/api/v1/me/preferences/")]
    [InlineData("POST", "/api/v1/me/push-subscriptions/")]
    [InlineData("DELETE", "/api/v1/me/push-subscriptions//")]
    public void A_trailing_slash_does_not_turn_an_interactive_only_write_into_a_token_write(string method, string path)
    {
        // ASP.NET routing treats "/x/" as "/x", so the classifier must too.
        var requirement = Classify(method, path);

        Assert.Equal(Requirement.InteractiveOnly, requirement);
        Assert.False(Satisfies([AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin], requirement));
    }

    [Theory]
    [InlineData("POST", "/api/v1/items/00000000-0000-0000-0000-000000000001/move/")]
    [InlineData("POST", "/api/v1/workspaces/00000000-0000-0000-0000-000000000001/leave/")]
    [InlineData("POST", "/api/v1/workspaces/00000000-0000-0000-0000-000000000001/archive/")]
    [InlineData("GET", "/api/v1/workspaces/00000000-0000-0000-0000-000000000001/invitees/")]
    [InlineData("PUT", "/api/v1/workspaces/00000000-0000-0000-0000-000000000001/sharing")]
    [InlineData("PUT", "/api/v1/workspaces/00000000-0000-0000-0000-000000000001/sharing/")]
    public void A_trailing_slash_does_not_lower_an_admin_route(string method, string path) =>
        Assert.Equal(Requirement.Admin, Classify(method, path));

    [Theory]
    [InlineData("POST", "/api/v1/workspaces/00000000-0000-0000-0000-000000000001/automations")]
    [InlineData("POST", "/api/v1/workspaces/00000000-0000-0000-0000-000000000001/automations/")]
    [InlineData("PUT", "/api/v1/automations/00000000-0000-0000-0000-000000000002")]
    [InlineData("DELETE", "/api/v1/automations/00000000-0000-0000-0000-000000000002/")]
    [InlineData("POST", "/api/v1/automations/00000000-0000-0000-0000-000000000002/run")]
    [InlineData("POST", "/api/v1/automations/00000000-0000-0000-0000-000000000002/test")]
    public void Automation_writes_need_admin_even_for_a_write_scoped_token(string method, string path)
    {
        var requirement = Classify(method, path);

        Assert.Equal(Requirement.Admin, requirement);
        Assert.False(Satisfies([AccessTokenScopes.Read, AccessTokenScopes.Write], requirement));
    }

    [Theory]
    [InlineData("/api/v1/search/mentions")]
    [InlineData("/api/v1/search/mentions/")]
    [InlineData("/API/V1/SEARCH/MENTIONS")]
    public void Matching_mentions_is_a_read_even_though_it_is_a_post(string path) =>
        Assert.Equal(Requirement.Read, Classify("POST", path));

    [Theory]
    [InlineData("POST", "/api/v1/search/mentions/extra")]
    [InlineData("POST", "/api/v1/search")]
    [InlineData("PUT", "/api/v1/search/mentions")]
    [InlineData("DELETE", "/api/v1/search/mentions")]
    public void Only_the_exact_mentions_post_is_relaxed_to_a_read(string method, string path) =>
        Assert.Equal(Requirement.Write, Classify(method, path));

    [Theory]
    [InlineData("/api/v1/workspaces/11111111-1111-4111-8111-111111111111/query")]
    [InlineData("/api/v1/workspaces/11111111-1111-4111-8111-111111111111/query/")]
    [InlineData("/api/v1/workspaces/11111111-1111-4111-8111-111111111111/query/aggregate")]
    [InlineData("/API/V1/WORKSPACES/11111111-1111-4111-8111-111111111111/QUERY")]
    public void The_ad_hoc_query_is_a_read_even_though_it_is_a_post(string path)
    {
        Assert.Equal(Requirement.Read, Classify("POST", path));
        Assert.False(Satisfies([AccessTokenScopes.Write], Classify("POST", path)));
    }

    [Theory]
    [InlineData("POST", "/api/v1/workspaces//query")]
    [InlineData("POST", "/api/v1/workspaces/11111111-1111-4111-8111-111111111111/extra/query")]
    [InlineData("POST", "/api/v1/workspaces/11111111-1111-4111-8111-111111111111/query/aggregate/extra")]
    [InlineData("POST", "/api/v1/workspaces/11111111-1111-4111-8111-111111111111/items/query")]
    [InlineData("PUT", "/api/v1/workspaces/11111111-1111-4111-8111-111111111111/query")]
    public void Only_the_exact_query_posts_are_relaxed_to_a_read(string method, string path) =>
        Assert.Equal(Requirement.Write, Classify(method, path));

    [Fact]
    public void A_write_only_token_cannot_match_mentions()
    {
        Assert.False(Satisfies([AccessTokenScopes.Write], Classify("POST", "/api/v1/search/mentions")));
        Assert.True(Satisfies([AccessTokenScopes.Read], Classify("POST", "/api/v1/search/mentions")));
    }

    [Theory]
    [InlineData("/api/v1/workspaces/00000000-0000-0000-0000-000000000001/automations")]
    [InlineData("/api/v1/automations/00000000-0000-0000-0000-000000000002")]
    [InlineData("/api/v1/automations/00000000-0000-0000-0000-000000000002/runs")]
    public void Reading_automations_is_a_read(string path) =>
        Assert.Equal(Requirement.Read, Classify("GET", path));

    [Theory]
    [InlineData("POST", "/api/v1/me/calendar/connections/google/authorize/", Requirement.InteractiveOnly)]
    [InlineData("DELETE", "/api/v1/me/calendar/connections/00000000-0000-0000-0000-000000000001/", Requirement.InteractiveOnly)]
    [InlineData("POST", "/api/v1/me/calendar/links/", Requirement.Admin)]
    [InlineData("PATCH", "/api/v1/me/calendar/links/00000000-0000-0000-0000-000000000002", Requirement.Admin)]
    [InlineData("DELETE", "/api/v1/me/calendar/links/00000000-0000-0000-0000-000000000002/", Requirement.Admin)]
    [InlineData("POST", "/api/v1/me/calendar/links/00000000-0000-0000-0000-000000000002/sync/", Requirement.Write)]
    [InlineData("GET", "/api/v1/me/calendar/links/00000000-0000-0000-0000-000000000002/log", Requirement.Read)]
    [InlineData("GET", "/api/v1/me/calendar/connections/00000000-0000-0000-0000-000000000001/calendars", Requirement.Read)]
    public void Calendar_routes_are_classified_whatever_their_trailing_slash(string method, string path, Requirement expected) =>
        Assert.Equal(expected, Classify(method, path));

    [Theory]
    [InlineData("GET", "/api/v1/me/tokens")]
    [InlineData("GET", "/api/v1/me/pets/connection")]
    [InlineData("POST", "/api/v1/me/pets/runtime")]
    [InlineData("POST", "/api/v1/me/pets/runtime/note")]
    [InlineData("GET", "/api/v1/me/pets/runtime/note/watch")]
    [InlineData("POST", "/api/v1/me/pets/inline")]
    [InlineData("POST", "/api/v1/me/tokens")]
    [InlineData("DELETE", "/api/v1/me/tokens/00000000-0000-0000-0000-000000000001")]
    public void No_scope_admits_a_token_to_token_management(string method, string path)
    {
        var requirement = Classify(method, path);

        Assert.Equal(Requirement.InteractiveOnly, requirement);
        Assert.False(Satisfies([AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin], requirement));
    }

    [Fact]
    public void Scopes_are_independent_rather_than_ordered()
    {
        Assert.True(Satisfies([AccessTokenScopes.Read], Requirement.Read));
        Assert.False(Satisfies([AccessTokenScopes.Read], Requirement.Write));
        Assert.False(Satisfies([AccessTokenScopes.Write], Requirement.Read));
        Assert.False(Satisfies([AccessTokenScopes.Admin], Requirement.Write));
        Assert.True(Satisfies([AccessTokenScopes.Admin], Requirement.Admin));
    }

    [Fact]
    public void A_scope_spelling_this_build_cannot_interpret_grants_nothing()
    {
        Assert.False(Satisfies(["READ"], Requirement.Read));
        Assert.False(Satisfies(["everything"], Requirement.Read));
        Assert.False(Satisfies([], Requirement.Read));
    }

    [Fact]
    public void Permission_writes_need_admin_even_for_a_write_scoped_token()
    {
        var requirement = Classify(
            "PUT",
            "/api/v1/items/00000000-0000-0000-0000-000000000001/permissions/entries");

        Assert.Equal(Requirement.Admin, requirement);
        Assert.False(Satisfies([AccessTokenScopes.Read, AccessTokenScopes.Write], requirement));
    }

    private static bool IsHttpMethod(string name) => name is
        "get" or "put" or "post" or "delete" or "patch" or "head" or "options";
}
