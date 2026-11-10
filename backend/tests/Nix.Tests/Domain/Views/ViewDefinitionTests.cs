using System.Collections.Immutable;
using Nix.Domain.Properties;
using Nix.Domain.Views;

namespace Nix.Tests.Domain.Views;

/// <summary>
/// Whether a stored view can actually be drawn against the schema in force where it lives.
/// </summary>
/// <remarks>
/// <para>
/// A view names a property; a schema is edited somewhere else entirely, by somebody else. So a
/// board can find its grouping property deleted, or retyped to something with no bounded set of
/// values, and the honest answer is to say so. Rendering it anyway produces an empty board, which
/// a person reads as an empty folder - the interface would be lying about which of the two happened.
/// </para>
/// <para>
/// The kind names get the same treatment as the property type names, and for the same reason: they
/// are stored text, so they are a contract, and one this build does not recognise is dropped rather
/// than rendered as something else.
/// </para>
/// </remarks>
public sealed class ViewDefinitionTests
{
    [Fact]
    public void Every_kind_this_build_defines_survives_being_written_and_read_back()
    {
        foreach (var kind in Enum.GetValues<ViewKind>())
        {
            Assert.True(ViewKinds.TryParse(ViewKinds.ToText(kind), out var read));
            Assert.Equal(kind, read);
        }
    }

    [Theory]
    [InlineData(ViewKind.List, "list")]
    [InlineData(ViewKind.Board, "board")]
    [InlineData(ViewKind.Calendar, "calendar")]
    [InlineData(ViewKind.Gallery, "gallery")]
    [InlineData(ViewKind.Timeline, "timeline")]
    [InlineData(ViewKind.Sheet, "sheet")]
    [InlineData(ViewKind.Form, "form")]
    [InlineData(ViewKind.Query, "query")]
    [InlineData(ViewKind.Checklist, "checklist")]
    [InlineData(ViewKind.Matrix, "matrix")]
    [InlineData(ViewKind.Outline, "outline")]
    [InlineData(ViewKind.Chat, "chat")]
    [InlineData(ViewKind.Custom, "custom")]
    public void A_kind_is_stored_under_the_name_the_contract_publishes(ViewKind kind, string name)
    {
        Assert.Equal(name, ViewKinds.ToText(kind));
        Assert.True(ViewKinds.TryParse(name, out var parsed));
        Assert.Equal(kind, parsed);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("List")]
    [InlineData("kanban")]
    [InlineData("grid")]
    [InlineData("1")]
    public void A_kind_this_build_does_not_know_is_not_a_kind(string? name)
    {
        // Fails closed: a newer build's kind leaves an older instance offering fewer views, never
        // rendering one it has no renderer for.
        //
        // The negative cases are near misses on purpose - "kanban" and "grid" are what somebody
        // would reasonably guess a board and a gallery are called - and they have to be names no
        // build will ever have. "gallery" used to be here and became a kind, which is the trap: a
        // negative case that a later goal turns positive stops testing anything and starts
        // blocking the goal. "timeline" was the next one on the plan and is now a kind too, so a
        // name added here has to be one nothing on the roadmap is called.
        Assert.False(ViewKinds.TryParse(name, out _));
    }

