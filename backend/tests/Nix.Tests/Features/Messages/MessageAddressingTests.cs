using Nix.Domain.Identity;
using Nix.Features.Messages;
using Nix.Features.Pets;

namespace Nix.Tests.Features.Messages;

public sealed class MessageAddressingTests
{
    private static readonly Guid Ada = Guid.NewGuid();
    private static readonly Guid Pip = Guid.NewGuid();

    private static readonly Dictionary<string, MessageRecipient> Names = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Ada"] = new(Ada, "person", "Ada"),
        ["Pip"] = new(Pip, "pet", "Pip"),
    };

    [Fact]
    public void A_last_To_line_names_known_people_and_pets_and_is_removed_from_the_text()
    {
        var (text, to) = MessagePetRunner.TakeAddressing("Done.\n\nTo: ada, Pip, Nobody, Ada", Names);
        Assert.Equal("Done.", text);
        Assert.Equal([Ada, Pip], to.Select(entry => entry.Id));
    }

    [Fact]
    public void A_reply_without_the_line_is_left_alone_and_a_line_in_the_middle_is_not_one()
    {
        var (plain, nobody) = MessagePetRunner.TakeAddressing("Hello", Names);
        Assert.Equal("Hello", plain);
        Assert.Empty(nobody);
        var (kept, none) = MessagePetRunner.TakeAddressing("To: Ada\nand more", Names);
        Assert.Equal("To: Ada\nand more", kept);
        Assert.Empty(none);
    }

    [Fact]
    public void A_last_Remember_line_is_a_fact_and_is_removed_and_an_unusable_fact_is_dropped_with_it()
    {
        Assert.Equal(("Noted.", "Prefers metric units"), MessagePetRunner.TakeRemember("Noted.\nRemember: Prefers metric units"));
        Assert.Equal(("Hello", ""), MessagePetRunner.TakeRemember("Hello"));
        Assert.Equal(("a\nRemember: x\nb", ""), MessagePetRunner.TakeRemember("a\nRemember: x\nb"));
        Assert.Equal(("Ok", ""), MessagePetRunner.TakeRemember("Ok\nRemember: " + new string('x', 281)));
        Assert.Equal(("Ok", ""), MessagePetRunner.TakeRemember("Ok\nRemember: hid\u200Bden"));
        var (text, to) = MessagePetRunner.TakeAddressing("Ok\nRemember: Likes tea\nTo: Ada", Names);
        Assert.Equal(("Ok", "Likes tea"), MessagePetRunner.TakeRemember(text));
        Assert.Equal([Ada], to.Select(entry => entry.Id));
    }

    [Fact]
    public void A_Remember_line_is_left_in_the_reply_when_the_prompt_did_not_offer_it()
    {
        Assert.Equal(("Noted.\nRemember: Likes tea", ""), MessagePetRunner.TakeRemember("Noted.\nRemember: Likes tea", offered: false));
    }

    [Theory]
    [InlineData("Ok\nTo: Ada\nRemember: Likes tea")]
    [InlineData("Ok\nRemember: Likes tea\nTo: Ada")]
    public void The_To_and_Remember_lines_are_taken_in_either_order_and_never_reach_the_reply(string reply)
    {
        var (kept, to) = MessagePetRunner.TakeAddressing(reply, Names);
        var (text, fact) = MessagePetRunner.TakeRemember(kept);
        Assert.Equal(("Ok", "Likes tea"), (text, fact));
        Assert.Equal([Ada], to.Select(entry => entry.Id));
    }

    [Fact]
    public void At_most_five_are_kept()
    {
        var many = Enumerable.Range(0, 8).ToDictionary(i => $"P{i}", i => new MessageRecipient(Guid.NewGuid(), "person", $"P{i}"), StringComparer.OrdinalIgnoreCase);
        Assert.Equal(5, MessagePetRunner.TakeAddressing("x\nTo: " + string.Join(", ", many.Keys), many).To.Count);
    }

    [Fact]
    public void A_token_usage_label_is_clean_and_bounded_and_the_scope_parses()
    {
        Assert.Equal("token:Claude", PetUsageSources.Token("Cla\nude"));
        Assert.Equal("token:token", PetUsageSources.Token(null));
        Assert.Equal(100, PetUsageSources.Token(new string('x', 300)).Length);
        Assert.True(PetUsageSources.IsValid(PetUsageSources.Token("a\u0007b")));
        Assert.True(AccessTokenScopes.TryParse("agents", out var scope));
        Assert.Equal("agents", AccessTokenScopes.Format(scope));
        Assert.Contains("agents", AccessTokenScopes.All);
        Assert.False(AccessTokenScopes.TryParse("pets:send", out _));
    }
}
