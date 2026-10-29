using Nix.Domain.Primitives;

namespace Nix.Tests.Domain;

public sealed class TextCutTests
{
    [Fact]
    public void A_cut_never_splits_a_surrogate_pair()
    {
        var text = new string('a', 4) + "\U0001F600" + "tail";
        Assert.Equal("aaaa", TextCut.Cut(text, 5));
        Assert.Equal("aaaa\U0001F600", TextCut.Cut(text, 6));
        Assert.Equal("short", TextCut.Cut("short", 10));
        Assert.Equal(string.Empty, TextCut.Cut("\U0001F600", 1));
    }
}
