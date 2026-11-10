using System.Collections.Immutable;

namespace Nix.Domain.Views;

/// <summary>
/// How a container may be looked at.
/// </summary>
/// <remarks>
/// A view is a way of rendering a container's children, not a place in the application. That is
/// why it is stored on the container rather than being a route: "board" is something an item can
/// be shown as, and the same item can be shown as a list a moment later without going anywhere.
/// </remarks>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1027:Mark enums with FlagsAttribute", Justification = "Value 12 is retired, not a flag.")]
public enum ViewKind
{
    /// <summary>Rows and columns, one row per child.</summary>
    List = 0,

    /// <summary>Cards grouped into columns by a single-select property.</summary>
    Board = 1,

    /// <summary>Items placed on a month by a date property.</summary>
    Calendar = 2,

    /// <summary>Children as a grid of cards, each optionally showing a cover image.</summary>
    /// <remarks>
    /// No requirement, and deliberately: a gallery with no cover property is a grid of titled
    /// cards, which is readable and useful and is what most galleries are on the day they are made.
    /// A requirement is a property whose absence leaves nothing on screen - a board with no
    /// grouping has no columns at all - and a cover is not one.
    /// </remarks>
    Gallery = 3,

    /// <summary>Children as horizontal bars across a time axis, spanning a start and an end.</summary>
    /// <remarks>
    /// <para>
    /// One requirement, not two, and it is the calendar's verbatim. A start date is what puts a bar
    /// on the axis at all - no start, no position - so its absence leaves nothing on screen, which
    /// is the test this codebase applies. An end date is a different thing: an item with a start and
    /// no end is a milestone, which is a real and drawable shape, and a timeline of milestones is a
    /// perfectly good timeline.
    /// </para>
    /// <para>
    /// <b>An end before its start is not refused here.</b> The two are independent property writes
    /// and cannot both be valid at every instant, so refusing would make the fix depend on which one
    /// somebody happens to correct first - the same argument <c>SetContainerViewsHandler.Refuse</c>
    /// makes about a view naming a property the schema does not declare yet. The view reports the
    /// pair; the server does not police it.
    /// </para>
    /// </remarks>
    Timeline = 4,

    /// <summary>Children as an editable grid, one row per child and one column per property.</summary>
    /// <remarks>
    /// The <em>view</em> axis only: rows are children and cells are property values, so an edit
    /// here is a property write visible in every other view. The spreadsheet <em>body</em>
    /// (<c>item.type == "spreadsheet"</c>) is the other axis - free cells and formulas, owned by
    /// the item itself. The two axes share a vocabulary and always will: the stored words differ
    /// (<c>"sheet"</c> here, <c>"spreadsheet"</c> there) only so the wire values cannot collide,
    /// and a grep for either word still lands on both features' surroundings - mind the axis when
    /// reading a hit.
    /// </remarks>
    Sheet = 5,

    /// <summary>A fillable form over the schema; each submission creates a child.</summary>
    /// <remarks>
    /// The intake shape - a daily tracker, an inventory log: the view renders the container's
    /// effective schema as fields, and a submit is an ordinary item create carrying the values.
    /// Nothing new is stored or read on this axis; the kind exists so a container can *offer*
    /// entry as a view, switchable beside the list the entries land in. ADR-0040 records why a
    /// kind that writes children rather than drawing them still belongs on this axis.
    /// </remarks>
    Form = 6,

    /// <summary>A saved cross-container query: the view's filters, run server-side.</summary>
    /// <remarks>
    /// The smart-list kind (goal 3.4). Unlike every other kind it does not draw the item's own
    /// children - its results come from <c>GET /items/{id}/query</c>, which compiles the stored
    /// <see cref="ViewDefinition.Filters"/> into SQL filtered by the reader's own reach. The
    /// client never sends rules; the stored view is the whole query. ADR-0039 records the design.
    /// </remarks>
    Query = 7,

    /// <summary>A multi-page, conditional form whose answers create a child item.</summary>
    InteractiveForm = 8,

