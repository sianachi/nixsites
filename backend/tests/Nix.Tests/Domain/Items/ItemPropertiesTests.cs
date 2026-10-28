using System.Text.Json.Nodes;
using Nix.Domain.Items;
using Nix.Domain.Properties;

namespace Nix.Tests.Domain.Items;

/// <summary>
/// Writing part of a property bag without disturbing the rest of it.
/// </summary>
/// <remarks>
/// <para>
/// The write half of the rule the validator states from the other side: a caller sets the
/// properties it is changing and knows nothing about the rest. A board that replaced the bag would
/// drop every property it does not display - which is most of them, including <c>title</c> - and
/// the loss would be silent, because nothing downstream can tell a property that was never set from
/// one that was dropped on the way through.
/// </para>
/// <para>
/// A merge that cannot be understood answers with nothing rather than with a guess. That is the one
/// case where the write path is stricter than the read path: an unreadable bag on the way out costs
/// one row its display, and an unreadable change on the way in would cost an item its properties.
/// </para>
/// </remarks>
public sealed class ItemPropertiesTests
{
    [Fact]
    public void A_change_merges_into_the_stored_bag_rather_than_replacing_it()
    {
        var merged = Parse(ItemProperties.Merge(
            """{"title":"Quarterly plan","status":"Todo"}""",
            """{"status":"Doing"}"""));

        Assert.Equal("Doing", (string?)merged["status"]);
        Assert.Equal("Quarterly plan", (string?)merged["title"]);
    }

    [Fact]
    public void Keys_the_change_did_not_mention_come_through_exactly_as_they_were()
    {
        // Nested on purpose: a merge that rebuilt values rather than carrying them would show up
        // here first, and a multi-select or a future structured property is precisely the kind of
        // value a caller setting one text field has no idea it is holding.
        var merged = Parse(ItemProperties.Merge(
            """{"tags":["a","b"],"meta":{"origin":"import","depth":2},"title":"Notes"}""",
            """{"title":"Renamed"}"""));

        Assert.Equal("Renamed", (string?)merged["title"]);
        Assert.Equal("""["a","b"]""", merged["tags"]?.ToJsonString());
        Assert.Equal("""{"origin":"import","depth":2}""", merged["meta"]?.ToJsonString());
    }

    [Fact]
    public void An_explicit_null_removes_the_key_rather_than_storing_a_null()
    {
        // Null is what a client clearing a field sends. Keeping it would leave "set but empty" and
        // "not set" indistinguishable to everything downstream - including the required check,
        // which would then be satisfiable by clearing the field.
        var merged = Parse(ItemProperties.Merge(
            """{"title":"Notes","due":"2026-07-27"}""",
            """{"due":null}"""));

        Assert.False(merged.ContainsKey("due"));
        Assert.Equal("Notes", (string?)merged["title"]);
    }

    [Fact]
    public void Clearing_a_property_that_was_never_set_is_not_an_error()
    {
        // A client that sends its whole form, nulls and all, is the normal case rather than a
        // malformed one.
        var merged = Parse(ItemProperties.Merge("""{"title":"Notes"}""", """{"due":null}"""));

        Assert.False(merged.ContainsKey("due"));
        Assert.Equal("Notes", (string?)merged["title"]);
    }

    [Fact]
    public void A_change_carrying_a_structured_value_stores_that_value_whole()
    {
        var merged = Parse(ItemProperties.Merge(
            """{"title":"Notes"}""",
            """{"tags":["a","b"],"meta":{"origin":"import"}}"""));

        Assert.Equal("""["a","b"]""", merged["tags"]?.ToJsonString());
        Assert.Equal("""{"origin":"import"}""", merged["meta"]?.ToJsonString());
        Assert.Equal("Notes", (string?)merged["title"]);
    }

    [Fact]
    public void An_item_with_no_bag_yet_gets_one()
    {
        var merged = Parse(ItemProperties.Merge(null, """{"title":"Notes"}"""));

        Assert.Equal("Notes", (string?)merged["title"]);
    }

