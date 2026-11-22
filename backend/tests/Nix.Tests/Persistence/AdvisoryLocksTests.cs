using Microsoft.EntityFrameworkCore;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence;

namespace Nix.Tests.Persistence;

public sealed class AdvisoryLocksTests
{
    private static readonly Guid Tenant = new("11111111-aaaa-4aaa-8aaa-111111111111");
    private static readonly Guid Principal = new("22222222-bbbb-4bbb-8bbb-222222222222");
    private static readonly Guid Other = new("33333333-cccc-4ccc-8ccc-333333333333");
    private static readonly Guid Extra = new("44444444-dddd-4ddd-8ddd-444444444444");

    // Other processes (older Core instances, apps/collab) hash these exact texts. A rename here
    // silently splits a lock in two, so each key is pinned to its literal.
    [Fact]
    public void Key_texts_never_change()
    {
        Assert.Equal("finance-workspace:33333333-cccc-4ccc-8ccc-333333333333", AdvisoryLockKeys.WorkspaceTopology(Other));
        Assert.Equal("finance:33333333-cccc-4ccc-8ccc-333333333333", AdvisoryLockKeys.ItemState(Other));
        Assert.Equal("habit:33333333-cccc-4ccc-8ccc-333333333333", AdvisoryLockKeys.Habit(Other));
        Assert.Equal("33333333-cccc-4ccc-8ccc-333333333333", AdvisoryLockKeys.WorkspaceFiles(Other));
        Assert.Equal("record-scope:11111111-aaaa-4aaa-8aaa-111111111111:33333333-cccc-4ccc-8ccc-333333333333",
            AdvisoryLockKeys.RecordScope(Tenant, Other));
        Assert.Equal("record-key:11111111-aaaa-4aaa-8aaa-111111111111:33333333-cccc-4ccc-8ccc-333333333333:f:v",
            AdvisoryLockKeys.RecordKey(Tenant, Other, "f", "v"));
        Assert.Equal("33333333-cccc-4ccc-8ccc-333333333333", AdvisoryLockKeys.DailyNote(Other));
        Assert.Equal("item-create:11111111-aaaa-4aaa-8aaa-111111111111:22222222-bbbb-4bbb-8bbb-222222222222:33333333-cccc-4ccc-8ccc-333333333333",
            AdvisoryLockKeys.ItemCreation(Tenant, Principal, Other));
        Assert.Equal("native-replay:11111111-aaaa-4aaa-8aaa-111111111111:22222222-bbbb-4bbb-8bbb-222222222222:33333333-cccc-4ccc-8ccc-333333333333",
            AdvisoryLockKeys.NativeReplay(Tenant, Principal, Other));
        Assert.Equal("site.tunnel_config", AdvisoryLockKeys.SiteTunnelConfig);
        Assert.Equal("site.create:11111111-aaaa-4aaa-8aaa-111111111111", AdvisoryLockKeys.SiteCreation(Tenant));
        Assert.Equal("nix.automation_rule.quota:11111111-aaaa-4aaa-8aaa-111111111111:22222222-bbbb-4bbb-8bbb-222222222222:33333333-cccc-4ccc-8ccc-333333333333",
            AdvisoryLockKeys.AutomationQuota(Tenant, Principal, Other));
        Assert.Equal("document-import:11111111aaaa4aaa8aaa111111111111:33333333cccc4ccc8ccc333333333333",
            AdvisoryLockKeys.DocumentImport(Tenant, Other));
        Assert.Equal("document-import-key:11111111aaaa4aaa8aaa111111111111:22222222bbbb4bbb8bbb222222222222:k",
            AdvisoryLockKeys.DocumentImportKey(Tenant, Principal, "k"));
        Assert.Equal("file-upload:11111111aaaa4aaa8aaa111111111111:33333333cccc4ccc8ccc333333333333",
            AdvisoryLockKeys.FileUpload(Tenant, Other));
        Assert.Equal("file-upload-key:11111111aaaa4aaa8aaa111111111111:22222222bbbb4bbb8bbb222222222222:k",
            AdvisoryLockKeys.FileUploadKey(Tenant, Principal, "k"));
        Assert.Equal("push_subscription:11111111-aaaa-4aaa-8aaa-111111111111:22222222-bbbb-4bbb-8bbb-222222222222",
            AdvisoryLockKeys.PushSubscription(Tenant, Principal));
        Assert.Equal("worker-job-key:11111111aaaa4aaa8aaa111111111111:22222222bbbb4bbb8bbb222222222222:k",
            AdvisoryLockKeys.WorkerJobKey(Tenant, Principal, "k"));
        Assert.Equal("template-workspace:11111111aaaa4aaa8aaa111111111111:33333333cccc4ccc8ccc333333333333",
            AdvisoryLockKeys.TemplateWorkspace(Tenant, Other));
        Assert.Equal("template-stages:11111111aaaa4aaa8aaa111111111111", AdvisoryLockKeys.TemplateStages(Tenant));
        Assert.Equal("template:11111111aaaa4aaa8aaa111111111111:33333333cccc4ccc8ccc333333333333",
            AdvisoryLockKeys.Template(Tenant, Other));
        Assert.Equal("template-application:11111111aaaa4aaa8aaa111111111111:33333333cccc4ccc8ccc333333333333:44444444dddd4ddd8ddd444444444444",
            AdvisoryLockKeys.TemplateApplication(Tenant, Other, Extra));
        Assert.Equal("template-idempotency:11111111aaaa4aaa8aaa111111111111:22222222bbbb4bbb8bbb222222222222:k",
            AdvisoryLockKeys.TemplateIdempotency(Tenant, Principal, "k"));
        Assert.Equal(0x4e69_785f_5365_7475L, AdvisoryLocks.SetupKey);
    }