    /// <summary>Children summarised into buckets: counted, or totalled by a numeric property.</summary>
    /// <remarks>
    /// <para>
    /// Goal 2.3, and a way of looking at children like every other kind on this axis - "how much of
    /// this is Done" is the same question a board answers by eye, drawn so it can be read at a
    /// glance instead of counted.
    /// </para>
    /// <para>
    /// <b>It groups by the property a board would group by, under the board's own field.</b> The
    /// same requirement and the same reason: grouping by free text would produce a bar per distinct
    /// value, which is a chart nobody can read. Sharing <see cref="ViewDefinition.GroupBy"/> is what
    /// makes switching a view between board and chart lossless, exactly as the calendar and the
    /// timeline share their date property.
    /// </para>
    /// <para>
    /// <b>Its buckets come from the server, not from the loaded page.</b> Like <see cref="Query"/>
    /// and unlike every other kind, it does not draw what the client already holds: a chart over a
    /// container whose children are only partly loaded would be a picture of the first page
    /// presented as a picture of the whole. <c>GET /items/{id}/chart</c> is where the buckets come
    /// from, and ADR-0044 records why the aggregate is computed where the rows are.
    /// </para>
    /// </remarks>
    Chart = 9,

    /// <summary>Habit children arranged by local date with recorded progress.</summary>
    HabitTracker = 10,

    /// <summary>A file-manager look at a container's children: rows or tiles, sortable, movable.</summary>
    /// <remarks>
    /// Issue #54's whole point: a drive is a way of looking at a container's children, exactly
    /// like every other kind on this axis, and not a kind of item a folder gets created as. There
    /// is no <c>Item.type == "folder"</c> anywhere in this codebase for the same reason there is
    /// no such row here for one - what makes a child read as "a folder" is that it holds children,
    /// which every item already can, not a body kind reserved for the purpose.
    ///
    /// Requirement-free like <see cref="List"/> and for the identical reason: with no schema at
    /// all a drive still has titles, kinds and modified dates to draw. Its list/grid layout choice
    /// and its sort are drawn client-side and are not modeled here - see the frontend registry's
    /// own remarks on why that is this kind's honest scope for now.
    /// </remarks>
    Drive = 11,

    // 12 was the retired finance kind. Stored views are text, and the migration RetireFinanceViews
    // rewrote them to sheet; never reuse the number.

    /// <summary>One line per child: a checkbox, the title and one optional property.</summary>
    /// <remarks>
    /// Requirement-free, like <see cref="List"/>: with nothing configured it ticks the property
    /// named <c>done</c>, or the schema's task completion, and with neither it still lists titles
    /// and says what it would need to tick them. <see cref="ViewDefinition.DoneProperty"/> names
    /// the checkbox when the default is not the one wanted; whether it names a checkbox is the
    /// view's report to make, for the reason <see cref="ViewDefinitionRules"/> gives about every
    /// property a view names: the view can be configured before its property exists.
    /// </remarks>
    Checklist = 13,

    /// <summary>Cards in a grid of cells, placed by two properties at once.</summary>
    /// <remarks>
    /// Columns come from <see cref="ViewDefinition.GroupBy"/>, the board's own field, which is what
    /// makes switching a view between board and matrix keep its columns; rows come from
    /// <see cref="ViewDefinition.RowBy"/>. Both must be a select or a checkbox
    /// (<see cref="Nix.Domain.Properties.PropertyTypes.CanSectionBy"/>). Like a board's column, a
    /// card's cell is its two property values and never a placement stored against the view, so a
    /// card dragged to another cell is one write of both properties.
    /// </remarks>
    Matrix = 14,

    /// <summary>The subtree as a collapsible tree of titles, edited by keyboard.</summary>
    /// <remarks>
    /// The one kind that edits structure rather than properties: adding a sibling, indenting and
    /// reordering all go through the item create and move endpoints, so everything a move already
    /// refuses - a lock, an item that accepts no children, a cycle - is refused here too.
    /// Requirement-free, because a tree of titles needs nothing from the schema.
    /// </remarks>
    Outline = 15,

    /// <summary>Ordered message children rendered as a conversation.</summary>
    Chat = 16,

    /// <summary>A program the viewer's browser draws over the container's children.</summary>
    /// <remarks>
    /// No requirement: the program names whatever it reads. The program is
    /// <see cref="ViewDefinition.Program"/>, stored in the view and never executed by Core, by an
    /// export or by a published site.
    /// </remarks>
    Custom = 17,
}

