using System.Globalization;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Scheduling;
using Nix.Domain.Tenancy;
using Nix.Features.Comments;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Note comments: who may write, who may change what, what a lock and the trash do, who is told,
/// and how a watcher learns of a change.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class NoteCommentTests : IAsyncLifetime
{
    private static readonly Guid Note = new("c0c0c000-4444-4444-8444-c0c0c0000001");
    private static readonly Guid LockedNote = new("c0c0c000-4444-4444-8444-c0c0c0000002");
    private static readonly Guid TrashedNote = new("c0c0c000-4444-4444-8444-c0c0c0000003");
    private static readonly Guid Viewer = new("c0c0c000-4444-4444-8444-c0c0c0000011");
    private static readonly Guid Commenter = new("c0c0c000-4444-4444-8444-c0c0c0000012");
    private static readonly Guid Editor = new("c0c0c000-4444-4444-8444-c0c0c0000013");
    private static readonly Guid Stranger = new("c0c0c000-4444-4444-8444-c0c0c0000014");

    private readonly NixPostgresFixture _fixture;

    public NoteCommentTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static NixSessionContext As(Guid principal) =>
        TestTenants.ContextFor(M0SchemaSeed.Alpha.TenantId, M0SchemaSeed.Alpha.WorkspaceId, principal);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_viewer_can_read_but_not_comment_and_a_commenter_and_an_editor_can()
    {
        Assert.Equal("comments.forbidden", (await AddAsync(Viewer, Note, "no")).Error.Code);
        Assert.True((await ListAsync(Viewer, Note)).IsSuccess);
        Assert.True((await AddAsync(Commenter, Note, "yes")).IsSuccess);
        Assert.True((await AddAsync(Editor, Note, "also")).IsSuccess);
    }

    [Fact]
    public async Task Only_the_author_edits_or_deletes_and_deleting_a_root_deletes_the_thread()
    {
        var thread = (await AddAsync(Commenter, Note, "root")).Value;
        var reply = (await SendAsync<ReplyComment, CommentThreadDto>(Editor, new ReplyComment(ItemId.From(Note), thread.Id, new("reply", null)))).Value;
        var replyId = reply.Comments[1].Id;

        Assert.Equal("comments.not_author", (await SendAsync<EditComment, CommentThreadDto>(Editor, new EditComment(ItemId.From(Note), thread.Id, new("x")))).Error.Code);
        Assert.Equal("comments.not_author", (await SendAsync<DeleteComment, Guid>(Editor, new DeleteComment(ItemId.From(Note), thread.Id))).Error.Code);

        var edited = (await SendAsync<EditComment, CommentThreadDto>(Commenter, new EditComment(ItemId.From(Note), thread.Id, new("root v2")))).Value;
        Assert.Equal("root v2", edited.Comments[0].Body);
        Assert.NotNull(edited.Comments[0].EditedAt);

        Assert.True((await SendAsync<DeleteComment, Guid>(Editor, new DeleteComment(ItemId.From(Note), replyId))).IsSuccess);
        Assert.True((await SendAsync<DeleteComment, Guid>(Commenter, new DeleteComment(ItemId.From(Note), thread.Id))).IsSuccess);
        Assert.Empty((await ListAsync(Editor, Note)).Value.Threads);
    }

    [Fact]
    public async Task A_locked_note_refuses_reads_and_writes_and_a_trashed_one_refuses_writes()
    {
        Assert.Equal("items.locked", (await AddAsync(Editor, LockedNote, "x")).Error.Code);
        Assert.Equal("items.locked", (await ListAsync(Editor, LockedNote)).Error.Code);
        Assert.Equal("items.lifecycle_conflict", (await AddAsync(Editor, TrashedNote, "x")).Error.Code);
    }

    [Fact]
    public async Task Resolving_and_anchoring_update_the_root()
    {
        var thread = (await SendAsync<AddComment, CommentThreadDto>(Commenter, new AddComment(ItemId.From(Note), new("q", null, new(null, null, "quoted text"))))).Value;
        Assert.Equal("quoted text", thread.Quote);
        Assert.Null(thread.AnchorStart);

        var anchored = (await SendAsync<SetCommentAnchor, CommentThreadDto>(Editor, new SetCommentAnchor(ItemId.From(Note), thread.Id, new("AAA=", "BBB=")))).Value;
        Assert.Equal("AAA=", anchored.AnchorStart);

        var resolved = (await SendAsync<SetCommentResolved, CommentThreadDto>(Editor, new SetCommentResolved(ItemId.From(Note), thread.Id, true))).Value;
        Assert.NotNull(resolved.ResolvedAt);
        Assert.Equal("Editor", resolved.ResolvedByName);
        Assert.Null((await SendAsync<SetCommentResolved, CommentThreadDto>(Editor, new SetCommentResolved(ItemId.From(Note), thread.Id, false))).Value.ResolvedAt);
    }

    [Fact]
    public async Task Notices_go_to_mentioned_people_and_other_thread_authors_but_never_the_actor()
    {
        var thread = (await SendAsync<AddComment, CommentThreadDto>(Commenter, new AddComment(ItemId.From(Note), new("hi", [Editor, Commenter], null)))).Value;
        Assert.Equal([Editor], await RecipientsAsync(thread.Id));

        var reply = (await SendAsync<ReplyComment, CommentThreadDto>(Editor, new ReplyComment(ItemId.From(Note), thread.Id, new("hello", [Stranger])))).Value;
        Assert.Equal([Commenter, Stranger], (await RecipientsAsync(reply.Comments[1].Id)).Order());
    }

    [Fact]
    public async Task A_notice_for_someone_who_cannot_read_the_note_is_skipped_and_one_for_a_member_is_delivered()
    {
        var thread = (await SendAsync<AddComment, CommentThreadDto>(Commenter, new AddComment(ItemId.From(Note), new("hi", [Editor, Stranger], null)))).Value;

        Assert.Equal(TriggerFireStatus.Skipped, (await FireAsync(Stranger, thread.Id)).Status);
        Assert.Equal(TriggerFireStatus.Fired, (await FireAsync(Editor, thread.Id)).Status);

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(1, await RawSql.CountAsync(connection, null, "SELECT count(*) FROM notification WHERE kind = 'comment'"));
            Assert.Equal(0, await RawSql.CountAsync(connection, null, $"SELECT count(*) FROM notification WHERE principal_id = {Literal(Stranger)}"));
        }
    }

    [Fact]
    public async Task An_imported_comment_queues_nothing()
    {
        var id = Guid.NewGuid();
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO note_comment (id, tenant_id, item_id, thread_id, author_principal_id, imported_author, body, mention_ids, created_at)
                VALUES ({Literal(id)}, {Literal(M0SchemaSeed.Alpha.TenantId)}, {Literal(Note)}, {Literal(id)}, {Literal(Commenter)}, 'Original Author', 'old', ARRAY[{Literal(Editor)}], now());
                """);
            Assert.Equal(0, await RawSql.CountAsync(connection, null, "SELECT count(*) FROM scheduled_trigger WHERE source = 'note.comment'"));
        }
    }

    [Fact]
    public async Task Every_change_bumps_the_revision_and_a_watch_returns_when_one_lands()
    {
        Assert.Equal(0, (await ListAsync(Editor, Note)).Value.Revision);
        var thread = (await AddAsync(Commenter, Note, "one")).Value;
        var revision = (await ListAsync(Editor, Note)).Value.Revision;
        Assert.True(revision >= 1);

        var watch = SendWatchAsync(Editor, revision);
        await Task.Delay(1500, Cancellation);
        Assert.False(watch.IsCompleted);

        await SendAsync<SetCommentResolved, CommentThreadDto>(Commenter, new SetCommentResolved(ItemId.From(Note), thread.Id, true));
        var changed = await watch.WaitAsync(TimeSpan.FromSeconds(10), Cancellation);
        Assert.True(changed.Value.Revision > revision);
        Assert.NotNull(changed.Value.Threads.Single().ResolvedAt);
    }

    [Fact]
    public async Task More_than_twenty_mentions_are_refused()
    {
        var mentions = Enumerable.Range(0, 21).Select(_ => Guid.NewGuid()).ToList();
        Assert.Equal("comments.invalid", (await SendAsync<AddComment, CommentThreadDto>(Commenter, new AddComment(ItemId.From(Note), new("x", mentions, null)))).Error.Code);
    }

    private Task<Result<CommentThreadDto>> AddAsync(Guid who, Guid note, string body) =>
        SendAsync<AddComment, CommentThreadDto>(who, new AddComment(ItemId.From(note), new(body, null, null)));

    private async Task<Result<CommentsResponse>> ListAsync(Guid who, Guid note)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(As(who), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>().QueryAsync<ListComments, Result<CommentsResponse>>(new ListComments(ItemId.From(note)), Cancellation);
        }
    }

    private async Task<Result<CommentsResponse>> SendWatchAsync(Guid who, long after)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(As(who), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>().QueryAsync<WatchComments, Result<CommentsResponse>>(new WatchComments(ItemId.From(Note), after), Cancellation);
        }
    }

    private async Task<Result<TValue>> SendAsync<TCommand, TValue>(Guid who, TCommand command)
        where TCommand : ICommand<TValue>
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(As(who), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>().SendAsync<TCommand, TValue>(command, Cancellation);
            if (result.IsSuccess)
            {
                await work.CommitAsync(Cancellation);
            }

            return result;
        }
    }

    private async Task<List<Guid>> RecipientsAsync(Guid commentId)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return [.. await RawSql.GuidListAsync(connection, null,
                $"SELECT principal_id FROM scheduled_trigger WHERE source = 'note.comment' AND rule_id = {Literal(commentId)}")];
        }
    }

    private async Task<TriggerOutcome> FireAsync(Guid recipient, Guid commentId)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(As(recipient), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var source = work.Resolve<IEnumerable<ITriggerSource>>().Single(candidate => candidate.Name == "note.comment");
            var outcome = await source.FireAsync(new DueTrigger(
                TenantId.From(M0SchemaSeed.Alpha.TenantId), Guid.NewGuid(), WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                PrincipalId.From(recipient), TriggerKind.System, "note.comment", Note, commentId, DateTimeOffset.UtcNow,
                "comment:" + commentId, 0), Cancellation);
            await work.CommitAsync(Cancellation);
            return outcome;
        }
    }

    private async Task SeedAsync()
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var granter = Literal(M0SchemaSeed.Alpha.PrincipalId);
        var sql = $$"""
            INSERT INTO principal (principal_id, tenant_id, external_subject, kind, display_name, email, status, deprovisioned_at)
            VALUES
                ({{Literal(Viewer)}}, {{tenant}}, 'c-viewer', 'user', 'Viewer', 'viewer@example.test', 'active', NULL),
                ({{Literal(Commenter)}}, {{tenant}}, 'c-commenter', 'user', 'Commenter', 'commenter@example.test', 'active', NULL),
                ({{Literal(Editor)}}, {{tenant}}, 'c-editor', 'user', 'Editor', 'editor@example.test', 'active', NULL),
                ({{Literal(Stranger)}}, {{tenant}}, 'c-stranger', 'user', 'Stranger', 'stranger@example.test', 'active', NULL);

            INSERT INTO workspace_member (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES
                ({{workspace}}, 'principal', {{Literal(Viewer)}}, {{tenant}}, 'viewer', {{granter}}, now()),
                ({{workspace}}, 'principal', {{Literal(Commenter)}}, {{tenant}}, 'commenter', {{granter}}, now()),
                ({{workspace}}, 'principal', {{Literal(Editor)}}, {{tenant}}, 'editor', {{granter}}, now());

            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state, purge_after, created_by, last_modified_by, created_at, last_modified_at)
            VALUES
                ({{Literal(Note)}}, {{tenant}}, {{workspace}}, 'note', NULL, 1000, '{"title": "Plan"}'::jsonb, 'active', NULL, {{granter}}, {{granter}}, now(), now()),
                ({{Literal(LockedNote)}}, {{tenant}}, {{workspace}}, 'note', NULL, 2000, '{"title": "Locked"}'::jsonb, 'active', NULL, {{granter}}, {{granter}}, now(), now()),
                ({{Literal(TrashedNote)}}, {{tenant}}, {{workspace}}, 'note', NULL, 3000, '{"title": "Old"}'::jsonb, 'deleted', NULL, {{granter}}, {{granter}}, now(), now());

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES
                ({{Literal(Note)}}, {{Literal(Note)}}, {{tenant}}, {{workspace}}, 0),
                ({{Literal(LockedNote)}}, {{Literal(LockedNote)}}, {{tenant}}, {{workspace}}, 0),
                ({{Literal(TrashedNote)}}, {{Literal(TrashedNote)}}, {{tenant}}, {{workspace}}, 0);

            INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
            VALUES ({{Literal(LockedNote)}}, {{tenant}}, 'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', {{granter}}, now());
            """;
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private static string Literal(Guid value) => $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
