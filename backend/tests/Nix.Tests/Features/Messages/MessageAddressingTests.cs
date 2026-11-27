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
        Assert.True(AccessTokenScopes.TryParse("pets:send", out var scope));
        Assert.Equal("pets:send", AccessTokenScopes.Format(scope));
        Assert.Contains("pets:send", AccessTokenScopes.All);
    }
}
