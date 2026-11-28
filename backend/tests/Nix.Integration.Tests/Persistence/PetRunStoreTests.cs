using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Pets;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Features.Pets;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed partial class PetRunStoreTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private const string PetOrigin = "https://nix.pet-runs.test";
    private static readonly WorkspaceId AlphaWorkspace = WorkspaceId.From(TestTenants.AlphaWorkspace);
    private static readonly ItemId AlphaItem = ItemId.From(M0SchemaSeed.Alpha.ItemId);
    private static readonly PrincipalId AlphaActor = PrincipalId.From(TestTenants.AlphaPrincipal);
    private static readonly Guid Colleague = new("1b1b1b1b-2222-4222-8222-1b1b1b1b1b1b");
    private static readonly WorkspaceId Destination = WorkspaceId.From(new Guid("d1000000-0000-4000-8000-000000000001"));
    private static readonly DateTimeOffset StartedAt = new(2026, 1, 2, 3, 4, 5, TimeSpan.Zero);
    private static readonly string[] BrowseAbilities = ["browser.browse"];
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Downgrade_refuses_workspace_anchors_without_deleting_or_rewriting_them()
    {
        using var state = JsonDocument.Parse("{}");
        var run = NewRun(AlphaItem, state.RootElement) with { ItemId = null, SourceItemIds = [], RequestId = Guid.NewGuid() };
        Assert.True(await InSessionAsync(TestTenants.AlphaContext, store => store.CreateAsync(run, Cancellation)));
        var migration = new Nix.Persistence.Migrations.Generated.WorkspacePetPlans();
        var sql = Assert.Single(migration.DownOperations.OfType<Microsoft.EntityFrameworkCore.Migrations.Operations.SqlOperation>()).Sql;
        await using (var connection = await fixture.OpenMigratorConnectionAsync())
        {
            await using var transaction = await connection.BeginTransactionAsync(Cancellation);
            var failure = await Assert.ThrowsAsync<Npgsql.PostgresException>(() => RawSql.ExecuteAsync(connection, transaction, sql));
            Assert.Equal("P0001", failure.SqlState);
            await transaction.RollbackAsync(Cancellation);
        }
        var saved = await InSessionAsync(TestTenants.AlphaContext, store => store.GetAsync(run.Id, Cancellation));
        Assert.NotNull(saved);
        Assert.Null(saved.ItemId);
        Assert.Equal(run.RequestId, saved.RequestId);
        Assert.Equal(run.Revision, saved.Revision);
    }

    [Fact]
    public async Task Workspace_anchors_keep_owner_isolation_null_safe_identity_and_creation_idempotency()
    {
        using var state = JsonDocument.Parse("""{"planRequest":{"requestId":"11111111-1111-4111-8111-111111111111","sourceScope":{"kind":"workspace"}}}""");
        var requestId = Guid.NewGuid();
        var run = NewRun(AlphaItem, state.RootElement) with { ItemId = null, SourceItemIds = [], RequestId = requestId };
        Assert.True(await InSessionAsync(TestTenants.AlphaContext, store => store.CreateAsync(run, Cancellation)));
        var anchoredPlan = run with { Id = Guid.NewGuid(), ItemId = AlphaItem, RequestId = Guid.NewGuid() };
        Assert.True(await InSessionAsync(TestTenants.AlphaContext, store => store.CreateAsync(anchoredPlan, Cancellation)));
        var read = await InSessionAsync(TestTenants.AlphaContext, store => store.GetByRequestAsync(AlphaWorkspace, requestId, Cancellation));
        Assert.NotNull(read);
        Assert.Null(read.ItemId);
        Assert.Equal(run.Id, read.Id);
        Assert.False(await InSessionAsync(TestTenants.AlphaContext, store => store.CreateAsync(run with { Id = Guid.NewGuid() }, Cancellation)));
        Assert.False(await InSessionAsync(TestTenants.AlphaContext, store => store.UpdateAsync(Advance(run, run.State) with { ItemId = AlphaItem }, 1, Cancellation)));
        Assert.False(await InSessionAsync(TestTenants.AlphaContext, store => store.UpdateAsync(Advance(run, run.State) with { RequestId = Guid.NewGuid() }, 1, Cancellation)));
        Assert.True(await InSessionAsync(TestTenants.AlphaContext, store => store.UpdateAsync(Advance(run, run.State), 1, Cancellation)));
        Assert.Null(await InSessionAsync(TestTenants.BetaContext, store => store.GetAsync(run.Id, Cancellation)));
        Assert.False(await InSessionAsync(TestTenants.BetaContext, store => store.UpdateAsync(Advance(run, run.State), 1, Cancellation)));

        await using (var connection = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                DELETE FROM workspace_member WHERE tenant_id = '{TestTenants.Alpha:D}'
                    AND workspace_id = '{AlphaWorkspace.Value:D}' AND subject_id = '{AlphaActor.Value:D}';
                """);
        }
        Assert.Null(await InSessionAsync(TestTenants.AlphaContext, store => store.GetAsync(run.Id, Cancellation)));
        Assert.Null(await InSessionAsync(TestTenants.AlphaContext, store => store.GetAsync(anchoredPlan.Id, Cancellation)));
    }

    [Fact]
    public async Task Only_the_starting_actor_in_the_correct_tenant_and_workspace_can_see_or_update_a_run()
    {
        await using (var connection = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_subject, kind, display_name, email, status)
                VALUES ('{Colleague:D}', '{TestTenants.Alpha:D}', 'pet-run-colleague', 'user', 'Colleague',
                        'pet-run-colleague@example.test', 'active');
                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                VALUES ('{AlphaWorkspace.Value:D}', 'principal', '{Colleague:D}', '{TestTenants.Alpha:D}',
                        'editor', '{AlphaActor.Value:D}', now());
                """);
        }

        using var checkpoint = JsonDocument.Parse("""{"proposal":{"action":"draft","message":"Check the criteria"}}""");
        var run = NewRun(AlphaItem, checkpoint.RootElement);
        var alpha = TestTenants.AlphaContext;
        Assert.True(await InSessionAsync(alpha, store => store.CreateAsync(run, Cancellation)));

        var saved = await InSessionAsync(alpha, store => store.GetAsync(run.Id, Cancellation));
        Assert.NotNull(saved);
        Assert.Equal(run.Id, saved.Id);
        Assert.Equal(AlphaItem, saved.ItemId);
        Assert.Equal(AlphaWorkspace, saved.WorkspaceId);
        Assert.Equal(TenantId.From(TestTenants.Alpha), saved.TenantId);
        Assert.Equal(AlphaActor, saved.ActorId);
        Assert.Equal("Prepare a release checklist", saved.Brief);
        Assert.Equal([AlphaItem.Value], saved.SourceItemIds);
        Assert.Equal(["comment"], saved.Abilities);
        Assert.False(saved.WorkspaceScope);
        Assert.Equal("queued", saved.Status);
        Assert.Equal(1L, saved.Revision);
        Assert.Equal(StartedAt, saved.CreatedAt);
        Assert.Equal(StartedAt, saved.UpdatedAt);
        Assert.True(JsonElement.DeepEquals(checkpoint.RootElement, saved.State));
        Assert.Contains(
            await InSessionAsync(alpha, store => store.ListAsync(AlphaWorkspace, AlphaItem, Cancellation)),
            candidate => candidate.Id == run.Id);
        Assert.Contains(
            await InSessionAsync(alpha, store => store.ListAsync(AlphaWorkspace, null, Cancellation)),
            candidate => candidate.Id == run.Id);

        var colleague = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Colleague);
        var otherWorkspace = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.BetaWorkspace, TestTenants.AlphaPrincipal);
        foreach (var wrongContext in new[] { colleague, otherWorkspace, TestTenants.BetaContext })
        {
            Assert.Null(await InSessionAsync(wrongContext, store => store.GetAsync(run.Id, Cancellation)));
            Assert.Empty(await InSessionAsync(wrongContext, store => store.ListAsync(AlphaWorkspace, null, Cancellation)));
            Assert.False(await InSessionAsync(wrongContext, store => store.UpdateAsync(Advance(run, run.State), 1, Cancellation)));
        }
    }

    [Fact]
    public async Task Immutable_run_inputs_stay_fixed_and_only_one_checkpoint_wins_a_revision_race()
    {
        using var initial = JsonDocument.Parse("""{"proposal":{"action":"draft"}}""");
        using var first = JsonDocument.Parse("""{"receipt":"first"}""");
        using var second = JsonDocument.Parse("""{"receipt":"second"}""");
        var run = NewRun(AlphaItem, initial.RootElement);
        var context = TestTenants.AlphaContext;
        Assert.True(await InSessionAsync(context, store => store.CreateAsync(run, Cancellation)));

        var forged = Advance(run with { Brief = "Change the target", WorkspaceScope = true }, first.RootElement);
        Assert.False(await InSessionAsync(context, store => store.UpdateAsync(forged, 1, Cancellation)));
        var skipped = Advance(run, first.RootElement) with { Revision = 3 };
        Assert.False(await InSessionAsync(context, store => store.UpdateAsync(skipped, 1, Cancellation)));

        var decisions = await Task.WhenAll(
            InSessionAsync(context, store => store.UpdateAsync(Advance(run, first.RootElement), 1, Cancellation)),
            InSessionAsync(context, store => store.UpdateAsync(Advance(run, second.RootElement), 1, Cancellation)));
        Assert.Single(decisions, decision => decision);

        var resumed = await InSessionAsync(context, store => store.GetAsync(run.Id, Cancellation));
        Assert.NotNull(resumed);
        Assert.Equal("running", resumed.Status);
        Assert.Equal(2L, resumed.Revision);
        Assert.Equal(decisions[0] ? "first" : "second", resumed.State.GetProperty("receipt").GetString());
        Assert.Equal("Prepare a release checklist", resumed.Brief);
        Assert.False(resumed.WorkspaceScope);
        Assert.Equal(StartedAt.AddMinutes(1), resumed.UpdatedAt);
    }

    [Fact]
    public async Task Moving_the_task_to_another_workspace_does_not_move_or_reactivate_its_run()
    {
        await using (var connection = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO workspace
                    (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                     storage_quota_bytes, created_at, lifecycle_state)
                VALUES ('{Destination.Value:D}', '{TestTenants.Alpha:D}', 'Destination', 90, 10,
                        10737418240, now(), 'active');
                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                VALUES ('{Destination.Value:D}', 'principal', '{AlphaActor.Value:D}', '{TestTenants.Alpha:D}',
                        'editor', '{AlphaActor.Value:D}', now());
                """);
        }

        var alpha = TestTenants.AlphaContext;
        ItemId itemId;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(alpha, Cancellation))
        {
            var created = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(
                new CreateItem(AlphaWorkspace, "note", "Movable task", null, null), Cancellation);
            Assert.True(created.IsSuccess, created.IsFailure ? created.Error.Message : null);
            itemId = created.Value.Id;
            await work.CommitAsync(Cancellation);
        }

        using var checkpoint = JsonDocument.Parse("{}");
        var run = NewRun(itemId, checkpoint.RootElement);
        Assert.True(await InSessionAsync(alpha, store => store.CreateAsync(run, Cancellation)));

        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(alpha, Cancellation))
        {
            var moved = await work.Resolve<NixDispatcher>().SendAsync<MoveItem, Item>(
                new MoveItem(itemId, null, null, Destination), Cancellation);
            Assert.True(moved.IsSuccess, moved.IsFailure ? moved.Error.Message : null);
            Assert.Equal(Destination, moved.Value.WorkspaceId);
            await work.CommitAsync(Cancellation);
        }

        var destination = TestTenants.ContextFor(TestTenants.Alpha, Destination.Value, TestTenants.AlphaPrincipal);
        foreach (var context in new[] { alpha, destination })
        {
            Assert.Null(await InSessionAsync(context, store => store.GetAsync(run.Id, Cancellation)));
            Assert.False(await InSessionAsync(context, store => store.UpdateAsync(Advance(run, run.State), 1, Cancellation)));
        }
    }

    [Fact]
    public async Task Legacy_proposal_decisions_cannot_approve_a_whole_plan_checkpoint()
    {
        var proposal = Guid.NewGuid();
        using var checkpoint = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            petId = Guid.NewGuid(),
            proposals = new[]
            {
                new { id = proposal, capability = "task.rename", description = "Rename the task", preview = new { }, status = "pending" },
            },
            answers = Array.Empty<string>(),
            results = Array.Empty<object>(),
            turns = 1,
            planRequest = new
            {
                requestId = Guid.NewGuid(),
                sourceScope = new { kind = "selected", itemIds = new[] { AlphaItem.Value } },
            },
        }));
        var run = NewRun(AlphaItem, checkpoint.RootElement);
        await SaveWaitingAsync(run, "waiting_for_approval");
        await using var host = CreatePetHost();
        var browser = await SignInAsync(host);
        var route = $"/api/v1/items/{AlphaItem.Value:D}/pet-runs/{run.Id:D}/proposals/{proposal:D}/decision";

        using var response = await host.SendAsync(HttpMethod.Post, route, browser, new { approve = true });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var saved = await InSessionAsync(TestTenants.AlphaContext, store => store.GetAsync(run.Id, Cancellation));
        Assert.NotNull(saved);
        Assert.Equal("waiting_for_approval", saved.Status);
        Assert.Equal("pending", saved.State.GetProperty("proposals")[0].GetProperty("status").GetString());
    }

    [Fact]
    public async Task Only_one_browser_decision_can_approve_or_supersede_a_pending_proposal()
    {
        var proposal = Guid.NewGuid();
        using var checkpoint = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            petId = Guid.NewGuid(),
            proposals = new[]
            {
                new { id = proposal, capability = "task.rename", description = "Rename the task", preview = new { }, status = "pending" },
            },
            answers = Array.Empty<string>(),
            results = Array.Empty<object>(),
            turns = 1,
            includeTargetText = false,
        }));
        var run = NewRun(AlphaItem, checkpoint.RootElement);
        await SaveWaitingAsync(run, "waiting_for_approval");
        await using var host = CreatePetHost();
        var browser = await SignInAsync(host);
        var route = $"/api/v1/items/{AlphaItem.Value:D}/pet-runs/{run.Id:D}/proposals/{proposal:D}";

        var approve = host.SendAsync(HttpMethod.Post, route + "/decision", browser, new { approve = true });
        var revise = host.SendAsync(HttpMethod.Post, route + "/revise", browser, new { feedback = "Use a shorter title." });
        await Task.WhenAll(approve, revise);
        using var approved = await approve;
        using var revised = await revise;
        Assert.Equal([HttpStatusCode.OK, HttpStatusCode.Conflict], new[] { approved.StatusCode, revised.StatusCode }.Order().ToArray());

        var saved = await InSessionAsync(TestTenants.AlphaContext, store => store.GetAsync(run.Id, Cancellation));
        Assert.NotNull(saved);
        Assert.Equal(4L, saved.Revision);
        Assert.Equal("queued", saved.Status);
        Assert.Equal(approved.IsSuccessStatusCode ? "approved" : "superseded",
            saved.State.GetProperty("proposals")[0].GetProperty("status").GetString());
    }

    [Fact]
    public async Task A_note_job_starts_with_contextual_defaults_and_requires_an_exact_scope_decision_to_share_its_prose()
    {
        var (note, petId) = await CreateNoteWithPetAsync();
        await using var host = CreatePetHost();
        var browser = await SignInAsync(host);
        var route = $"/api/v1/items/{note.Value:D}/pet-runs";
        using var started = await host.SendAsync(HttpMethod.Post, route, browser,
            new { brief = "Draft a comment", includeTargetText = false, afterMessageId = "message-1" });
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
        using var initial = await SiteHttpHost.JsonAsync(started);
        Assert.Equal("message-1", initial.RootElement.GetProperty("afterMessageId").GetString());
        Assert.False(initial.RootElement.GetProperty("includeTargetText").GetBoolean());
        Assert.False(initial.RootElement.GetProperty("workspaceScope").GetBoolean());
        Assert.Equal(["nix.action", "task.comment", "task.rename"],
            initial.RootElement.GetProperty("abilities").EnumerateArray().Select(value => value.GetString()).ToArray());

        var question = Guid.NewGuid();
        using var state = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            petId,
            question = new { id = question, text = "May I see the current note?", scope = "source" },
            proposals = Array.Empty<object>(),
            answers = Array.Empty<string>(),
            results = Array.Empty<object>(),
            turns = 1,
            includeTargetText = false,
        }));
        var waiting = NewRun(note, state.RootElement) with { SourceItemIds = [] };
        await SaveWaitingAsync(waiting, "waiting_for_input");
        route += $"/{waiting.Id:D}";
        using var textAnswer = await host.SendAsync(HttpMethod.Post, route + "/answer", browser, new { questionId = question, answer = "Yes" });
        Assert.Equal(HttpStatusCode.Conflict, textAnswer.StatusCode);
        using var wrongQuestion = await host.SendAsync(HttpMethod.Post, route + "/scope", browser,
            new { questionId = Guid.NewGuid(), approve = true, sourceItemId = note.Value });
        Assert.Equal(HttpStatusCode.Conflict, wrongQuestion.StatusCode);
        using var scope = await host.SendAsync(HttpMethod.Post, route + "/scope", browser,
            new { questionId = question, approve = true, sourceItemId = note.Value });
        Assert.Equal(HttpStatusCode.OK, scope.StatusCode);
        using var granted = await SiteHttpHost.JsonAsync(scope);
        Assert.True(granted.RootElement.GetProperty("includeTargetText").GetBoolean());
        Assert.Equal("queued", granted.RootElement.GetProperty("status").GetString());
        Assert.Empty(granted.RootElement.GetProperty("sourceItemIds").EnumerateArray());
    }

    [Fact]
    public async Task A_comment_job_waits_for_comments_to_be_enabled_and_keeps_the_applied_rename()
    {
        var (note, petId) = await CreateNoteWithPetAsync();
        using var planner = new RenameAndCommentPlanner();
        await using var host = CreatePetHost(planner);
        var browser = await SignInAsync(host);
        var itemPath = $"/api/v1/items/{note.Value:D}";
        using var started = await host.SendAsync(HttpMethod.Post, itemPath + "/pet-runs", browser,
            new { brief = "Rename the task to Review checklist and comment with 'Confirm the owner.'", includeTargetText = false });
        started.EnsureSuccessStatusCode();
        using var initial = await SiteHttpHost.JsonAsync(started);
        var route = itemPath + $"/pet-runs/{initial.RootElement.GetProperty("id").GetGuid():D}";

        var rename = Assert.Single((await WaitForRunAsync(host, browser, route, "waiting_for_approval"))
            .GetProperty("proposals").EnumerateArray());
        Assert.Equal("task.rename", rename.GetProperty("capability").GetString());
        var renameId = rename.GetProperty("id").GetGuid();
        using var approved = await host.SendAsync(HttpMethod.Post, route + $"/proposals/{renameId:D}/decision", browser, new { approve = true });
        approved.EnsureSuccessStatusCode();

        var paused = await WaitForRunAsync(host, browser, route, "waiting_for_input");
        var question = paused.GetProperty("question");
        Assert.Equal("Turn on Comments in this note's settings, then reply here so I can continue.",
            question.GetProperty("text").GetString());
        var applied = Assert.Single(paused.GetProperty("proposals").EnumerateArray());
        Assert.Equal(renameId, applied.GetProperty("id").GetGuid());
        Assert.Equal("applied", applied.GetProperty("status").GetString());
        Assert.False(string.IsNullOrWhiteSpace(applied.GetProperty("receipt").GetString()));

        using var enabled = await host.SendAsync(HttpMethod.Put, itemPath + "/settings", browser, new { comments = true });
        enabled.EnsureSuccessStatusCode();
        using var answered = await host.SendAsync(HttpMethod.Post, route + "/answer", browser,
            new { questionId = question.GetProperty("id").GetGuid(), answer = "Comments are on. Continue." });
        answered.EnsureSuccessStatusCode();

        var review = await WaitForRunAsync(host, browser, route, "waiting_for_approval");
        var proposals = review.GetProperty("proposals");
        Assert.Equal(2, proposals.GetArrayLength());
        Assert.Equal(applied.GetProperty("receipt").GetString(), proposals[0].GetProperty("receipt").GetString());
        var comment = proposals[1];
        Assert.Equal("task.comment", comment.GetProperty("capability").GetString());
        Assert.Equal("Confirm the owner.", comment.GetProperty("preview").GetProperty("body").GetString());
        Assert.Equal("pending", comment.GetProperty("status").GetString());
    }

    [Fact]
    public async Task A_browse_job_gives_the_planner_a_bounded_page_title_and_body_excerpt()
    {
        var (note, petId) = await CreateNoteWithPetAsync();
        using var worker = new BrowseWorkers();
        await using var host = CreatePetHost(worker, worker);
        var browser = await SignInAsync(host);
        var itemPath = $"/api/v1/items/{note.Value:D}";
        using var started = await host.SendAsync(HttpMethod.Post, itemPath + "/pet-runs", browser,
            new { brief = "Read the fixture page and describe its title and heading.", abilities = BrowseAbilities, includeTargetText = false });
        started.EnsureSuccessStatusCode();
        using var initial = await SiteHttpHost.JsonAsync(started);
        var route = itemPath + $"/pet-runs/{initial.RootElement.GetProperty("id").GetGuid():D}";

        var visit = Assert.Single((await WaitForRunAsync(host, browser, route, "waiting_for_approval"))
            .GetProperty("proposals").EnumerateArray());
        Assert.Equal("browser.browse", visit.GetProperty("capability").GetString());
        var proposal = visit.GetProperty("id").GetGuid();
        using var approved = await host.SendAsync(HttpMethod.Post, route + $"/proposals/{proposal:D}/decision", browser, new { approve = true });
        approved.EnsureSuccessStatusCode();
        await WaitForRunAsync(host, browser, route, "completed");

        Assert.EndsWith(
            $"https://fixture.test/form\nPage title: {BrowseWorkers.Title[..100]}\nForm 0 fields summary\nBody excerpt: {BrowseWorkers.Body[..180]}",
            worker.Observation, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false, "planning", "pets.task_step_invalid")]
    [InlineData(true, "preview", "pet_runs.invalid_action")]
    public async Task A_failed_step_persists_a_safe_stage_and_reason_without_a_proposal(bool invalidPreview, string stage, string code)
    {
        var (note, petId) = await CreateNoteWithPetAsync();
        using var planner = new RefusedStepPlanner(invalidPreview, note.Value);
        await using var host = CreatePetHost(planner);
        var browser = await SignInAsync(host);
        var route = $"/api/v1/items/{note.Value:D}/pet-runs";
        using var started = await host.SendAsync(HttpMethod.Post, route, browser,
            new { brief = "Append a checklist item while preserving the note.", includeTargetText = false });
        started.EnsureSuccessStatusCode();
        using var initial = await SiteHttpHost.JsonAsync(started);
        route += $"/{initial.RootElement.GetProperty("id").GetGuid():D}";

        var failed = await WaitForRunAsync(host, browser, route, "failed");
        Assert.Empty(failed.GetProperty("proposals").EnumerateArray());
        var failure = failed.GetProperty("failure");
        Assert.Equal(stage, failure.GetProperty("stage").GetString());
        Assert.Equal(code, failure.GetProperty("code").GetString());
        Assert.Equal(invalidPreview
            ? "An action body parameter is not part of the current API operation."
            : "The pet returned a planning step that Nix could not use. Retry the job.", failure.GetProperty("message").GetString());
        Assert.DoesNotContain(RefusedStepPlanner.PrivateProviderText, failed.GetRawText(), StringComparison.Ordinal);

        using var reread = await host.SendAsync(HttpMethod.Get, route, browser);
        reread.EnsureSuccessStatusCode();
        using var durable = await SiteHttpHost.JsonAsync(reread);
        Assert.Equal(code, durable.RootElement.GetProperty("failure").GetProperty("code").GetString());

        using var retry = await host.SendAsync(HttpMethod.Post, route + "/retry", browser);
        retry.EnsureSuccessStatusCode();
        using var queued = await SiteHttpHost.JsonAsync(retry);
        Assert.Equal(initial.RootElement.GetProperty("id").GetGuid(), queued.RootElement.GetProperty("id").GetGuid());
        Assert.Equal("queued", queued.RootElement.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, queued.RootElement.GetProperty("failure").ValueKind);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Appending_supplied_text_can_be_reviewed_without_a_read_and_an_unshared_read_requests_consent(bool readFirst)
    {
        var (note, petId) = await CreateNoteWithPetAsync();
        using var planner = new AppendPlanner(note.Value, readFirst);
        using var body = new NoteBodyFixture();
        await using var host = CreatePetHost(planner, noteBody: body);
        var browser = await SignInAsync(host);
        var route = $"/api/v1/items/{note.Value:D}/pet-runs";
        using var started = await host.SendAsync(HttpMethod.Post, route, browser,
            new { brief = "Append the exact unchecked checklist item.", includeTargetText = false });
        started.EnsureSuccessStatusCode();
        using var initial = await SiteHttpHost.JsonAsync(started);
        route += $"/{initial.RootElement.GetProperty("id").GetGuid():D}";

        if (readFirst)
        {
            var paused = await WaitForRunAsync(host, browser, route, "waiting_for_input");
            Assert.Equal("source", paused.GetProperty("question").GetProperty("scope").GetString());
            Assert.Equal(0, body.Reads);
            Assert.False(planner.SawNoteText);
            Assert.Empty(paused.GetProperty("proposals").EnumerateArray());
            using var granted = await host.SendAsync(HttpMethod.Post, route + "/scope", browser,
                new { questionId = paused.GetProperty("question").GetProperty("id").GetGuid(), approve = true, sourceItemId = note.Value });
            granted.EnsureSuccessStatusCode();
        }

        var review = await WaitForRunAsync(host, browser, route, "waiting_for_approval");
        var proposal = Assert.Single(review.GetProperty("proposals").EnumerateArray());
        Assert.Equal("pending", proposal.GetProperty("status").GetString());
        Assert.Equal("AppendItemBody", proposal.GetProperty("preview").GetProperty("operationId").GetString());
        Assert.Equal(AppendPlanner.Addition, proposal.GetProperty("preview").GetProperty("inputs").GetProperty("body").GetProperty("markdown").GetString());
        Assert.Equal(readFirst, review.GetProperty("includeTargetText").GetBoolean());
        Assert.Equal(readFirst, planner.SawNoteText);
        Assert.Equal(0, body.Writes);
        Assert.True(body.Reads > 0);
        Assert.True(planner.SawTextConsentMetadata);
        Assert.True(planner.SawAppendExample);
    }

    private async Task<(ItemId Note, Guid PetId)> CreateNoteWithPetAsync()
    {
        var petId = Guid.NewGuid();
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var dispatcher = work.Resolve<NixDispatcher>();
        var item = await dispatcher.SendAsync<CreateItem, Item>(new(AlphaWorkspace, "note", "Test target note", null, null), Cancellation);
        Assert.True(item.IsSuccess);
        var preferences = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), Cancellation);
        var saved = await dispatcher.SendAsync<SavePetSettings, PetSettingsResponse>(new(preferences.Revision,
            new PetSettings(true, petId, [new PetProfile(petId, "Owl", "owl", "")])), Cancellation);
        Assert.True(saved.IsSuccess);
        // The recipient revision of a key provider is its key's save time, so the pet needs a key.
        await work.Resolve<IPetProviderCredentialStore>().SaveAsync(new PetProviderCredential
        {
            TenantId = TenantId.From(TestTenants.Alpha),
            PrincipalId = PrincipalId.From(TestTenants.AlphaPrincipal),
            Provider = "anthropic",
            ProtectedKey = PetTestKeys.ProtectedKey,
            KeyHint = "-key",
            SavedAt = DateTimeOffset.UtcNow,
        }, Cancellation);
        await work.CommitAsync(Cancellation);
        return (item.Value.Id, petId);
    }

    private static async Task<JsonElement> WaitForRunAsync(SiteHttpHost host, string browser, string route, string expected)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(Cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        while (true)
        {
            using var response = await host.SendAsync(HttpMethod.Get, route, browser);
            response.EnsureSuccessStatusCode();
            using var state = await SiteHttpHost.JsonAsync(response);
            var status = state.RootElement.GetProperty("status").GetString();
            if (status is not ("queued" or "running"))
            {
                Assert.Equal(expected, status);
                return state.RootElement.Clone();
            }
            await Task.Delay(TimeSpan.FromMilliseconds(100), timeout.Token);
        }
    }

    private async Task SaveWaitingAsync(PetRunRecord run, string status)
    {
        await InSessionAsync(TestTenants.AlphaContext, async store =>
        {
            Assert.True(await store.CreateAsync(run, Cancellation));
            var running = Advance(run, run.State);
            Assert.True(await store.UpdateAsync(running, run.Revision, Cancellation));
            var waiting = running with { Revision = running.Revision + 1, Status = status };
            Assert.True(await store.UpdateAsync(waiting, running.Revision, Cancellation));
            return true;
        });
    }

    private SiteHttpHost CreatePetHost(HttpMessageHandler? planner = null, HttpMessageHandler? browser = null, HttpMessageHandler? noteBody = null) =>
        SiteHttpHost.Create(fixture, new Dictionary<string, string?>
        {
            ["Nix:Bff:PublicOrigin"] = PetOrigin,
            ["Nix:PetRuns:Enabled"] = "true",
            ["Nix:PetRuns:AllowedWorkspaces:0"] = AlphaWorkspace.Value.ToString("D"),
            ["Nix:Pets:WorkerUrl"] = "https://companion.test/",
            ["Nix:PetBrowser:Url"] = "https://browser-worker.test/",
            ["Nix:PetBrowser:InternalSecret"] = SiteHttpHost.InternalSecret,
            ["Nix:Workers:Families:0"] = planner is null ? "notify" : "pet",
        }, services =>
        {
            services.AddSingleton(PetTestKeys.Protector);
            if (planner is not null)
            {
                services.AddHttpClient<PetWorkerClient>().ConfigurePrimaryHttpMessageHandler(() => planner);
            }
            if (browser is not null)
            {
                services.AddHttpClient("PetBrowserClient").ConfigurePrimaryHttpMessageHandler(() => browser);
            }
            if (noteBody is not null)
            {
                services.AddHttpClient<ItemBodyClient>().ConfigurePrimaryHttpMessageHandler(() => noteBody);
            }
        });

    private static HttpResponseMessage PlanningResult(string text) => new(HttpStatusCode.OK)
    {
        Content = new StringContent("event: done\ndata: " + JsonSerializer.Serialize(new { text }) + "\n\n",
            Encoding.UTF8, "text/event-stream"),
    };

    private sealed class AppendPlanner(Guid noteId, bool readFirst) : HttpMessageHandler
    {
        internal const string Addition = "- [ ] Check the label before closing the box.";
        private int _turns;
        internal bool SawNoteText { get; private set; }
        internal bool SawTextConsentMetadata { get; private set; }
        internal bool SawAppendExample { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            using var input = await request.Content!.ReadFromJsonAsync<JsonDocument>(cancellationToken: cancellationToken);
            var context = input!.RootElement.GetProperty("contextText").GetString()!;
            SawNoteText |= context.Contains(NoteBodyFixture.ExistingText, StringComparison.Ordinal);
            SawTextConsentMetadata |= context.Contains("Target note text is not shared.", StringComparison.Ordinal);
            SawAppendExample |= input.RootElement.GetProperty("sharedText").GetString()!.Contains("Append preserves existing note blocks", StringComparison.Ordinal);
            if (Interlocked.Increment(ref _turns) == 1 && readFirst)
            {
                return PlanningResult(JsonSerializer.Serialize(new
                {
                    kind = "action",
                    capability = "nix.action",
                    arguments = new { operationId = "GetItemBody", path = new { itemId = noteId } },
                }));
            }
            return PlanningResult(JsonSerializer.Serialize(new
            {
                kind = "action",
                capability = "nix.action",
                arguments = new { operationId = "AppendItemBody", path = new { itemId = noteId }, body = new { markdown = Addition } },
            }));
        }
    }

    private sealed class NoteBodyFixture : HttpMessageHandler
    {
        internal const string ExistingText = "Existing checklist content";
        private readonly Guid _document = Guid.NewGuid();
        internal int Reads { get; private set; }
        internal int Writes { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Method == HttpMethod.Get)
            {
                Reads++;
            }
            else
            {
                Writes++;
                throw new InvalidOperationException("A pending draft must not write to the note.");
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = JsonContent.Create(new
                {
                    markdown = ExistingText,
                    schemaVersion = 1,
                    empty = false,
                    losses = Array.Empty<object>(),
                    revision = new { documentId = _document, headSeq = "0" },
                }),
            });
        }
    }

    private sealed class RefusedStepPlanner(bool invalidPreview, Guid noteId) : HttpMessageHandler
    {
        internal const string PrivateProviderText = "private synthetic provider detail";

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(PlanningResult(invalidPreview
                ? JsonSerializer.Serialize(new { kind = "action", capability = "nix.action", arguments = new { operationId = "AppendItemBody", path = new { itemId = noteId }, body = new { text = "invalid property" } } })
                : PrivateProviderText));
    }

    private sealed class BrowseWorkers : HttpMessageHandler
    {
        internal static readonly string Title = "Pet workspace fixture form " + new string('t', 110);
        internal static readonly string Body = "Release fixture form\n\n" + new string('b', 190);
        private int _turns;

        internal string? Observation { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri?.Host == "browser-worker.test")
            {
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = JsonContent.Create(new
                    {
                        citation = "https://fixture.test/form",
                        title = Title,
                        text = Body,
                        forms = new[] { new { index = 0, supported = true, fields = new[] { new { name = "summary" } } } },
                    }),
                };
            }
            if (Interlocked.Increment(ref _turns) == 1)
            {
                return PlanningResult("""{"kind":"action","capability":"browser.browse","arguments":{"url":"https://fixture.test/form"}}""");
            }

            using var input = await request.Content!.ReadFromJsonAsync<JsonDocument>(cancellationToken: cancellationToken);
            using var context = JsonDocument.Parse(input!.RootElement.GetProperty("contextText").GetString()!);
            Observation = context.RootElement.GetProperty("observations").EnumerateArray().Select(item => item.GetString())
                .SingleOrDefault(item => item?.StartsWith("Untrusted result for ", StringComparison.Ordinal) is true);
            return PlanningResult("""{"kind":"complete","text":"Read the fixture page."}""");
        }
    }

    private sealed class RenameAndCommentPlanner : HttpMessageHandler
    {
        private int _turns;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var text = Interlocked.Increment(ref _turns) switch
            {
                1 => """{"kind":"action","capability":"task.rename","arguments":{"title":"Review checklist"}}""",
                2 or 3 => """{"kind":"action","capability":"task.comment","arguments":{"body":"Confirm the owner."}}""",
                _ => throw new InvalidOperationException("Unexpected pet planning turn."),
            };
            return Task.FromResult(PlanningResult(text));
        }
    }

    private async Task<string> SignInAsync(SiteHttpHost host)
    {
        var secret = BrowserSessionSecret.Mint();
        await using (var connection = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                UPDATE browser_session SET token_hash = '{secret.Hash}'
                WHERE principal_id = '{AlphaActor.Value:D}'
                """);
        }
        host.Client.DefaultRequestHeaders.Add("Cookie", "__Host-nix_session=" + secret.Token);
        host.Client.DefaultRequestHeaders.Add("Origin", PetOrigin);
        using var response = await host.Client.GetAsync(new Uri("/auth/session", UriKind.Relative), Cancellation);
        response.EnsureSuccessStatusCode();
        using var session = await SiteHttpHost.JsonAsync(response);
        return session.RootElement.GetProperty("accessToken").GetString()!;
    }

    private static PetRunRecord NewRun(ItemId itemId, JsonElement state) =>
        new(Guid.NewGuid(), itemId, AlphaWorkspace, TenantId.From(TestTenants.Alpha), AlphaActor,
            "Prepare a release checklist", [itemId.Value], false, ["comment"], "queued", 1, state, StartedAt, StartedAt);

    private static PetRunRecord Advance(PetRunRecord run, JsonElement state) =>
        run with { Status = "running", Revision = 2, State = state, UpdatedAt = StartedAt.AddMinutes(1) };

    private async Task<T> InSessionAsync<T>(NixSessionContext context, Func<IPetRunStore, Task<T>> operation)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        var result = await operation(work.Resolve<IPetRunStore>());
        await work.CommitAsync(Cancellation);
        return result;
    }
}
