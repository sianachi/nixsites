using System.Text.Json;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Messages;
using Nix.Tests.Support;

namespace Nix.Tests.Features.Messages;

public sealed class MessagePetRunnerPromptTests
{
    private static readonly WorkspaceId Workspace = WorkspaceId.From(new Guid("11111111-1111-4111-8111-111111111111"));
    private static readonly PrincipalId Actor = PrincipalId.From(new Guid("66666666-6666-4666-8666-666666666666"));

    [Fact]
    public async Task The_prompt_names_the_addressing_message_even_when_it_is_not_last_in_the_walk()
    {
        // Walk order is M0, R1, R1a, R2: the person's R1a addressed the pet, but R2 comes last.
        var m0 = Message(1, null, "M0 question");
        var r1 = Message(2, m0, "R1 reply");
        var r1a = Message(3, r1, "R1a addressed to the pet");
        var r2 = Message(4, m0, "R2 other reply");
        var tree = new Tree(m0, r1, r1a, r2);

        var prompt = await MessagePetRunner.BuildPrompt(tree, r1a, CancellationToken.None);

        Assert.Contains("R2 other reply", prompt, StringComparison.Ordinal);
        var tail = prompt[prompt.IndexOf("The message that addressed you", StringComparison.Ordinal)..];
        Assert.Contains("R1a addressed to the pet", tail, StringComparison.Ordinal);
        Assert.DoesNotContain("R2 other reply", tail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_addressing_message_is_kept_when_the_walk_cannot_reach_it()
    {
        var m0 = Message(1, null, "M0 question");
        var children = Enumerable.Range(2, 150).Select(i => Message(i, m0, $"reply {i}")).ToArray();
        var late = children[^1];
        var tree = new Tree([m0, .. children]);

        var prompt = await MessagePetRunner.BuildPrompt(tree, late, CancellationToken.None);

        Assert.Contains("reply 151", prompt[prompt.IndexOf("The message that addressed you", StringComparison.Ordinal)..], StringComparison.Ordinal);
    }

    private static Item Message(int n, Item? parent, string text) => new()
    {
        Id = ItemId.From(new Guid(n, 0, 0, [0, 0, 0, 0, 0, 0, 0, 1])),
        TenantId = TenantId.From(new Guid("55555555-5555-4555-8555-555555555555")),
        WorkspaceId = Workspace,
        Type = MessageItem.Type,
        ParentId = parent?.Id,
        Seq = n * 1000L,
        Properties = JsonSerializer.Serialize(new Dictionary<string, string>
        {
            [MessageItem.Key] = JsonSerializer.Serialize(new { text, author = new { id = Guid.Empty, kind = "person", name = "Ada" } }),
        }),
        LifecycleState = ItemLifecycleState.Active,
        CreatedBy = Actor,
        LastModifiedBy = Actor,
        CreatedAt = DateTimeOffset.UnixEpoch,
        LastModifiedAt = DateTimeOffset.UnixEpoch,
    };

    private sealed class Tree(params Item[] items) : ThrowingItemTree
    {
        public override ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken) =>
            ValueTask.FromResult(items.FirstOrDefault(item => item.Id == id));

        public override ValueTask<IReadOnlyList<Item>> ListChildrenAsync(
            WorkspaceId workspaceId, ItemId? parentId, bool includeDeleted, long? afterSeq, int limit, CancellationToken cancellationToken) =>
            ValueTask.FromResult<IReadOnlyList<Item>>(items.Where(item => item.ParentId == parentId).OrderBy(item => item.Seq).Take(limit).ToList());
    }
}
