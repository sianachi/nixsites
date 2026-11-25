using System.Diagnostics.CodeAnalysis;
using System.Text;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Features.Comments;
using Nix.Messaging;

namespace Nix.Features.PetRuns;

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class PetTaskCommentCapability(IVisibleItems visible, NixDispatcher dispatcher) : IPetRunCapability
{
    internal const string Id = "task.comment";
    internal static readonly NixError CommentsDisabled = new("comments.disabled",
        "Turn on Comments in this note's settings, then reply here so I can continue.");

    public string Name => Id;
    public string Description => "Draft a comment on the assigned Nix task for human review. Use argument body.";
    public JsonElement? InputSchema => Schema;
    public bool Atomic => true;

    private static readonly JsonElement Schema = ReadSchema();

    public async Task<Result<PetRunEffect>> PreviewAsync(PetRunRecord run, JsonElement args, CancellationToken cancellationToken)
    {
        if (args.ValueKind != JsonValueKind.Object || args.EnumerateObject().Count() != 1
            || !args.TryGetProperty("body", out var field) || field.ValueKind != JsonValueKind.String
            || field.GetString() is not { Length: > 0 and <= 4000 } body
            || string.IsNullOrWhiteSpace(body) || Encoding.UTF8.GetByteCount(body) > 8000)
        {
            return Result.Failure<PetRunEffect>(new NixError("pet_runs.invalid_comment", "Supply the exact comment text."));
        }

        var item = await FindNoteWithCommentPermissionAsync(run, cancellationToken).ConfigureAwait(false);
        if (item is null)
        {
            return Result.Failure<PetRunEffect>(Unavailable());
        }
        if (!ItemSettings.Read(item.Settings).Comments)
        {
            return Result.Failure<PetRunEffect>(CommentsDisabled);
        }

        var change = new PetTaskCommentPreview(item.Id.Value, ItemProperties.ReadTitle(item.Properties),
            "People with access to this task", item.LastModifiedAt, body.Trim());
        var preview = JsonSerializer.SerializeToElement(change, PetRunJsonContext.Default.PetTaskCommentPreview);
        return Result.Success(new PetRunEffect("Add a comment to the task", preview));
    }

    public async Task<Result<string>> ApplyAsync(PetRunRecord run, Guid actionId, PetRunEffect effect, CancellationToken cancellationToken)
    {
        var item = await FindNoteWithCommentPermissionAsync(run, cancellationToken).ConfigureAwait(false);
        var change = effect.Parameters.Deserialize(PetRunJsonContext.Default.PetTaskCommentPreview);
        if (item is null || !ItemSettings.Read(item.Settings).Comments || change is null
            || change.ItemId != item.Id.Value || change.Revision != item.LastModifiedAt)
        {
            return Result.Failure<string>(Unavailable());
        }

        var comment = await dispatcher.SendAsync<AddComment, CommentThreadDto>(
            new AddComment(item.Id, new AddCommentRequest(change.Body, null, null)), cancellationToken).ConfigureAwait(false);
        return comment.IsSuccess
            ? Result.Success(comment.Value.Id.ToString("D"))
            : Result.Failure<string>(comment.Error);
    }

    public async Task<string?> RevisionObservationAsync(PetRunRecord run, PetRunEffect effect, CancellationToken cancellationToken)
    {
        var change = effect.Parameters.Deserialize(PetRunJsonContext.Default.PetTaskCommentPreview);
        return change is not null && change.ItemId == run.ItemId?.Value
            && await FindNoteWithCommentPermissionAsync(run, cancellationToken).ConfigureAwait(false) is { } item
            && ItemSettings.Read(item.Settings).Comments
            ? change.Body
            : null;
    }

    private static JsonElement ReadSchema()
    {
        using var document = JsonDocument.Parse("""
            {"type":"object","required":["body"],"additionalProperties":false,
             "properties":{"body":{"type":"string","minLength":1,"maxLength":4000}}}
            """);
        return document.RootElement.Clone();
    }

    private async Task<Item?> FindNoteWithCommentPermissionAsync(PetRunRecord run, CancellationToken cancellationToken)
    {
        if (run.ItemId is not { } anchor)
        {
            return null;
        }
        var lookup = await visible.FindAsync(anchor, ItemAccess.Comment, cancellationToken).ConfigureAwait(false);
        return lookup.IsSuccess && lookup.Value.WorkspaceId == run.WorkspaceId && lookup.Value.Type == "note"
            ? lookup.Value
            : null;
    }

    private static NixError Unavailable() => new("pet_runs.conflict", "The task changed or no longer accepts comments.");
}