    [Theory]
    [InlineData("{oops")]
    [InlineData("[1,2,3]")]
    [InlineData("\"a bag\"")]
    [InlineData("")]
    [InlineData("   ")]
    public void A_stored_bag_that_cannot_be_read_is_treated_as_an_empty_one(string properties)
    {
        // The alternative is refusing the write, which would strand the item: nobody could rename
        // it until somebody repaired the column by hand. Starting fresh loses whatever was in there,
        // and whatever was in there was already unreadable to every other code path.
        var merged = Parse(ItemProperties.Merge(properties, """{"title":"Notes"}"""));

        Assert.Equal("Notes", (string?)merged["title"]);
        Assert.Single(merged);
    }

    [Theory]
    [InlineData("[1,2,3]")]
    [InlineData("\"title\"")]
    [InlineData("42")]
    [InlineData("null")]
    [InlineData("{oops")]
    [InlineData("")]
    public void A_change_that_is_not_a_JSON_map_merges_to_nothing_at_all(string changes)
    {
        // Answering with null rather than with the untouched bag: the caller asked for something
        // that cannot be applied, and the use case has to be able to tell that from a change that
        // happened to alter nothing.
        Assert.Null(ItemProperties.Merge("""{"title":"Notes"}""", changes));
    }

    [Fact]
    public void A_change_naming_the_same_property_twice_merges_to_nothing_at_all()
    {
        // This one parses and then throws on enumeration rather than at the parse, so it slips
        // past a catch written for JsonException alone. These are client bytes: the answer is the
        // same refusal any other malformed body gets, never an unhandled exception arriving as a
        // 500.
        Assert.Null(ItemProperties.Merge(
            """{"title":"Notes"}""",
            """{"owner":"Ada","owner":null}"""));
    }

    [Fact]
    public void A_merge_reports_every_key_the_change_named_including_the_ones_it_cleared()
    {
        // The cleared key is the reason this is returned at all: the merged bag has no trace of
        // "status" afterwards, so nothing downstream could tell it was deliberately emptied rather
        // than never set.
        var write = ItemProperties.Merge(
            """{"title":"Notes","status":"Todo"}""",
            """{"owner":"Ada","status":null}""");

        Assert.NotNull(write);
        Assert.Equal(["owner", "status"], write.Value.Touched);
        Assert.DoesNotContain("status", write.Value.Merged, StringComparison.Ordinal);
    }

    [Fact]
    public void A_change_that_says_nothing_leaves_the_bag_as_it_was()
    {
        var merged = Parse(ItemProperties.Merge("""{"title":"Notes","status":"Todo"}""", "{}"));

        Assert.Equal("Notes", (string?)merged["title"]);
        Assert.Equal("Todo", (string?)merged["status"]);
    }

    [Fact]
    public void A_merge_leaves_a_key_the_schema_never_declared_where_it_found_it()
    {
        // The other side of ADR-0007 section 4. The validator declines to report an undeclared key;
        // this is what makes that promise worth anything, because a merge that dropped what no
        // schema declares would delete the value the validator agreed to leave alone.
        var merged = Parse(ItemProperties.Merge(
            """{"title":"Notes","retired":{"kept":true}}""",
            """{"title":"Renamed"}"""));

        Assert.Equal("""{"kept":true}""", merged["retired"]?.ToJsonString());
    }

    private static JsonObject Parse(PropertyWrite? write)
    {
        Assert.NotNull(write);
        return Assert.IsType<JsonObject>(JsonNode.Parse(write.Value.Merged));
    }
}

/// <summary>
/// The single point every due-date write funnels through: attributing who set
/// <c>due_date</c>, or clearing that attribution when the date itself is cleared.
/// </summary>
public sealed class ItemPropertiesStampSetByTests
{
    [Fact]
    public void Setting_a_due_date_stamps_who_set_it()
    {
        var bag = ItemProperties.StampSetBy(
            """{"title":"Notes","due_date":"2026-07-27"}""",
            ["due_date"],
            "00000000-0000-0000-0000-000000000001");

        var parsed = Assert.IsType<JsonObject>(JsonNode.Parse(bag));
        Assert.Equal(
            "00000000-0000-0000-0000-000000000001",
            (string?)parsed[ItemProperties.DueSetByKey]);
    }

    [Fact]
    public void A_write_that_does_not_touch_due_date_leaves_any_existing_stamp_alone()
    {
        var bag = ItemProperties.StampSetBy(
            $$"""{"title":"Notes","due_date":"2026-07-27","{{ItemProperties.DueSetByKey}}":"00000000-0000-0000-0000-000000000001"}""",
            ["title"],
            "00000000-0000-0000-0000-000000000002");

        var parsed = Assert.IsType<JsonObject>(JsonNode.Parse(bag));
        Assert.Equal(
            "00000000-0000-0000-0000-000000000001",
            (string?)parsed[ItemProperties.DueSetByKey]);
    }