/// <summary>
/// What a kind needs from the schema before it can draw anything.
/// </summary>
/// <param name="Read">Which field on the view names the property this kind depends on.</param>
/// <param name="Accepts">Which property types will serve.</param>
/// <param name="Missing">
/// How to finish the sentence "'&lt;view name&gt;': ..." when the field is not set.
/// </param>
/// <remarks>
/// A list has no requirement: with no columns configured it falls back to the effective schema, and
/// with no schema at all it still has titles to show. That is why this is nullable on the
/// descriptor rather than every kind carrying a vacuous one.
/// </remarks>
public sealed record ViewRequirement(
    Func<ViewDefinition, string?> Read,
    Func<Nix.Domain.Properties.PropertyType, bool> Accepts,
    string Missing);

/// <summary>
/// Everything this build knows about one view kind, in one place.
/// </summary>
/// <param name="Kind">The kind.</param>
/// <param name="Text">The name it is stored and published under.</param>
/// <param name="Requirement">What it needs from the schema, or null when it needs nothing.</param>
public sealed record ViewKindDescriptor(ViewKind Kind, string Text, ViewRequirement? Requirement);

/// <summary>
/// The kinds this build can draw, and what each one needs.
/// </summary>
/// <remarks>
/// <para>
/// <b>One entry per kind, and adding a kind is one entry.</b> This knowledge used to be spread
/// across four switch statements - parse, write, "can this render", and "is this storable" - which
/// meant adding a kind was four edits in two projects and forgetting one of them compiled fine.
/// The table is the single declaration; the four call sites read it.
/// </para>
/// <para>
/// Stored as text, never as the ordinal, so renumbering the enum cannot reinterpret stored views.
/// Parsing fails closed: a kind this build does not recognise is dropped, so an older instance
/// offers fewer views rather than rendering one it does not understand.
/// </para>
/// <para>
/// A kind added to <see cref="ViewKind"/> but not to this table has no text to be stored under, so
/// <see cref="ToText"/> throws rather than inventing one. <c>Every_kind_has_a_descriptor</c> in the
/// test suite is what turns that runtime bug into a build failure.
/// </para>
/// </remarks>
public static class ViewKinds
{
    /// <summary>Every kind this build knows.</summary>
    public static readonly ImmutableArray<ViewKindDescriptor> All =
    [
        new ViewKindDescriptor(ViewKind.List, "list", Requirement: null),
        new ViewKindDescriptor(ViewKind.Chat, "chat", Requirement: null),
        new ViewKindDescriptor(ViewKind.HabitTracker, "habit_tracker", Requirement: null),

        new ViewKindDescriptor(
            ViewKind.Board,
            "board",
            new ViewRequirement(
                static view => view.GroupBy,
                static type => Nix.Domain.Properties.PropertyTypes.CanGroupBy(type),
                "a board needs a property to group by")),

        new ViewKindDescriptor(
            ViewKind.Calendar,
            "calendar",
            new ViewRequirement(
                static view => view.DateProperty,
                static type => Nix.Domain.Properties.PropertyTypes.CanPlaceOnCalendar(type),
                "a calendar needs a date property")),

        // Like a list, and for the same reason: a gallery with no cover property still has titled
        // cards to draw. The cover is an enrichment, not the thing that makes the view exist.
        new ViewKindDescriptor(ViewKind.Gallery, "gallery", Requirement: null),

        // The calendar's requirement, reused field for field: a timeline places a bar by the same
        // date property a calendar places a card by, which is what makes switching a view between
        // the two lossless. Only the sentence differs, because the two views want different things
        // said to somebody who has not configured one yet.
        new ViewKindDescriptor(
            ViewKind.Timeline,
            "timeline",
            new ViewRequirement(
                static view => view.DateProperty,
                static type => Nix.Domain.Properties.PropertyTypes.CanPlaceOnCalendar(type),
                "a timeline needs a date to start from")),

        // Like a list, and by the list's own argument: with no columns configured the grid falls
        // back to the effective schema, and with no schema at all it still has titles to show.
        new ViewKindDescriptor(ViewKind.Sheet, "sheet", Requirement: null),

        // Requirement-free by the same fallback: with no columns configured the form offers the
        // effective schema's fields, and with no schema at all it still takes a title.
        new ViewKindDescriptor(ViewKind.Form, "form", Requirement: null),

        // Requirement-free because the requirement mechanism reads one string field and this
        // kind's configuration is the Filters array - policed in SetContainerViewsHandler.Refuse
        // instead. An empty filter set is valid and means "everything readable, newest first".
        new ViewKindDescriptor(ViewKind.Query, "query", Requirement: null),

        new ViewKindDescriptor(ViewKind.InteractiveForm, "interactive_form", Requirement: null),

        // Like a list, and by the list's own argument: with nothing configured a drive still has
        // titles, kinds and dates to draw from the effective schema and the items themselves.
        new ViewKindDescriptor(ViewKind.Drive, "drive", Requirement: null),

        // Like a list, and by the list's own argument: with nothing configured a checklist still
        // has titles to list, and it falls back to a "done" checkbox or the task completion.
        new ViewKindDescriptor(ViewKind.Checklist, "checklist", Requirement: null),

        // Titles and structure only, so like a list it needs nothing from the schema.
        new ViewKindDescriptor(ViewKind.Outline, "outline", Requirement: null),

        // No requirement, like a list: the program decides what it reads.
        new ViewKindDescriptor(ViewKind.Custom, "custom", Requirement: null),

        // The board's field for its columns, so a board switched to a matrix keeps them, but the
        // wider section predicate: a matrix cell draws a checkbox's two values honestly. Its rows
        // are a second property, checked by ViewDefinitionRules and CanRender, because the
        // requirement mechanism reads one field.
        new ViewKindDescriptor(
            ViewKind.Matrix,
            "matrix",
            new ViewRequirement(
                static view => view.GroupBy,
                static type => Nix.Domain.Properties.PropertyTypes.CanSectionBy(type),
                "a matrix needs a property for its columns")),

        // The board's requirement, reused field for field, which is what makes switching a view
        // between the two lossless. Only the sentence differs, because the two kinds want
        // different things said to somebody who has not configured one yet.
        new ViewKindDescriptor(
            ViewKind.Chart,
            "chart",
            new ViewRequirement(
                static view => view.GroupBy,
                static type => Nix.Domain.Properties.PropertyTypes.CanChartBy(type),
                "a chart needs a property to group by")),
    ];

