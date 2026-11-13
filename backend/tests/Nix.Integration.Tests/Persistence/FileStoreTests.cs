using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions.Files;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.ObjectStorage;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Universal files remain tenant-scoped, versioned, and idempotent.</summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class FileStoreTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Thumbnail_authorization_obeys_tenant_and_body_lock_boundaries()
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                UPDATE file_version SET thumbnail_width = 40, thumbnail_height = 60, thumbnail_bytes = 100
                WHERE item_id = '{M0SchemaSeed.Alpha.ItemId:D}';
                """);
        }

        await using (var alpha = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var files = alpha.Resolve<IFileStore>();
            var thumbnail = await files.AuthorizeThumbnailAsync(ItemId.From(M0SchemaSeed.Alpha.ItemId), null, Cancellation);
            Assert.NotNull(thumbnail);
            Assert.Equal(40, thumbnail.Width);
            Assert.Null(await files.AuthorizeThumbnailAsync(ItemId.From(M0SchemaSeed.Beta.ItemId), null, Cancellation));
        }

        var locking = await fixture.OpenMigratorConnectionAsync();
        await using (locking.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(locking, null, $"""
                INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
                VALUES ('{M0SchemaSeed.Alpha.ItemId:D}', '{M0SchemaSeed.Alpha.TenantId:D}',
                        '{new string('a', 64)}', '{M0SchemaSeed.Alpha.PrincipalId:D}', now());
                """);
        }
        await using var locked = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        Assert.Null(await locked.Resolve<IFileStore>().AuthorizeThumbnailAsync(ItemId.From(M0SchemaSeed.Alpha.ItemId), null, Cancellation));
    }

    [Fact]
    public async Task File_metadata_and_history_never_cross_tenants()
    {
        await using var alpha = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var alphaFiles = alpha.Resolve<IFileStore>();

        var own = await alphaFiles.GetAsync(ItemId.From(M0SchemaSeed.Alpha.ItemId), Cancellation);
        var other = await alphaFiles.GetAsync(ItemId.From(M0SchemaSeed.Beta.ItemId), Cancellation);

        Assert.NotNull(own);
        Assert.Equal("alpha.bin", own.Current.FileName);
        Assert.Null(other);
    }

    [Fact]
    public async Task File_metadata_and_downloads_never_cross_workspaces_inside_a_tenant()
    {
        var otherWorkspaceId = new Guid("1a1a1a1a-1111-4111-8111-1a1a1a1a1a2a");
        var otherItemId = new Guid("1e1e1e1e-1111-4111-8111-1e1e1e1e1e2e");
        var otherVersionId = new Guid("17171717-1111-4111-8111-171717171727");
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var command = new Npgsql.NpgsqlCommand(
                """
                DELETE FROM tenant_role
                 WHERE tenant_id = @tenant_id
                   AND subject_type = 'principal'
                   AND subject_id = @principal_id;
                INSERT INTO workspace
                    (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                     storage_quota_bytes, created_at)
                VALUES (@workspace_id, @tenant_id, 'Other workspace', 30, 10, 1073741824, now());
                INSERT INTO item
                    (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                     lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
                VALUES (@item_id, @tenant_id, @workspace_id, 'file', NULL, 1024,
                        '{"title":"private.bin"}'::jsonb, 'active', @principal_id,
                        @principal_id, now(), now());
                INSERT INTO item_closure
                    (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                VALUES (@item_id, @item_id, @tenant_id, @workspace_id, 0);
                INSERT INTO file_version
                    (file_version_id, tenant_id, workspace_id, item_id, version, object_key,
                     file_name, media_type, byte_length, sha256, previewable, created_by, created_at)
                VALUES (@version_id, @tenant_id, @workspace_id, @item_id, 1,
                        'files/private/object', 'private.bin', 'application/octet-stream', 4,
                        repeat('d', 64), false, @principal_id, now());
                INSERT INTO file_body (item_id, tenant_id, workspace_id, current_version_id)
                VALUES (@item_id, @tenant_id, @workspace_id, @version_id);
                """,
                connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddWithValue("tenant_id", M0SchemaSeed.Alpha.TenantId);
                command.Parameters.AddWithValue("principal_id", M0SchemaSeed.Alpha.PrincipalId);
                command.Parameters.AddWithValue("workspace_id", otherWorkspaceId);
                command.Parameters.AddWithValue("item_id", otherItemId);
                command.Parameters.AddWithValue("version_id", otherVersionId);
                await command.ExecuteNonQueryAsync(Cancellation);
            }
        }

        await using var alpha = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var files = alpha.Resolve<IFileStore>();

        Assert.Null(await files.GetAsync(ItemId.From(otherItemId), Cancellation));
        Assert.Null(await files.AuthorizeDownloadAsync(ItemId.From(otherItemId), null, Cancellation));
        Assert.NotNull(await files.GetAsync(ItemId.From(M0SchemaSeed.Alpha.ItemId), Cancellation));
    }

    [Fact]
    public async Task An_upload_publishes_one_file_item_and_replacement_preserves_history()
    {
        Guid itemId;
        await using (var first = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var files = first.Resolve<IFileStore>();
            var upload = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
                new BeginFileUpload(
                    WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                    ParentId: null,
                    TargetItemId: null,
                    "report.pdf",
                    "application/pdf",
                    12,
                    "file-create"),
                Cancellation));
            Assert.NotNull(await files.QueueInspectionAsync(FileUploadId.From(upload.Id), Cancellation));
            var published = Assert.IsType<FileRecord>(await files.CompleteAsync(
                new CompleteFileUpload(
                    FileUploadId.From(upload.Id),
                    "application/pdf",
                    12,
                    new string('a', 64),
                    Previewable: false,
                    PixelWidth: null,
                    PixelHeight: null),
                Cancellation));
            itemId = published.ItemId;
            Assert.Single(published.Versions);
            await first.CommitAsync(Cancellation);
        }

        await using (var replacement = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var files = replacement.Resolve<IFileStore>();
            var upload = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
                new BeginFileUpload(
                    WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                    ParentId: null,
                    TargetItemId: ItemId.From(itemId),
                    "report-v2.pdf",
                    "application/pdf",
                    20,
                    "file-replace"),
                Cancellation));
            Assert.NotNull(await files.QueueInspectionAsync(FileUploadId.From(upload.Id), Cancellation));
            var published = Assert.IsType<FileRecord>(await files.CompleteAsync(
                new CompleteFileUpload(
                    FileUploadId.From(upload.Id),
                    "application/pdf",
                    20,
                    new string('b', 64),
                    Previewable: false,
                    PixelWidth: null,
                    PixelHeight: null),
                Cancellation));

            Assert.Equal(2, published.Versions.Count);
            Assert.Equal("report-v2.pdf", published.Current.FileName);
            Assert.Equal(2, published.Current.Version);
            Assert.Contains(published.Versions, version => version.Version == 1 && !version.Current);
            await replacement.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Reusing_an_idempotency_key_for_different_metadata_is_a_conflict()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var files = work.Resolve<IFileStore>();
        var original = new BeginFileUpload(
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            ParentId: null,
            TargetItemId: null,
            "first.bin",
            "application/octet-stream",
            1,
            "same-key");

        Assert.NotNull(await files.BeginAsync(original, Cancellation));
        Assert.NotNull(await files.BeginAsync(original, Cancellation));
        Assert.Null(await files.BeginAsync(original with { FileName = "different.bin" }, Cancellation));
    }

    [Fact]
    public async Task Concurrent_retries_create_one_upload()
    {
        var request = new BeginFileUpload(
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            ParentId: null,
            TargetItemId: null,
            "concurrent.bin",
            "application/octet-stream",
            1,
            "concurrent-file-key");
        await using var first = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        await using var second = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);

        var firstResult = Assert.IsType<FileUploadRecord>(
            await first.Resolve<IFileStore>().BeginAsync(request, Cancellation));
        var secondTask = second.Resolve<IFileStore>().BeginAsync(request, Cancellation).AsTask();
        await first.CommitAsync(Cancellation);
        var secondResult = Assert.IsType<FileUploadRecord>(await secondTask);
        await second.CommitAsync(Cancellation);

        Assert.Equal(firstResult.Id, secondResult.Id);
        await using var verify = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        Assert.Equal(1, await verify.DbContext.FileUploads.CountAsync(
            upload => upload.IdempotencyKey == request.IdempotencyKey,
            Cancellation));
    }

    [Fact]
    public async Task Expired_uploads_are_failed_and_receive_durable_object_cleanup()
    {
        Guid uploadId;
        await using (var begin = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation))
        {
            var upload = Assert.IsType<FileUploadRecord>(await begin.Resolve<IFileStore>().BeginAsync(
                new BeginFileUpload(
                    WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                    ParentId: null,
                    TargetItemId: null,
                    "abandoned.bin",
                    "application/octet-stream",
                    4,
                    "abandoned-file"),
                Cancellation));
            uploadId = upload.Id;
            await begin.CommitAsync(Cancellation);
        }

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var command = new Npgsql.NpgsqlCommand(
                "UPDATE file_upload SET expires_at = now() - interval '1 minute' WHERE upload_id = @upload_id",
                connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddWithValue("upload_id", uploadId);
                await command.ExecuteNonQueryAsync(Cancellation);
            }
        }

        await using (var scope = fixture.Application.CreateUnscopedScope())
        {
            Assert.Equal(1, await scope.ServiceProvider
                .GetRequiredService<AbandonedObjectReaper>()
                .ReapOnceAsync(Cancellation));
        }

        await using var verify = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var uploadRecord = Assert.IsType<FileUploadRecord>(await verify.Resolve<IFileStore>()
            .GetUploadAsync(FileUploadId.From(uploadId), Cancellation));
        Assert.Equal("failed", uploadRecord.Status);
        Assert.Equal("upload_expired", uploadRecord.FailureCode);
        var cleanupJob = await verify.DbContext.WorkerJobs.SingleAsync(
            job => job.Kind == "object.cleanup" && job.IdempotencyKey == $"object.cleanup:file-upload:{uploadId:D}",
            Cancellation);
        using var cleanup = JsonDocument.Parse(cleanupJob.Payload);
        var targets = cleanup.RootElement.GetProperty("objectKeys")
            .EnumerateArray()
            .Select(value => value.GetString())
            .ToArray();
        Assert.Contains($"files/uploads/{M0SchemaSeed.Alpha.TenantId:D}/{uploadId:D}", targets);
        Assert.Contains($"files/versions/{M0SchemaSeed.Alpha.TenantId:D}/{uploadId:D}", targets);
    }

    [Fact]
    public async Task A_revoked_workspace_permission_prevents_late_publication()
    {
        Guid uploadId;
        await using (var begin = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var files = begin.Resolve<IFileStore>();
            var upload = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
                new BeginFileUpload(
                    WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                    ParentId: null,
                    TargetItemId: null,
                    "late.bin",
                    "application/octet-stream",
                    4,
                    "late-publication"),
                Cancellation));
            uploadId = upload.Id;
            Assert.NotNull(await files.QueueInspectionAsync(FileUploadId.From(upload.Id), Cancellation));
            await begin.CommitAsync(Cancellation);
        }

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var command = new Npgsql.NpgsqlCommand(
                """
                DELETE FROM workspace_member
                 WHERE tenant_id = @tenant_id
                   AND workspace_id = @workspace_id
                   AND subject_type = 'principal'
                   AND subject_id = @principal_id;
                DELETE FROM tenant_role
                 WHERE tenant_id = @tenant_id
                   AND subject_type = 'principal'
                   AND subject_id = @principal_id;
                """,
                connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddWithValue("tenant_id", M0SchemaSeed.Alpha.TenantId);
                command.Parameters.AddWithValue("workspace_id", M0SchemaSeed.Alpha.WorkspaceId);
                command.Parameters.AddWithValue("principal_id", M0SchemaSeed.Alpha.PrincipalId);
                await command.ExecuteNonQueryAsync(Cancellation);
            }
        }

        await using var publish = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var result = await publish.Resolve<IFileStore>().CompleteAsync(
            new CompleteFileUpload(
                FileUploadId.From(uploadId),
                "application/octet-stream",
                4,
                new string('c', 64),
                Previewable: false,
                PixelWidth: null,
                PixelHeight: null),
            Cancellation);

        Assert.Null(result);
        var objectKey = $"files/versions/{M0SchemaSeed.Alpha.TenantId:D}/{uploadId:D}";
        Assert.False(await publish.DbContext.FileVersions
            .AnyAsync(version => version.ObjectKey == objectKey, Cancellation));
    }
}
