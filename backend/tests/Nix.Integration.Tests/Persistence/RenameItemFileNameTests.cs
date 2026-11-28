using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Renaming an item over the real schema: a file item's stored file name follows its title, and a
/// non-file item's rename never touches <c>file_version</c> at all.
/// </summary>
/// <remarks>
/// <see cref="Nix.Tests.Features.Items.RenameItemTests"/> pins the same behaviour against fakes;
/// this is the database round trip - the actual row GitHub issue #54 was filed against, where the
/// file page's bar reads <c>file_version.file_name</c> and had stopped agreeing with the tree.
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class RenameItemFileNameTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Renaming_a_file_item_updates_the_current_version_file_name()
    {
        var workspace = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);
        ItemId itemId;

        await using (var upload = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var files = upload.Resolve<IFileStore>();
            var begun = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
                new BeginFileUpload(
                    workspace,
                    ParentId: null,
                    TargetItemId: null,
                    "old-report.pdf",
                    "application/pdf",
                    4,
                    "rename-file-create"),
                Cancellation));
            var published = Assert.IsType<FileRecord>(await files.CompleteAsync(
                new CompleteFileUpload(
                    FileUploadId.From(begun.Id),
                    "application/pdf",
                    4,
                    new string('a', 64),
                    Previewable: false,
                    PixelWidth: null,
                    PixelHeight: null),
                Cancellation));
            itemId = ItemId.From(published.ItemId);
            Assert.Equal("old-report.pdf", published.Current.FileName);
            await upload.CommitAsync(Cancellation);
        }

        await using (var rename = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var handler = rename.Resolve<ICommandHandler<RenameItem, Item>>();
            var result = await handler.HandleAsync(new RenameItem(itemId, "new-report"), Cancellation);

            Assert.True(result.IsSuccess);
            Assert.Equal("new-report", ItemProperties.ReadTitle(result.Value.Properties));
            await rename.CommitAsync(Cancellation);
        }

        await using var verify = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var fileName = await verify.DbContext.FileVersions
            .Where(version => version.ItemId == itemId)
            .Select(version => version.FileName)
            .SingleAsync(Cancellation);
        Assert.Equal("new-report.pdf", fileName);
    }

    [Fact]
    public async Task Renaming_a_note_item_touches_no_file_row()
    {
        ItemId itemId;
        await using (var create = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var handler = create.Resolve<ICommandHandler<CreateItem, Item>>();
            var result = await handler.HandleAsync(
                new CreateItem(
                    WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                    "note",
                    "Old notes",
                    ParentId: null,
                    Properties: null),
                Cancellation);
            Assert.True(result.IsSuccess);
            itemId = result.Value.Id;
            await create.CommitAsync(Cancellation);
        }

        await using (var rename = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var handler = rename.Resolve<ICommandHandler<RenameItem, Item>>();
            var result = await handler.HandleAsync(new RenameItem(itemId, "New notes"), Cancellation);

            Assert.True(result.IsSuccess);
            Assert.Equal("New notes", ItemProperties.ReadTitle(result.Value.Properties));
            await rename.CommitAsync(Cancellation);
        }

        await using var verify = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        Assert.Equal(0, await verify.DbContext.FileVersions.CountAsync(
            version => version.ItemId == itemId,
            Cancellation));
        Assert.Equal(0, await verify.DbContext.FileBodies.CountAsync(
            body => body.ItemId == itemId,
            Cancellation));
    }
}