    // apps/collab locks the workspace topology key in shared mode, so both sides must build the same text.
    [Fact]
    public void Workspace_topology_matches_what_collab_computes()
    {
        var workspace = Guid.Parse("AB12CD34-0000-4000-8000-0000000000EF");
        // Collab: `finance-workspace:${context.workspaceId.toLowerCase()}` (http/routes/updates.ts).
        Assert.Equal(
            "finance-workspace:ab12cd34-0000-4000-8000-0000000000ef",
            AdvisoryLockKeys.WorkspaceTopology(workspace));
        var collab = FindFromHere("apps/collab/src/http/routes/updates.ts");
        if (collab is not null)
        {
            Assert.Contains("`finance-workspace:${context.workspaceId.toLowerCase()}`", File.ReadAllText(collab), StringComparison.Ordinal);
        }
    }

    public static TheoryData<string> Acquisitions() => new()
    {
        "topology", "item", "habit", "files", "transfer", "scope", "keys", "setup", "daily", "creation", "replay",
        "tunnel", "site", "quota", "import", "importKey", "upload", "uploadKey", "push", "worker",
        "tplWorkspace", "tplStages", "tpl", "tplApplication", "tplIdempotency",
    };

    [Theory]
    [MemberData(nameof(Acquisitions))]
    public async Task Acquiring_outside_a_transaction_throws(string which)
    {
        var options = new DbContextOptionsBuilder<NixDbContext>().UseNpgsql("Host=unused;Database=unused").Options;
        await using var context = new NixDbContext(options);
        var locks = new AdvisoryLocks(context);
        var token = TestContext.Current.CancellationToken;
        var workspace = WorkspaceId.From(Other);
        var item = ItemId.From(Other);

        var call = which switch
        {
            "topology" => locks.AcquireWorkspaceTopologyAsync(workspace, token),
            "item" => locks.LockItemStateAsync(item, token),
            "habit" => ((Nix.Abstractions.IHabitLock)locks).AcquireAsync(item, token),
            "files" => locks.LockWorkspaceFilesAsync(workspace, token),
            "transfer" => locks.LockWorkspaceTransferAsync(workspace, WorkspaceId.From(Extra), token),
            "scope" => locks.LockRecordScopeAsync(Tenant, Other, true, token),
            "keys" => locks.LockRecordKeysAsync(Tenant, Other, [("f", "v")], token),
            "setup" => locks.LockSetupAsync(token),
            "daily" => locks.LockDailyNoteAsync(Other, token),
            "creation" => locks.LockItemCreationAsync(Tenant, Principal, Other, token),
            "replay" => locks.LockNativeReplayAsync(Tenant, Principal, Other, token),
            "tunnel" => locks.LockSiteTunnelConfigAsync(token),
            "site" => locks.LockSiteCreationAsync(Tenant, token),
            "quota" => locks.LockAutomationQuotaAsync(Tenant, Principal, Other, token),
            "import" => locks.LockDocumentImportAsync(Tenant, Other, token),
            "importKey" => locks.LockDocumentImportKeyAsync(Tenant, Principal, "k", token),
            "upload" => locks.LockFileUploadAsync(Tenant, Other, token),
            "uploadKey" => locks.LockFileUploadKeyAsync(Tenant, Principal, "k", token),
            "push" => locks.LockPushSubscriptionAsync(Tenant, Principal, token),
            "worker" => locks.LockWorkerJobKeyAsync(Tenant, Principal, "k", token),
            "tplWorkspace" => locks.LockTemplateWorkspaceAsync(Tenant, Other, token),
            "tplStages" => locks.LockTemplateStagesAsync(Tenant, token),
            "tpl" => locks.LockTemplateAsync(Tenant, Other, token),
            "tplApplication" => locks.LockTemplateApplicationAsync(Tenant, Other, Extra, token),
            "tplIdempotency" => locks.LockTemplateIdempotencyAsync(Tenant, Principal, "k", token),
            _ => throw new ArgumentOutOfRangeException(nameof(which)),
        };

        await Assert.ThrowsAsync<InvalidOperationException>(async () => await call);
    }

    private static string? FindFromHere(string relative)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, relative);
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }
        return null;
    }
}