    [Fact]
    public void Clearing_the_due_date_clears_its_attribution_too()
    {
        var bag = ItemProperties.StampSetBy(
            $$"""{"title":"Notes","{{ItemProperties.DueSetByKey}}":"00000000-0000-0000-0000-000000000001"}""",
            ["due_date"],
            "00000000-0000-0000-0000-000000000002");

        var parsed = Assert.IsType<JsonObject>(JsonNode.Parse(bag));
        Assert.False(parsed.ContainsKey(ItemProperties.DueSetByKey));
    }

    [Fact]
    public void Re_setting_a_due_date_re_attributes_it_to_whoever_wrote_it_this_time()
    {
        var bag = ItemProperties.StampSetBy(
            $$"""{"due_date":"2026-08-01","{{ItemProperties.DueSetByKey}}":"00000000-0000-0000-0000-000000000001"}""",
            ["due_date"],
            "00000000-0000-0000-0000-000000000002");

        var parsed = Assert.IsType<JsonObject>(JsonNode.Parse(bag));
        Assert.Equal(
            "00000000-0000-0000-0000-000000000002",
            (string?)parsed[ItemProperties.DueSetByKey]);
    }

    [Fact]
    public void Setting_a_reminder_stamps_who_set_it_and_clearing_it_clears_the_stamp()
    {
        var set = ItemProperties.StampSetBy(
            """{"title":"Notes","reminder":"2026-10-01T09:00:00+00:00[Etc/UTC]"}""",
            ["reminder"],
            "00000000-0000-0000-0000-000000000001");
        var parsed = Assert.IsType<JsonObject>(JsonNode.Parse(set));
        Assert.Equal("00000000-0000-0000-0000-000000000001", (string?)parsed[ItemProperties.ReminderSetByKey]);
        Assert.False(parsed.ContainsKey(ItemProperties.DueSetByKey));

        var cleared = ItemProperties.StampSetBy(
            $$"""{"title":"Notes","{{ItemProperties.ReminderSetByKey}}":"00000000-0000-0000-0000-000000000001"}""",
            ["reminder"],
            "00000000-0000-0000-0000-000000000002");
        Assert.False(Assert.IsType<JsonObject>(JsonNode.Parse(cleared)).ContainsKey(ItemProperties.ReminderSetByKey));
    }

    [Fact]
    public void A_copied_bag_is_re_attributed_to_the_principal_making_the_copy()
    {
        var copied = ItemProperties.RestampCopiedSetBy(
            $$"""{"due_date":"2026-10-01","reminder":"2026-10-01T09:00:00+00:00[Etc/UTC]","{{ItemProperties.DueSetByKey}}":"00000000-0000-0000-0000-00000000000f","{{ItemProperties.ReminderSetByKey}}":"00000000-0000-0000-0000-00000000000f"}""",
            "00000000-0000-0000-0000-000000000002");

        var parsed = Assert.IsType<JsonObject>(JsonNode.Parse(copied!));
        Assert.Equal("00000000-0000-0000-0000-000000000002", (string?)parsed[ItemProperties.DueSetByKey]);
        Assert.Equal("00000000-0000-0000-0000-000000000002", (string?)parsed[ItemProperties.ReminderSetByKey]);
    }

    [Fact]
    public void A_copied_set_by_without_its_value_is_dropped_rather_than_kept()
    {
        var copied = ItemProperties.RestampCopiedSetBy(
            $$"""{"title":"Copy","{{ItemProperties.DueSetByKey}}":"00000000-0000-0000-0000-00000000000f"}""",
            "00000000-0000-0000-0000-000000000002");

        Assert.False(Assert.IsType<JsonObject>(JsonNode.Parse(copied!)).ContainsKey(ItemProperties.DueSetByKey));
    }