    /// <summary>Reads a stored kind.</summary>
    /// <param name="text">The stored text.</param>
    /// <param name="kind">The kind, when recognised.</param>
    /// <returns><see langword="true"/> when the text names a kind this build knows.</returns>
    public static bool TryParse(string? text, out ViewKind kind)
    {
        // A scan rather than a dictionary: the table is a handful of entries, and an ordinal
        // comparison over three strings beats hashing one.
        foreach (var descriptor in All)
        {
            if (string.Equals(descriptor.Text, text, StringComparison.Ordinal))
            {
                kind = descriptor.Kind;
                return true;
            }
        }

        kind = default;
        return false;
    }

    /// <summary>Writes a kind for storage.</summary>
    /// <param name="kind">The kind.</param>
    /// <returns>The stored text.</returns>
    /// <exception cref="ArgumentOutOfRangeException">The kind is not one this build defines.</exception>
    public static string ToText(ViewKind kind) =>
        Find(kind)?.Text
        ?? throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown view kind.");

    /// <summary>Finds what this build knows about a kind.</summary>
    /// <param name="kind">The kind.</param>
    /// <returns>The descriptor, or <see langword="null"/> when the table has no entry for it.</returns>
    public static ViewKindDescriptor? Find(ViewKind kind)
    {
        foreach (var descriptor in All)
        {
            if (descriptor.Kind == kind)
            {
                return descriptor;
            }
        }

        return null;
    }
}

/// <summary>
/// The sizes a gallery may draw its cards at.
/// </summary>
/// <remarks>
/// <para>
/// A closed set, unlike <c>Mode</c>, whose unrecognised values each kind quietly defaults: the
/// grain vocabularies overlap across kinds on purpose, so the field has to stay open for a view to
/// switch kinds losslessly. A card size is one kind's own and shared with nothing, so there is
/// nothing an unknown value could be preserving - <c>SetContainerViewsHandler.Refuse</c> refuses it
/// outright, which tells the person typing it now rather than the person reading a silently
/// medium-sized gallery later.
/// </para>
/// <para>
/// Stored as text rather than as an enum for the same reason <see cref="ViewKinds"/> stores text:
/// the words are the contract, and renumbering nothing can reinterpret them.
/// </para>
/// </remarks>
/// <summary>What a chart's bars measure.</summary>
/// <remarks>
/// <b>Two, and both always have an answer.</b> A count needs nothing configured, and a total needs
/// a numeric property. Anything else - a median, a distinct count - is a fold this build does not
/// compute, and offering one it could not draw would be a chart that renders empty for a reason
/// nobody can see. Stored as text, like every other vocabulary here.
/// </remarks>
public static class ChartMeasures
{
    /// <summary>How many children fall in each bucket. The default, and what absent has always meant.</summary>
    public const string Count = "count";

