using Nix.Features.PetRuns;

namespace Nix.Tests.Features.PetRuns;

public sealed class PetRunExcerptTests
{
    private static readonly Guid Id = new("0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b");
    private const string Prefix = "Untrusted excerpt from selected Nix item 0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b";

    [Fact]
    public void A_note_at_the_limit_comes_back_whole()
    {
        var note = new string('a', 650);

        Assert.Equal($"{Prefix}: {note}", PetRunExcerpt.Describe(Id, note));
    }

    [Fact]
    public void A_longer_note_says_how_much_was_read()
    {
        var text = PetRunExcerpt.Describe(Id, new string('a', 651));

        Assert.StartsWith($"{Prefix} (the first 650 of 651 characters; the rest was not read): ", text, StringComparison.Ordinal);
        Assert.Equal(650, text[(text.IndexOf("): ", StringComparison.Ordinal) + 3)..].Length);
    }

    [Fact]
    public void A_cut_never_splits_a_surrogate_pair()
    {
        var note = new string('a', 649) + "\U0001F600" + "b";

        var text = PetRunExcerpt.Describe(Id, note);

        Assert.Equal(649, text[(text.IndexOf("): ", StringComparison.Ordinal) + 3)..].Length);
        Assert.Contains("of 652 characters", text, StringComparison.Ordinal);
    }

    [Fact]
    public void The_id_is_printed_in_D_format()
    {
        Assert.StartsWith(Prefix + ":", PetRunExcerpt.Describe(Id, "x"), StringComparison.Ordinal);
    }
}