    [Fact]
    public void Writing_a_kind_the_enum_does_not_define_is_a_bug_rather_than_a_value()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => ViewKinds.ToText((ViewKind)99));
    }

    [Fact]
    public void Every_kind_has_a_descriptor()
    {
        // The point of the descriptor table is that adding a view kind is one entry. This is what
        // makes that true rather than merely intended: add a member to the enum and forget the
        // table, and the kind has no text to be stored under, cannot be parsed back, and reports
        // itself unrenderable - three runtime failures that this turns into one failing test.
        foreach (var kind in Enum.GetValues<ViewKind>())
        {
            Assert.NotNull(ViewKinds.Find(kind));
        }

        Assert.Equal(Enum.GetValues<ViewKind>().Length, ViewKinds.All.Length);
    }

    [Fact]
    public void No_two_kinds_share_a_stored_name()
    {
        // Two entries with the same text would make TryParse pick whichever came first, so one
        // kind would silently become the other on the way back out of storage.
        var names = ViewKinds.All.Select(descriptor => descriptor.Text).ToList();

        Assert.Equal(names.Count, names.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void A_kind_whose_requirement_names_a_field_reads_that_field()
    {
        // The requirement's Read is what both CanRender and the storability check use to find the
        // configured property. If it pointed at the wrong field, a board would validate against a
        // calendar's date and the failure would look like a schema problem.
        var board = new ViewDefinition("v1", "By status", ViewKind.Board, [], "status", [], null, null, false);
        var calendar = new ViewDefinition("v2", "When", ViewKind.Calendar, [], null, [], "due", null, false);

        Assert.Equal("status", ViewKinds.Find(ViewKind.Board)?.Requirement?.Read(board));
        Assert.Equal("due", ViewKinds.Find(ViewKind.Calendar)?.Requirement?.Read(calendar));
        Assert.Null(ViewKinds.Find(ViewKind.List)?.Requirement);

        // A gallery has none either, and that is a decision rather than an omission. A requirement
        // is a property whose absence leaves nothing on screen; a gallery with no cover property is
        // a grid of titled cards, which is readable and is what most galleries are on day one.
        Assert.Null(ViewKinds.Find(ViewKind.Gallery)?.Requirement);
    }

    [Fact]
    public void A_list_renders_against_any_schema_at_all()
    {
        // With no columns configured it falls back to the effective schema, and with no schema it
        // still has titles to show. There is no arrangement of the two that leaves it with nothing.
        var list = new ViewDefinition("v1", "All", ViewKind.List, [], null, [], null, null, false);

        Assert.True(list.CanRender(PropertySchema.Empty));
        Assert.True(list.CanRender(SchemaOf(Property("status", PropertyType.Select))));
    }

    [Fact]
    public void A_list_renders_even_when_its_configured_columns_no_longer_exist()
    {
        // Columns are a preference, not a requirement: a deleted property costs the list a column
        // and the rest of the rows are still worth showing.
        var list = new ViewDefinition("v1", "All", ViewKind.List, ["status", "gone"], null, [], null, null, false);

        Assert.True(list.CanRender(PropertySchema.Empty));
    }

    [Fact]
    public void A_board_renders_when_it_groups_by_a_single_select()
    {
        var board = Board("status");

        Assert.True(board.CanRender(SchemaOf(Property("status", PropertyType.Select))));
    }

    [Fact]
    public void A_board_whose_grouping_property_was_deleted_cannot_render()
    {
        // The case the schema editor causes and the board author never sees: the property is gone,
        // so there are no columns to draw and nothing to drag a card between.
        var board = Board("status");

        Assert.False(board.CanRender(PropertySchema.Empty));
        Assert.False(board.CanRender(SchemaOf(Property("owner", PropertyType.Select))));
    }

    [Theory]
    [InlineData(PropertyType.Text)]
    [InlineData(PropertyType.Number)]
    [InlineData(PropertyType.MultiSelect)]
    [InlineData(PropertyType.Date)]
    [InlineData(PropertyType.Timestamp)]
    [InlineData(PropertyType.Checkbox)]
    [InlineData(PropertyType.Completion)]
    [InlineData(PropertyType.Priority)]
    [InlineData(PropertyType.Assignee)]
    [InlineData(PropertyType.Url)]
    [InlineData(PropertyType.Image)]
    public void A_board_grouping_by_a_type_that_cannot_be_grouped_cannot_render(PropertyType type)
    {
        // Retyping a select to text is one edit in a schema panel and it is enough. Grouping by
        // free text would draw a column per distinct value. The bounded types after Text and
        // Number are decided for grouping (ADR-0054) and staged until the web board can draw them.
        Assert.False(Board("status").CanRender(SchemaOf(Property("status", type))));
    }

    [Fact]
    public void A_board_that_names_no_grouping_property_cannot_render()
    {
        // Stored views are one record for all three kinds, so a board with a null groupBy is a
        // shape the type system permits and this is where it is caught.
        var board = new ViewDefinition("v1", "Board", ViewKind.Board, [], null, [], null, null, false);

        Assert.False(board.CanRender(SchemaOf(Property("status", PropertyType.Select))));
    }

    [Fact]
    public void A_matrix_renders_when_both_axes_are_a_select_or_a_checkbox()
    {
        // Columns are the board's own GroupBy and rows the matrix's RowBy; both take the wider
        // section predicate, so a checkbox axis is two rows rather than an unrenderable view.
        var matrix = Matrix(columns: "urgency", rows: "important");

        Assert.True(matrix.CanRender(SchemaOf(
            Property("urgency", PropertyType.Select),
            Property("important", PropertyType.Checkbox))));
        Assert.True(matrix.CanRender(SchemaOf(
            Property("urgency", PropertyType.Completion),
            Property("important", PropertyType.Select))));
    }

    [Fact]
    public void A_matrix_whose_rows_are_gone_or_cannot_be_grouped_cannot_render()
    {
        // The descriptor's requirement reads one field, the columns; the rows are checked beside it
        // so a matrix that lost its second axis is reported rather than drawn as one row.
        var matrix = Matrix(columns: "urgency", rows: "important");

        Assert.False(matrix.CanRender(SchemaOf(Property("urgency", PropertyType.Select))));
        Assert.False(matrix.CanRender(SchemaOf(
            Property("urgency", PropertyType.Select),
            Property("important", PropertyType.Text))));
        Assert.False(Matrix(columns: "urgency", rows: null)
            .CanRender(SchemaOf(Property("urgency", PropertyType.Select))));
    }

    [Fact]
    public void A_matrix_without_rows_is_refused_on_write()
    {
        Assert.Equal(
            "'Matrix': a matrix needs a property for its rows.",
            ViewDefinitionRules.Refuse([Matrix(columns: "urgency", rows: null)], null));
        Assert.Equal(
            "'Matrix': a matrix needs a property for its columns.",
            ViewDefinitionRules.Refuse([Matrix(columns: null, rows: "important")], null));
        Assert.Null(ViewDefinitionRules.Refuse([Matrix(columns: "urgency", rows: "important")], null));
    }

    [Fact]
    public void A_custom_view_needs_nothing_from_the_schema_and_its_program_has_a_byte_cap()
    {
        var custom = new ViewDefinition("v1", "Mine", ViewKind.Custom, [], null, [], null, null, false, Program: "root = Text(\"hi\")");

        Assert.True(custom.CanRender(PropertySchema.Empty));
        Assert.Null(ViewDefinitionRules.Refuse([custom], null));
        // 'é' is two bytes, so this is over the cap in bytes while under it in characters.
        var tooBig = custom with { Program = new string('é', ViewDefinitionRules.ProgramLimit / 2 + 1) };
        Assert.Equal(
            "'Mine': a custom view's program can be at most 32 KB.",
            ViewDefinitionRules.Refuse([tooBig], null));
        Assert.Null(ViewDefinitionRules.Refuse([custom with { Program = new string('é', ViewDefinitionRules.ProgramLimit / 2) }], null));
    }

    [Fact]
    public void A_calendar_renders_when_it_places_items_by_a_date()
    {
        Assert.True(Calendar("due").CanRender(SchemaOf(Property("due", PropertyType.Date))));
    }

    [Fact]
    public void A_calendar_whose_date_property_was_deleted_cannot_render()
    {
        Assert.False(Calendar("due").CanRender(PropertySchema.Empty));
    }

    [Theory]
    [InlineData(PropertyType.Text)]
    [InlineData(PropertyType.Number)]
    [InlineData(PropertyType.Select)]
    [InlineData(PropertyType.MultiSelect)]
    [InlineData(PropertyType.Checkbox)]
    [InlineData(PropertyType.Url)]
    [InlineData(PropertyType.Image)]
    public void A_calendar_placing_items_by_anything_but_a_date_cannot_render(PropertyType type)
    {
        // Text that happens to hold "2026-07-27" is not a date: nothing has checked it, so half the
        // items would have no square to sit in.
        Assert.False(Calendar("due").CanRender(SchemaOf(Property("due", type))));
    }

    [Fact]
    public void A_calendar_that_names_no_date_property_cannot_render()
    {
        var calendar = new ViewDefinition("v1", "Calendar", ViewKind.Calendar, [], null, [], null, null, false);

        Assert.False(calendar.CanRender(SchemaOf(Property("due", PropertyType.Date))));
    }

    [Fact]
    public void A_board_asks_about_its_grouping_property_and_a_calendar_about_its_date()
    {
        // The per-kind fields are all present on every view, and a view has to ignore the ones that
        // are not its own. A board with a stale dateProperty still renders; a calendar with a stale
        // groupBy still renders.
        var schema = SchemaOf(
            Property("status", PropertyType.Select),
            Property("due", PropertyType.Date));

        var board = new ViewDefinition("v1", "Board", ViewKind.Board, [], "status", [], "missing", null, false);
        var calendar = new ViewDefinition("v2", "Calendar", ViewKind.Calendar, [], "missing", [], "due", null, false);

        Assert.True(board.CanRender(schema));
        Assert.True(calendar.CanRender(schema));
    }

    [Fact]
    public void A_gallery_renders_whether_or_not_it_has_a_cover_property()
    {
        // All four arrangements, because the whole decision this test guards is that none of them
        // is a failure: a gallery is a grid of cards, and the cover is what a card may additionally
        // show. Refusing any of these would take every item off the screen to report a missing
        // picture, which is the trade a board makes for a reason a gallery does not have.
        var bare = new ViewDefinition("v1", "Covers", ViewKind.Gallery, [], null, [], null, null, false);
        var configured = Gallery("cover");

        Assert.True(bare.CanRender(PropertySchema.Empty));
        Assert.True(configured.CanRender(SchemaOf(Property("cover", PropertyType.Image))));

        // Deleted, and retyped to something that is not a picture. Both are one edit in the schema
        // panel, made by somebody who has never seen this gallery, and both leave every item here.
        Assert.True(configured.CanRender(PropertySchema.Empty));
        Assert.True(configured.CanRender(SchemaOf(Property("cover", PropertyType.Number))));
    }

    [Fact]
    public void A_timeline_needs_a_date_to_start_from()
    {
        // The one requirement the kind has, and the whole of it. A bar is placed by its start, so a
        // timeline naming no start property has nothing to place - which is the test this codebase
        // applies to a requirement: the property whose absence leaves nothing on screen.
        //
        // The same requirement drives two call sites - CanRender here, and the storability refusal
        // in SetContainerViewsHandler - so the sentence is asserted alongside the behaviour. It is
        // the timeline's own rather than the calendar's, because the two views ask for the same
        // property and mean visibly different things by it.
        var requirement = ViewKinds.Find(ViewKind.Timeline)?.Requirement;

        Assert.NotNull(requirement);
        Assert.Equal("a timeline needs a date to start from", requirement.Missing);
        Assert.Equal("starts", requirement.Read(Timeline("starts", "ends")));

        var unconfigured = new ViewDefinition("v1", "Delivery", ViewKind.Timeline, [], null, [], null, null, false);

        Assert.False(unconfigured.CanRender(SchemaOf(Property("starts", PropertyType.Date))));
        Assert.True(Timeline("starts", "ends").CanRender(SchemaOf(Property("starts", PropertyType.Date))));
    }

    [Fact]
    public void A_timeline_with_no_end_date_property_is_still_renderable()
    {
        // Every item on it is a milestone: a start with no end is a point on the axis, which is a
        // real and drawable thing rather than half a bar. Refusing here would take every item off
        // the screen over a field that was never required - the trade a board makes for a reason a
        // timeline does not have.
        var milestones = Timeline("starts", endDateProperty: null);

        Assert.True(milestones.CanRender(SchemaOf(Property("starts", PropertyType.Date))));

        // And an end property that has since been deleted or retyped is the same case arrived at
        // from the other direction: the bars become milestones, and the view still draws.
        var spanning = Timeline("starts", "ends");

        Assert.True(spanning.CanRender(SchemaOf(Property("starts", PropertyType.Timestamp))));
        Assert.True(
            spanning.CanRender(
                SchemaOf(Property("starts", PropertyType.Date), Property("ends", PropertyType.Number))));
    }

    [Fact]
    public void Switching_a_view_between_calendar_and_timeline_keeps_its_date_property()
    {
        // The reason `DateProperty` is not renamed to something the timeline would prefer. Both
        // kinds read the same field through the same requirement, so changing only the kind carries
        // the configuration across intact and back again - and a stored calendar written by an
        // older build needs no migration to become a timeline.
        var calendar = Calendar("due");
        var asTimeline = calendar with { Kind = ViewKind.Timeline, EndDateProperty = "ends" };
        var backAgain = asTimeline with { Kind = ViewKind.Calendar };

        var schema = SchemaOf(Property("due", PropertyType.Date), Property("ends", PropertyType.Date));

        Assert.Equal("due", asTimeline.DateProperty);
        Assert.True(asTimeline.CanRender(schema));

        Assert.Equal("due", backAgain.DateProperty);
        Assert.True(backAgain.CanRender(schema));

        // The end property is carried rather than cleared. A switch to a calendar and back must not
        // be the thing that loses half a timeline's configuration.
        Assert.Equal("ends", backAgain.EndDateProperty);
    }

    private static ViewDefinition Timeline(string dateProperty, string? endDateProperty) =>
        new(
            "v1",
            "Delivery",
            ViewKind.Timeline,
            [],
            null,
            [],
            dateProperty,
            null,
            false,
            Mode: null,
            CoverProperty: null,
            EndDateProperty: endDateProperty);

    private static ViewDefinition Gallery(string coverProperty) =>
        new(
            "v1",
            "Gallery",
            ViewKind.Gallery,
            [],
            null,
            [],
            null,
            null,
            false,
            Mode: null,
            CoverProperty: coverProperty);

    private static ViewDefinition Matrix(string? columns, string? rows) =>
        new("v1", "Matrix", ViewKind.Matrix, [], columns, [], null, null, false, RowBy: rows);

    private static ViewDefinition Board(string groupBy) =>
        new("v1", "Board", ViewKind.Board, [], groupBy, [], null, null, false);

    private static ViewDefinition Calendar(string dateProperty) =>
        new("v1", "Calendar", ViewKind.Calendar, [], null, [], dateProperty, null, false);

    private static PropertySchema SchemaOf(params PropertyDefinition[] properties) =>
        new() { Properties = [.. properties], Inherit = true };

    private static PropertyDefinition Property(string key, PropertyType type) =>
        new(key, key, type, ImmutableArray<string>.Empty, Required: false);
}