    /// <summary>The total of a numeric property across the children in each bucket.</summary>
    public const string Sum = "sum";

    /// <summary>Whether a stored or requested value names a measure this build defines.</summary>
    /// <param name="value">The value.</param>
    /// <returns><see langword="true"/> when it is one of the two.</returns>
    public static bool IsValid(string value) =>
        string.Equals(value, Count, StringComparison.Ordinal)
        || string.Equals(value, Sum, StringComparison.Ordinal);
}

/// <summary>
/// The two ways a drive view draws its rows. Closed and policed on write like the gallery's card
/// sizes, and for the same reason: a layout is a word the client switches on, and a stray one would
/// be a drive that draws as nothing.
/// </summary>
public static class DriveLayouts
{
    /// <summary>The default, and what absent has always meant: one row per item.</summary>
    public const string List = "list";

    /// <summary>Tiles with a kind icon, for a folder of files.</summary>
    public const string Grid = "grid";

    /// <summary>Whether a stored or requested value names a layout this build defines.</summary>
    /// <param name="value">The value.</param>
    /// <returns><see langword="true"/> when it is one of the two layouts.</returns>
    public static bool IsValid(string value) =>
        string.Equals(value, List, StringComparison.Ordinal)
        || string.Equals(value, Grid, StringComparison.Ordinal);
}

/// <summary>How an item activated from a view opens; null on the view means the client's own default.</summary>
public static class ViewOpenModes
{
    /// <summary>The whole pane navigates to the item.</summary>
    public const string Page = "page";

    /// <summary>The item opens in a dialog over the view.</summary>
    public const string Dialog = "dialog";

    /// <summary>The item opens in another pane next to the view.</summary>
    public const string Beside = "beside";

    /// <summary>The item opens as its own pinned document tab.</summary>
    public const string Tab = "tab";

    /// <summary>A click selects (or does nothing); double-click, Enter and the menu still open.</summary>
    public const string None = "none";

    /// <summary>Every mode this build defines; a new mode is one more entry here.</summary>
    public static readonly IReadOnlyList<string> All = [Page, Dialog, Beside, Tab, None];

    /// <summary>Whether a stored or requested value names a mode this build defines.</summary>
    /// <param name="value">The value.</param>
    /// <returns><see langword="true"/> when it is one of <see cref="All"/>.</returns>
    public static bool IsValid(string value) => All.Contains(value, StringComparer.Ordinal);
}

public static class GalleryCardSizes
{
    /// <summary>Denser columns and a squarer cover.</summary>
    public const string Small = "small";

    /// <summary>The default, and what absent has always meant.</summary>
    public const string Medium = "medium";

    /// <summary>Fewer columns and a more generous cover.</summary>
    public const string Large = "large";

    /// <summary>Whether a stored or requested value names a size this build defines.</summary>
    /// <param name="value">The value.</param>
    /// <returns><see langword="true"/> when it is one of the three sizes.</returns>
    public static bool IsValid(string value) =>
        string.Equals(value, Small, StringComparison.Ordinal)
        || string.Equals(value, Medium, StringComparison.Ordinal)
        || string.Equals(value, Large, StringComparison.Ordinal);
}

