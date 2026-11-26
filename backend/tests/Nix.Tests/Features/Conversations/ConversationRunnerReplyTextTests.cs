using Nix.Features.Conversations;
using Nix.Features.Pets;

namespace Nix.Tests.Features.Conversations;

public sealed class ConversationRunnerReplyTextTests
{
    [Fact]
    public void Reasoning_drafts_are_never_the_saved_reply()
    {
        PetMessage[] messages = [new("r:draft:answer:1", "assistant", "partial answer"), new("r:draft:reasoning:abc", "assistant", "thinking about it")];
        Assert.Equal("partial answer", ConversationRunner.ReplyText(messages));
    }

    [Fact]
    public void Only_reasoning_or_no_messages_gives_empty_text()
    {
        Assert.Equal("", ConversationRunner.ReplyText([new("r:draft:reasoning:abc", "assistant", "thinking")]));
        Assert.Equal("", ConversationRunner.ReplyText(null));
    }
}
