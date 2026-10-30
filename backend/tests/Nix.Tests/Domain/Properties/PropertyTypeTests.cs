using Nix.Domain.Properties;

namespace Nix.Tests.Domain.Properties;

/// <summary>
/// The property type vocabulary, which is a storage contract rather than an enum.
/// </summary>
/// <remarks>
/// <para>
/// Every schema in the database names its types in text. That makes the names below as durable as
/// the rows carrying them: renaming one silently retypes every property already stored under it,
/// and renumbering the enum has to cost nothing at all. The round trip is what holds both.
/// </para>
/// <para>
/// The three predicates are checked against every member rather than by example, because they are
/// the only questions the view layer asks about a type. A type that answered the grouping question
/// wrongly would give a board one column per distinct value, and nothing else in the system is in a
/// position to object.
/// </para>
/// </remarks>
public sealed class PropertyTypeTests
{
    [Fact]
    public void Every_type_this_build_defines_survives_being_written_and_read_back()
    {
        // Written as a sweep over the enum so that adding a member without a case in either
        // direction fails here, rather than at the first schema that happens to use it.
        foreach (var type in Enum.GetValues<PropertyType>())
        {
            Assert.True(PropertyTypes.TryParse(PropertyTypes.ToText(type), out var read));
            Assert.Equal(type, read);
        }
    }

    [Theory]
    [InlineData(PropertyType.Text, "text")]
    [InlineData(PropertyType.Number, "number")]
    [InlineData(PropertyType.Select, "select")]
    [InlineData(PropertyType.MultiSelect, "multi_select")]
    [InlineData(PropertyType.Date, "date")]
    [InlineData(PropertyType.Checkbox, "checkbox")]
    [InlineData(PropertyType.Url, "url")]
    [InlineData(PropertyType.Timestamp, "timestamp")]
    [InlineData(PropertyType.Image, "image")]
    [InlineData(PropertyType.DateTime, "datetime")]
    [InlineData(PropertyType.Reminder, "reminder")]
    public void A_type_is_stored_under_the_name_the_contract_publishes(PropertyType type, string name)
    {
        // These literals are the wire format and the column format at once. Changing one is a
        // migration of every stored schema, so it should cost a failing test to notice.
        Assert.Equal(name, PropertyTypes.ToText(type));
        Assert.True(PropertyTypes.TryParse(name, out var parsed));
        Assert.Equal(type, parsed);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("Text")]
    [InlineData("multiSelect")]
    [InlineData("multi-select")]
    [InlineData("rich_text")]
    [InlineData("0")]
    public void A_type_name_this_build_does_not_know_is_not_a_type(string? name)
    {
        // Including the near misses on purpose: casing and separators are exactly where a hand-
        // written client goes wrong, and guessing at "Text" would let one build accept values a
        // stricter build refuses.
        Assert.False(PropertyTypes.TryParse(name, out _));
    }

    [Fact]
    public void Writing_a_type_the_enum_does_not_define_is_a_bug_rather_than_a_value()
    {
        // The asymmetry with reading is deliberate. Unrecognised text is a fact about stored data
        // and is survivable by dropping the property; an undefined enum member is a fact about
        // this process, and inventing a name for it would put nonsense in the column.
        Assert.Throws<ArgumentOutOfRangeException>(() => PropertyTypes.ToText((PropertyType)99));
    }

    [Theory]
    [InlineData(PropertyType.Select, true)]
    [InlineData(PropertyType.MultiSelect, false)]
    [InlineData(PropertyType.Checkbox, false)]
    [InlineData(PropertyType.Completion, false)]
    [InlineData(PropertyType.Priority, false)]
    [InlineData(PropertyType.Assignee, false)]
    [InlineData(PropertyType.Text, false)]
    [InlineData(PropertyType.Number, false)]
    [InlineData(PropertyType.Estimate, false)]
    [InlineData(PropertyType.Date, false)]
    [InlineData(PropertyType.Url, false)]
    [InlineData(PropertyType.Timestamp, false)]
    [InlineData(PropertyType.Image, false)]
    [InlineData(PropertyType.DateTime, false)]
    [InlineData(PropertyType.Reminder, false)]
    [InlineData(PropertyType.Formula, false)]
    public void Only_a_single_select_groups_a_view_until_the_board_can_draw_the_other_bounded_types(
        PropertyType type,
        bool expected)
    {
        // Free text and numbers are the refusals that last: a group per distinct value is a board
        // nobody can read. Multi-select, checkbox, completion, priority and assignee are decided
        // (ADR-0054) but staged behind the web board work, so they are refused here until then.
        Assert.Equal(expected, type.CanGroupBy());
    }

    [Theory]
    [InlineData(PropertyType.Select, true)]
    [InlineData(PropertyType.MultiSelect, false)]
    [InlineData(PropertyType.Assignee, false)]
    [InlineData(PropertyType.Checkbox, true)]
    [InlineData(PropertyType.Completion, true)]
    [InlineData(PropertyType.Priority, true)]
    [InlineData(PropertyType.Number, false)]
    [InlineData(PropertyType.Date, true)]
    [InlineData(PropertyType.Timestamp, true)]
    [InlineData(PropertyType.DueDate, true)]
    [InlineData(PropertyType.StartDate, true)]
    [InlineData(PropertyType.DateTime, true)]
    public void A_chart_buckets_by_a_select_priority_checkbox_or_along_a_date(PropertyType type, bool expected) =>
        Assert.Equal(expected, type.CanChartBy());

    [Theory]
    [InlineData(PropertyType.Date, true)]
    [InlineData(PropertyType.Timestamp, true)]
    [InlineData(PropertyType.Text, false)]
    [InlineData(PropertyType.Number, false)]
    [InlineData(PropertyType.Select, false)]
    [InlineData(PropertyType.MultiSelect, false)]
    [InlineData(PropertyType.Checkbox, false)]
    [InlineData(PropertyType.Url, false)]
    [InlineData(PropertyType.Image, false)]
    [InlineData(PropertyType.DateTime, true)]
    [InlineData(PropertyType.Reminder, false)]
    public void Only_a_date_places_an_item_on_a_calendar(PropertyType type, bool expected)
    {
        Assert.Equal(expected, type.CanPlaceOnCalendar());
    }
}