/// <summary>
/// One named way of looking at a container.
/// </summary>
/// <param name="Id">
/// Stable across renames, because the active view is named in the URL and a shared link must not
/// break when somebody renames the view it points at.
/// </param>
/// <param name="Name">What a person sees in the switcher.</param>
/// <param name="Kind">Which renderer this view uses.</param>
/// <param name="Columns">
/// For a list: the property keys to show, in order. Empty means the effective schema decides,
/// which is what a view created without configuration should do.
/// </param>
/// <param name="GroupBy">
/// For a board: the single-select property whose values become columns. For a list: the select or
/// checkbox property, or the reserved <c>$type</c> (each item's body kind), whose values become
/// sections - optional, and stored as given, because a list with no usable grouping still draws
/// its rows flat.
/// </param>
/// <param name="GroupOrder">
/// For a board: which of that property's values to show, in which order. Empty means every value
/// the schema declares.
/// </param>
/// <param name="DateProperty">
/// For a calendar: the date property that places an item. For a timeline: the date a bar starts on.
/// </param>
/// <param name="SortBy">The property key to order by, or <see langword="null"/> for sibling order.</param>
/// <param name="SortDescending">Which way to order.</param>
/// <param name="Mode">
/// The per-kind grain. For a calendar: <c>month</c>, <c>week</c> or <c>day</c>. For a timeline:
/// <c>week</c>, <c>month</c> or <c>quarter</c>. Anything else, including absent, means that kind's
/// own default. The two vocabularies overlapping is deliberate: it is what lets a view switched
/// between the two kinds keep the grain it had rather than being reset to one nobody chose.
/// </param>
/// <param name="CoverProperty">
/// For a gallery: the image property whose value each card shows as its cover, or
/// <see langword="null"/> for a grid of titled cards.
/// </param>
/// <param name="EndDateProperty">
/// For a timeline: the date a bar ends on, or <see langword="null"/> for a timeline of milestones.
/// </param>
/// <param name="CardSize">
/// For a gallery: how large each card is drawn - <c>small</c>, <c>medium</c> or <c>large</c>, and
/// <see langword="null"/> means <c>medium</c>, which is what every gallery stored before this field
/// existed has always looked like.
/// </param>
/// <param name="Filters">
/// The conditions a view's items must meet, AND-combined; default and empty both mean none. A query
/// view compiles them to SQL across the workspace; a list, board, calendar, timeline, gallery or
/// sheet applies them to its own children (ADR-0054, which reverses the earlier "stored and
/// ignored"). A chart stores them without applying them: its buckets are folded on the server,
/// which does not read them.
/// </param>
/// <remarks>
/// <para>
/// <b>One record for every kind, rather than a hierarchy.</b> The per-kind fields are nullable
/// and a view ignores the ones that are not its own. A discriminated hierarchy would be tidier in
/// the type system and worse everywhere else: this shape is serialised to a jsonb column and to an
/// OpenAPI schema, and both would need the union spelled out by hand, in two more places that can
/// disagree with this one.
/// </para>
/// <para>
/// <b><see cref="GroupOrder"/> is the view's, not the schema's.</b> The specification is explicit
/// that board columns are freely definable and not tied to a property's allowed values - a board
/// may show three of six statuses and order them however it likes.
/// </para>
/// <para>
/// <b>There is no placement or layout here, deliberately.</b> A card's position on a board is its
/// property value and its sibling order, never a coordinate stored against the view. That is what
/// makes dragging a card an edit to the item - visible in every other view and to everybody else -
/// rather than a change to how one person happens to be looking at it.
/// </para>
/// </remarks>
public sealed record FormCondition(string FieldBlockId, string Operator, string? Value);

public sealed record FormBlock(
    string Id,
    string Kind,
    string? PropertyKey,
    string Text,
    string? Help,
    bool Required,
    string? IdentityRole,
    ImmutableArray<FormCondition> VisibleWhen);

public sealed record FormPage(
    string Id,
    string Title,
    string? Description,
    ImmutableArray<FormCondition> VisibleWhen,
    ImmutableArray<FormBlock> Blocks);

public sealed record InteractiveFormDefinition(
    ImmutableArray<FormPage> Pages,
    string TitleMode,
    string? TitleFieldBlockId,
    string ConfirmationTitle,
    string ConfirmationMessage);

