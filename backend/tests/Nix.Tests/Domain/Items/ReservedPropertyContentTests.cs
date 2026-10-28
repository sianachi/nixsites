using System.Text.Json.Nodes;
using Nix.Domain.Habits;
using Nix.Domain.Items;

namespace Nix.Tests.Domain.Items;

/// <summary>
/// What template and import content may carry of the reserved <c>$</c> space (security review
/// F2): habit and finance content, checked by their own validators; nothing else.
/// </summary>
public sealed class ReservedPropertyContentTests
{
    private static readonly IReadOnlyList<string> Content = ReservedPropertyContent.ContentPrefixes;

    [Theory]
    [InlineData("$type", true)]
    [InlineData("$due_set_by", true)]
    [InlineData("$cal_source", true)]
    [InlineData("$anything", true)]
    [InlineData("$habit_unit", false)]
    [InlineData("$fin_amount", false)]
    [InlineData("status", false)]
    public void Only_habit_and_finance_keys_are_content(string key, bool forbidden) =>
        Assert.Equal(forbidden, ReservedPropertyContent.IsForbidden(key, Content));

    [Fact]
    public void Strip_removes_every_forbidden_key_and_keeps_the_rest()
    {
        var stripped = ReservedPropertyContent.Strip(
            """{"title":"T","$type":"task","$due_set_by":"x","$habit_unit":"times","$fin_kind":"account"}""",
            Content);

        Assert.Equal("""{"title":"T","$habit_unit":"times","$fin_kind":"account"}""", stripped);
    }

    [Fact]
    public void A_bag_that_does_not_parse_or_needs_nothing_is_returned_as_it_is()
    {
        Assert.Equal("{not json", ReservedPropertyContent.Strip("{not json", Content));
        Assert.Equal("""{"a":1}""", ReservedPropertyContent.Strip("""{"a":1}""", Content));
        Assert.Null(ReservedPropertyContent.Strip(null, Content));
    }

    [Fact]
    public void A_feature_with_a_narrower_allowlist_drops_what_another_keeps()
    {
        Assert.True(ReservedPropertyContent.IsForbidden("$fin_amount", [ItemProperties.HabitPrefix]));
    }

    [Fact]
    public void Malformed_habit_settings_are_refused_and_bags_without_them_are_not()
    {
        Assert.NotNull(ReservedPropertyContent.Refuse("""{"$habit_frequency":"daily"}""", "note"));
        Assert.Null(ReservedPropertyContent.Refuse("""{"$habit_unit":"times"}""", "note"));
        Assert.Null(ReservedPropertyContent.Refuse("""{"title":"plain"}""", "note"));
    }

    [Fact]
    public void A_bag_claiming_to_be_a_finance_record_must_read_as_one()
    {
        Assert.NotNull(ReservedPropertyContent.Refuse("""{"$fin_kind":"transaction"}""", "note"));
    }

    [Fact]
    public void Escaped_reserved_keys_are_checked_by_their_decoded_names()
    {
        const string bag = """{"\u0024type":"task","\u0024habit_frequency":"daily"}""";

        var stripped = JsonNode.Parse(ReservedPropertyContent.Strip(bag, Content)!)!.AsObject();
        Assert.False(stripped.ContainsKey("$type"));
        Assert.NotNull(ReservedPropertyContent.Refuse(bag, "note"));
    }

    [Fact]
    public void Valid_current_habit_settings_do_not_allow_malformed_history()
    {
        var bag = new HabitSettings("daily", [], "UTC", new DateOnly(2026, 1, 1), 1, "times").ToProperties();
        Assert.Null(ReservedPropertyContent.Refuse(bag.ToJsonString(), "note"));

        bag["$habit_versions"] = new JsonArray(new JsonObject
        {
            ["effectiveFrom"] = "2026-01-01",
            ["settings"] = new JsonObject { ["$habit_frequency"] = "daily" },
        });
        Assert.NotNull(ReservedPropertyContent.Refuse(bag.ToJsonString(), "note"));
    }

    [Theory]
    [InlineData("""{"$fin_kind":"line"}""")]
    [InlineData("""{"$fin_currency":"GBP"}""")]
    public void Malformed_budget_lines_and_finance_settings_are_refused(string bag) =>
        Assert.NotNull(ReservedPropertyContent.Refuse(bag, "Finance"));
}