    [Fact]
    public void Clearing_completion_on_a_dated_item_re_attributes_its_due_date_to_whoever_reopened_it()
    {
        // Reopening a task re-targets its due reminder as surely as setting the date does, so the
        // principal who reopened it is the one the reminder now goes to.
        var reopened = ItemProperties.StampSetBy(
            $$"""{"due_date":"2026-10-01","completion":false,"{{ItemProperties.DueSetByKey}}":"00000000-0000-0000-0000-000000000001"}""",
            ["completion"],
            "00000000-0000-0000-0000-000000000002");
        Assert.Equal(
            "00000000-0000-0000-0000-000000000002",
            (string?)Assert.IsType<JsonObject>(JsonNode.Parse(reopened))[ItemProperties.DueSetByKey]);

        var cleared = ItemProperties.StampSetBy(
            $$"""{"due_date":"2026-10-01","{{ItemProperties.DueSetByKey}}":"00000000-0000-0000-0000-000000000001"}""",
            ["completion"],
            "00000000-0000-0000-0000-000000000002");
        Assert.Equal(
            "00000000-0000-0000-0000-000000000002",
            (string?)Assert.IsType<JsonObject>(JsonNode.Parse(cleared))[ItemProperties.DueSetByKey]);
    }

    [Fact]
    public void Completing_or_reopening_an_undated_item_leaves_attribution_alone()
    {
        var completed = ItemProperties.StampSetBy(
            $$"""{"due_date":"2026-10-01","completion":true,"{{ItemProperties.DueSetByKey}}":"00000000-0000-0000-0000-000000000001"}""",
            ["completion"],
            "00000000-0000-0000-0000-000000000002");
        Assert.Equal(
            "00000000-0000-0000-0000-000000000001",
            (string?)Assert.IsType<JsonObject>(JsonNode.Parse(completed))[ItemProperties.DueSetByKey]);

        var undated = ItemProperties.StampSetBy(
            """{"title":"No date","completion":false}""",
            ["completion"],
            "00000000-0000-0000-0000-000000000002");
        Assert.False(Assert.IsType<JsonObject>(JsonNode.Parse(undated)).ContainsKey(ItemProperties.DueSetByKey));
    }

    [Fact]
    public void A_bag_naming_a_member_twice_is_returned_for_validation_rather_than_throwing()
    {
        // JsonNode.Parse accepts duplicate member names and JsonObject throws ArgumentException on
        // first use; these are client bytes, so the callers' envelope validation must see the bag
        // and refuse it rather than the rewrite surfacing as a 500.
        const string duplicated = """{"due_date":"2026-10-01","$due_set_by":"00000000-0000-0000-0000-00000000000f","$due_set_by":"00000000-0000-0000-0000-00000000000e"}""";

        Assert.Equal(duplicated, ItemProperties.WithTitle(duplicated, "Title"));
        Assert.Equal(duplicated, ItemProperties.RestampCopiedSetBy(duplicated, "00000000-0000-0000-0000-000000000002"));
        Assert.NotNull(new Nix.Domain.Templates.TemplateDefinitionValidator().ValidateEnvelope(duplicated, null, null));
    }

    [Theory]
    [InlineData("$due_set_by", true)]
    [InlineData("$reminder_set_by", true)]
    [InlineData("$habit_reminder_time", true)]
    [InlineData("$habit_check_in_date", true)]
    [InlineData("$cal_source", true)]
    [InlineData("$cal_link", true)]
    [InlineData("$cal_readonly", true)]
    [InlineData("due_date", false)]
    [InlineData("cal_source", false)]
    [InlineData("reminder", false)]
    [InlineData("habit", false)]
    public void Scheduler_and_habit_keys_are_reserved(string key, bool reserved) =>
        Assert.Equal(reserved, ItemProperties.IsReservedSchedulingKey(key));

    [Fact]
    public void A_copied_bag_drops_every_calendar_sync_key()
    {
        // A copy is not the synced event: keeping $cal_link would make a template application or an
        // import claim to mirror an external event it has no map row for.
        var copied = ItemProperties.RestampCopiedSetBy(
            """{"title":"Standup","start":"2026-10-01","$cal_source":"google","$cal_link":"0199a000-0000-7000-8000-000000000001","$cal_readonly":true}""",
            "00000000-0000-0000-0000-000000000002");

        var parsed = Assert.IsType<JsonObject>(JsonNode.Parse(copied!));
        Assert.Equal("2026-10-01", (string?)parsed["start"]);
        Assert.False(parsed.ContainsKey("$cal_source"));
        Assert.False(parsed.ContainsKey("$cal_link"));
        Assert.False(parsed.ContainsKey("$cal_readonly"));
    }
}