public sealed record ViewDefinition(
    string Id,
    string Name,
    ViewKind Kind,
    ImmutableArray<string> Columns,
    string? GroupBy,
    ImmutableArray<string> GroupOrder,
    string? DateProperty,
    string? SortBy,
    bool SortDescending,

    // Last and defaulted, so every existing construction keeps working and absent keeps meaning
    // "month" - which is what every view stored before this field existed.
    string? Mode = null,

    // Same rule, and it is the record's own: every construction here is positional, so a per-kind
    // field added anywhere but the end would silently re-bind arguments at dozens of call sites.
    // Absent means a gallery of titled cards, which is what every view stored before this existed.
    string? CoverProperty = null,

    // Same rule again. **Not paired with DateProperty into a range, and DateProperty is not renamed
    // to StartDateProperty**: that name is what a stored calendar already uses, so renaming it would
    // break every calendar in every workspace, and keeping it is what makes switching a view between
    // calendar and timeline lossless in both directions.
    //
    // Nullable because it is genuinely optional: a start with no end is a milestone, which the
    // timeline draws as a point rather than as a bar. Nothing here refuses an end that falls before
    // its start; see ViewKind.Timeline for why that is the view's report to make and not the
    // server's.
    string? EndDateProperty = null,

    // Same rule once more: last and defaulted, so no positional construction re-binds. Null means
    // medium - the size every gallery drew at before the field existed - and the value set is
    // closed and policed on write; see GalleryCardSizes for why this one is refused where Mode's
    // strays are defaulted.
    string? CardSize = null,

    // Last and defaulted like every field added since the record was first cut. For a query view:
    // the conditions the server compiles and runs, AND-combined, each policed on write against
    // QueryOperators' closed grammar. Default (unset) and empty both mean "no conditions" - for a
    // query view that is "everything readable, newest first", and for every other kind the field
    // is stored and ignored (ADR-0020: cheap to ignore, expensive to police). ADR-0039 records
    // why this is a structured field rather than a packed string.
    ImmutableArray<FilterRule> Filters = default,
    string? CompanionViewId = null,
    string? CompanionPlacement = null,
    InteractiveFormDefinition? InteractiveForm = null,

    // Last and defaulted like every field added since the record was cut. For a chart: what each
    // bar measures - `count`, which needs nothing else, or `sum`, which totals MeasureProperty
    // across the children in each bucket. Null and an unrecognised value both mean `count`, which
    // is what a chart with nothing configured draws and the only measure that always has an answer.
    string? Measure = null,
    string? MeasureProperty = null,
    ImmutableArray<HabitWidgetDefinition> HabitWidgets = default,

    // Last and defaulted, like every field added since the record was first cut. For a drive: list
    // or grid. Null means list, which is what every drive drew before the field existed; the set is
    // closed and policed on write, see DriveLayouts.
    string? Layout = null,

    // The four below are last and defaulted like every field added since the record was cut, and
    // they are how somebody arranges what a container view shows (ADR-0054). Sorts is the ordered
    // list of keys; SortBy and SortDescending mirror its first entry so a build that reads only
    // those still orders by the primary key. CollapsedGroups and GroupLimits name groups by the
    // grouping property's stored value, the empty string standing for the "no value" group.
    // Aggregates are what a list or sheet summarises per column. None of them is a placement: a
    // card's position is still its value and its sibling order.
    ImmutableArray<ViewSort> Sorts = default,
    ImmutableArray<string> CollapsedGroups = default,
    ImmutableArray<ViewGroupLimit> GroupLimits = default,
    ImmutableArray<ViewAggregate> Aggregates = default,

    // Last and defaulted, like every field added since the record was cut. For a checklist: the
    // checkbox (or completion) property its boxes tick. Null means the checklist's own fallback -
    // a property keyed `done`, then the schema's task completion - which is what lets a checklist
    // made with no configuration work on a to-do list as it stands.
    string? DoneProperty = null,

    // Last and defaulted, like every field added since the record was cut. For a matrix: the select
    // or checkbox property whose values become its rows; its columns are GroupBy, the board's own.
    string? RowBy = null,

    // Last and defaulted like every field added since the record was cut. For a chart: its type,
    // time axis, series and window (ChartOptions). Null draws what every chart stored before the
    // field existed drew - horizontal bars of categories - and every other kind stores and ignores it.
    ChartOptions? Chart = null,

    // Last and defaulted like every field added since the record was cut. For every kind: how an
    // item activated from this view opens - `page`, `dialog`, `beside`, `tab` or `none`. Null means the client's
    // own context-aware default, which is what every view stored before the field existed did; the
    // set is closed and policed on write, see ViewOpenModes.
    string? Open = null,

    // Last and defaulted, like every field added since the record was cut. For a custom view: the
    // openui-lang source its browser draws, at most ViewDefinitionRules.ProgramLimit bytes. On
    // every other kind it is stored and ignored (ADR-0020).
    string? Program = null)
{
    /// <summary>
    /// Whether this view can render given the schema in force.
    /// </summary>
    /// <param name="schema">The effective schema at the container.</param>
    /// <returns><see langword="true"/> when the view's required property exists and fits.</returns>
    /// <remarks>
    /// A board grouping by a property that has since been deleted, or retyped to something that
    /// cannot be grouped, has no columns to draw. Asking here lets the interface say so plainly
    /// rather than rendering an empty board that looks like an item with nothing in it.
    /// </remarks>
    public bool CanRender(Nix.Domain.Properties.PropertySchema schema)
    {
        ArgumentNullException.ThrowIfNull(schema);

        // A kind with no requirement always renders, and a kind this build has no descriptor for
        // cannot be drawn at all - which is the safer answer than "yes" for something unknown.
        if (ViewKinds.Find(Kind) is not { } descriptor)
        {
            return false;
        }

        if (Kind == ViewKind.Chat)
        {
            return ChatSchema.Refuse(schema) is null;
        }

        if (descriptor.Requirement is not { } requirement)
        {
            return true;
        }

        return requirement.Read(this) is { } key
            && schema.Find(key) is { } property
            && requirement.Accepts(property.Type)
            && (Kind != ViewKind.Matrix
                || (RowBy is { } rowKey
                    && schema.Find(rowKey) is { } rows
                    && Nix.Domain.Properties.PropertyTypes.CanSectionBy(rows.Type)));
    }
}

