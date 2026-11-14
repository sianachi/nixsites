using Nix.Domain.Items;

namespace Nix.Tests.Domain.Items;

public sealed class ItemSettingsTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("{\"comments\":\"yes\",\"fullWidth\":1}")]
    public void Everything_is_off_for_a_missing_or_unreadable_value(string? stored) =>
        Assert.Equal(new ItemSettings(), ItemSettings.Read(stored));

    [Fact]
    public void A_stored_switch_reads_back_and_unknown_keys_are_ignored()
    {
        var settings = ItemSettings.Read("{\"comments\":true,\"reviewStates\":true,\"other\":true}");

        Assert.Equal(new ItemSettings(Comments: true, ReviewStates: true), settings);
    }

    [Fact]
    public void A_patch_holds_only_the_switches_named()
    {
        Assert.Equal("{\"suggesting\":false,\"fullWidth\":true}", ItemSettings.Patch(null, false, null, true));
        Assert.Equal("{}", ItemSettings.Patch(null, null, null, null));
    }
}