/// <summary>A saved habit chart and its inclusive local-date range.</summary>
public sealed record HabitWidgetDefinition(string Id, string Kind, Guid HabitId, DateOnly From, DateOnly To);

/// <summary>Rules about a view's ordering that every writer applies alike.</summary>
public static class ViewSorting
{
    /// <summary>
    /// Mirrors the first of a view's sort keys into its single-key fields.
    /// </summary>
    /// <param name="view">The view as written.</param>
    /// <returns>The view with <c>SortBy</c> and <c>SortDescending</c> naming its primary key.</returns>
    /// <remarks>
    /// So a reader that knows only the single-key fields - an older build, an export, the query
    /// runner - still orders by the primary key. With no sort list the single-key fields are the
    /// whole statement, as they were before the list existed.
    /// </remarks>
    public static ViewDefinition MirrorPrimary(ViewDefinition view)
    {
        ArgumentNullException.ThrowIfNull(view);

        return view.Sorts.IsDefaultOrEmpty
            ? view
            : view with { SortBy = view.Sorts[0].Property, SortDescending = view.Sorts[0].Descending };
    }
}

/// <summary>One key a view orders its items by.</summary>
/// <param name="Property">The property key, or <c>title</c>.</param>
/// <param name="Descending">Which way.</param>
public sealed record ViewSort(string Property, bool Descending);

/// <summary>A soft limit on how many items one group should hold.</summary>
/// <param name="Group">The grouping property's stored value; empty for the "no value" group.</param>
/// <param name="Limit">The count past which the group is shown as over its limit.</param>
/// <remarks>
/// A signal, never a refusal: moving an item into a full group still succeeds. A board that
/// refused the move would make the limit a lock on the work rather than a prompt about it.
/// </remarks>
public sealed record ViewGroupLimit(string Group, int Limit);

/// <summary>What a list or sheet shows beneath one column.</summary>
/// <param name="Property">The property key the summary folds.</param>
/// <param name="Function">One of <see cref="ViewAggregateFunctions"/>' closed set.</param>
public sealed record ViewAggregate(string Property, string Function);

/// <summary>The summaries a column may show, and the limits on a view's arrangement fields.</summary>
/// <remarks>
/// Folded on the client over the rows it shows; stored as text for the same reason every token in
/// this file is, so a summary a newer build adds costs an older one the footer, not the view.
/// </remarks>
public static class ViewAggregateFunctions
{
    /// <summary>How many rows.</summary>
    public const string Count = "count";

    /// <summary>How many rows have no value.</summary>
    public const string CountEmpty = "count-empty";

    /// <summary>How many rows have a value.</summary>
    public const string CountFilled = "count-filled";

    /// <summary>The total of a number column.</summary>
    public const string Sum = "sum";

    /// <summary>The mean of a number column.</summary>
    public const string Average = "average";

    /// <summary>The smallest value.</summary>
    public const string Min = "min";

    /// <summary>The largest value.</summary>
    public const string Max = "max";

    /// <summary>The share of a checkbox column that is checked.</summary>
    public const string PercentChecked = "percent-checked";

    /// <summary>Every function this build defines.</summary>
    public static readonly ImmutableArray<string> All =
        [Count, CountEmpty, CountFilled, Sum, Average, Min, Max, PercentChecked];

    /// <summary>Whether the function is one this build defines.</summary>
    /// <param name="value">The stored text.</param>
    /// <returns><see langword="true"/> when it is in <see cref="All"/>.</returns>
    public static bool IsValid(string value) => All.Contains(value);
}
