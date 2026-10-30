namespace Nix.Domain.Properties;

/// <summary>
/// The kinds of value a property may hold.
/// </summary>
/// <remarks>
/// <para>
/// <b>A closed set, chosen here because no document specifies one.</b> The specification assumes a
/// select type (boards group by one) and a date type (calendars place by one) and never enumerates
/// the rest. Every member earns its place by being what some view needs: a type that could not be
/// sorted, grouped, placed on a calendar or shown as a cover would be a type with no view to
/// render it.
/// </para>
/// <para>
/// <b>Stored as text, never as this ordinal.</b> See <see cref="PropertyTypes"/>. A migration that
/// renumbered the enum must not silently reinterpret every stored schema.
/// </para>
/// <para>
/// Adding a type is deliberately a small change: a member here, a case in
/// <see cref="PropertyTypes"/>, and a case in the validator. Nothing else branches on this - the
/// views ask what a property can do, not what it is - so a new type does not ripple.
/// </para>
/// </remarks>
public enum PropertyType
{
    /// <summary>A single line of text.</summary>
    Text = 0,

    /// <summary>A number, stored as a JSON number.</summary>
    Number = 1,

    /// <summary>One value from a declared list. What a board groups by.</summary>
    Select = 2,

    /// <summary>Any number of values from a declared list.</summary>
    MultiSelect = 3,

    /// <summary>A date, without a time. What a calendar places by.</summary>
    Date = 4,

    /// <summary>True or false.</summary>
    Checkbox = 5,

    /// <summary>An absolute URL.</summary>
    Url = 6,

    /// <summary>
    /// A moment, keeping the local time it was written as and the zone it was written in. What a
    /// calendar places by when the calendar has hours in it.
    /// </summary>
    /// <remarks>
    /// Distinct from <see cref="Date"/> rather than replacing it. A date means "the 3rd" and must
    /// not shift for a reader in another zone; a timestamp means a moment, and must. Both belong on
    /// a calendar, and conflating them would make one of them wrong.
    /// </remarks>
    Timestamp = 7,

    /// <summary>A picture, as an http or https address. What a gallery card shows as its cover.</summary>
    /// <remarks>
    /// <para>
    /// <b>Its own type rather than a <see cref="Url"/> with a convention on top.</b> A link and a
    /// picture are read differently by everything that meets them: a link is text somebody clicks,
    /// and this is fetched and rendered by the browser without anybody deciding to. The schema
    /// saying which one it is, is what lets a gallery offer covers from the properties that are
    /// covers rather than from every link in the workspace.
    /// </para>
    /// <para>
    /// <b>It holds an address today and becomes a file reference at MVP-6</b>, when there is a
    /// media model to reference. There is no file or media model in the backend at all yet, so
    /// storing a reference now would be storing an identifier for a table nothing writes to.
    /// Changing the value's shape later is a migration of the values, not of this member.
    /// </para>
    /// </remarks>
    Image = 8,

    /// <summary>
    /// The date something is owed. Value-shaped exactly like <see cref="Date"/>; the type is the
    /// meaning.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The five task types (this one through <see cref="Estimate"/>) carry their meaning in the
    /// type, deliberately, because that is what goal 3.1 replaces:</b> before them, "the due date"
    /// was a key-name convention (<c>due</c>) that smart lists, seeds and tests each restated. A
    /// schema that declares a property <em>is</em> the due date lets every view bind to the
    /// meaning and lets a workspace call the key whatever it likes. At most one property of each
    /// task type may be declared per schema - "the" due date cannot be two properties - and
    /// <see cref="Domain.Properties.PropertySchemaRules"/> enforces it.
    /// </para>
    /// <para>
    /// This is also what recurrence (3.2) anchors to: a repeating rule expands from the item's
    /// due date, so an item with a rule and no due-date property has nothing to repeat.
    /// </para>
    /// </remarks>
    DueDate = 9,

    /// <summary>
    /// The date work begins. Value-shaped exactly like <see cref="Date"/>; what a timeline draws
    /// as a bar's left edge, paired with <see cref="DueDate"/> as its right.
    /// </summary>
    StartDate = 10,

    /// <summary>
    /// Whether the item is done. Value-shaped exactly like <see cref="Checkbox"/>; the type says
    /// this particular flag is the one that means finished, which is what an Overdue list must
    /// exclude by and a progress rollup must count.
    /// </summary>
    Completion = 11,

    /// <summary>
    /// How urgent, as an integer from 1 (most urgent) to 4 (least). A closed numeric scale rather
    /// than a select, so ordering is intrinsic and no workspace invents "High"/"Highest"/"Urgent"
    /// option sets that cannot be compared.
    /// </summary>
    Priority = 12,

    /// <summary>
    /// How much work, as a non-negative number. The unit is the team's convention (hours,
    /// typically) - the type promises only that estimates are numbers a rollup can sum.
    /// </summary>
    Estimate = 13,

    /// <summary>
    /// Who the item is for: the assigned principal's identifier, as a canonical lowercase UUID
    /// string identifying a <see cref="Domain.Identity.PrincipalId"/>. What an assignee filter and
    /// a workload read bind to.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>An identifier, never a display name.</b> A name is not an identity: it changes when
    /// somebody is renamed, and two people can share one, so a filter or a workload read compiled
    /// against a name would silently drift onto the wrong person or merge two people into one
    /// bucket. The identifier is stable and unique for exactly as long as the principal exists,
    /// which is the property a binding actually needs.
    /// </para>
    /// <para>
    /// <b>Not groupable yet, and not chartable or calendar-placeable.</b> Grouping a board by it is
    /// decided (ADR-0054) - each column titled by the member's name, resolved on the client from
    /// workspace membership - and lands with the web board work that can draw it. A chart's
    /// server-folded buckets would be titled by the raw identifier, so charts will not. It carries
    /// no options either: the set of principals somebody could assign to is a workspace membership
    /// fact, not a per-schema declared list, and offering it belongs to the surface that reads
    /// membership.
    /// </para>
    /// <para>
    /// <b>Task-semantic</b>, taking the reserved key <c>assignee</c> under ADR-0042's rule: a
    /// cross-workspace smart list for "assigned to me" compiles against a key, the same argument
    /// that reserves <see cref="DueDate"/>'s.
    /// </para>
    /// </remarks>
    Assignee = 14,

    /// <summary>
    /// A value computed from the item's other properties by an expression, never written.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The expression lives on the declaration and the value lives nowhere.</b> A formula
    /// property is evaluated wherever it is read, from the values the item carries at that moment,
    /// so it cannot go stale and no write has to recompute anything. That is what goal 2.1's
    /// "evaluated on read" means, and it is why this type is the one type whose values
    /// <see cref="PropertyValidator"/> refuses outright: a stored value for a computed property
    /// would be a second answer able to disagree with the first.
    /// </para>
    /// <para>
    /// <b>Core stores and checks the expression; it does not evaluate one.</b> The formula engine
    /// that ships is <c>@nix/sheet</c>, shared by the editor and the collaboration service so a
    /// formula's value can never differ between them, and a C# evaluator here would be exactly the
    /// second engine goal 2.1 exists to avoid. What Core does own is the part that must not depend
    /// on a client behaving: the references an expression makes are extracted here and the schema is
    /// refused when they form a cycle among the properties it declares - see
    /// <see cref="Domain.Properties.FormulaReferences"/>. ADR-0044 records the split and why it is
    /// drawn by what a value is rather than by where it is convenient to compute.
    /// </para>
    /// </remarks>
    Formula = 15,

    /// <summary>
    /// A value aggregated across the item's children, never written.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>How a container answers "how much of this is done".</b> The declaration names a property
    /// of the children and one of <see cref="RollupAggregate"/>'s reductions; the value is folded
    /// when the item is read and stored nowhere, so it cannot disagree with the children it is
    /// folded from.
    /// </para>
    /// <para>
    /// <b>Computed in SQL, not by the formula engine, and that is the split ADR-0044 draws.</b> A
    /// rollup is an aggregate rather than an expression, so it belongs where the rows are: the
    /// client would otherwise have to fetch every child of every item it draws one for, which the
    /// stress row puts at 3,000+ per container and which is not expressible at all for a list of a
    /// hundred items each showing one. A <see cref="Formula"/> may then read a rollup's value as an
    /// ordinary field, which is what lets "percent complete" be a formula over a rollup rather than
    /// a third mechanism.
    /// </para>
    /// </remarks>
    Rollup = 16,

    /// <summary>
    /// A date or a moment: either <c>yyyy-MM-dd</c> (all-day) or an RFC 9557 timestamp. What a
    /// synced calendar's <c>start</c> and <c>end</c> are declared as, because an upstream event may
    /// be either shape and the property that holds it must accept whichever one arrives.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>One type spanning two shapes, rather than two properties.</b> <see cref="Date"/> and
    /// <see cref="Timestamp"/> stay as they are - a schema author who always means one or the other
    /// keeps the narrower, more precise type - but a synced event toggles between all-day and timed
    /// from one edit to the next on the provider's side, and Nix has to be able to receive either
    /// without the property's declared type changing underneath it.
    /// </para>
    /// <para>
    /// Value-shaped as the union: <see cref="PropertyValidator"/> accepts whichever of
    /// <see cref="Date"/>'s or <see cref="Timestamp"/>'s check the value passes, reusing both checks
    /// rather than inventing a third. Calendar-placeable, like both of the types it unions.
    /// </para>
    /// </remarks>
    DateTime = 17,

    /// <summary>
    /// The instant a reminder should fire, as an RFC 9557 timestamp with its zone. Value-shaped
    /// exactly like <see cref="Timestamp"/>; the type is the meaning.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Task-semantic, taking the reserved key <c>reminder</c>, for the same reason
    /// <see cref="DueDate"/> does: the scheduler plans from the declared role, not from a
    /// workspace-chosen key.
    /// </para>
    /// <para>
    /// <b>Not calendar-placeable.</b> A reminder is when something is announced, not when it
    /// happens; placing it on a calendar next to the moments it announces would double the item on
    /// the grid.
    /// </para>
    /// </remarks>
    Reminder = 18,

    /// <summary>
    /// Plain text that may contain line breaks, for a value too long for a one-line
    /// <see cref="Text"/> field. Stored as a JSON string; carries no formatting.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Value-shaped like <see cref="Text"/> - a string - so sorting, filtering, search and export
    /// treat it as they treat text. What differs is the bound: <see cref="PropertyValidator"/>
    /// refuses a value longer than 8,000 characters.
    /// </para>
    /// <para>
    /// <b>The limit exists because an item's whole property bag is capped at
    /// <see cref="PropertyValidator.MaximumBytes"/> (32 KB).</b> One field must not be able to take
    /// all of that and starve every other property on the item. Anything longer than the limit is
    /// not a property value; it belongs in the item's body, which is what holds long-form content.
    /// </para>
    /// <para>
    /// Not usable as a form respondent identity or as a template text input: those need a short,
    /// single-line value, which is what <see cref="Text"/> is for.
    /// </para>
    /// </remarks>
    LongText = 19,
}

/// <summary>
/// Translates between <see cref="PropertyType"/> and the text stored in a schema.
/// </summary>
/// <remarks>
/// <b>Parsing fails closed.</b> A type this build does not recognise is not a type: the property is
/// dropped from the effective schema rather than guessed at, so an older instance still serving
/// traffic stops validating and stops displaying a property it cannot interpret, instead of
/// accepting values against a rule it invented. That is a loss of function, which is recoverable;
/// the other direction is not.
/// </remarks>
public static class PropertyTypes
{
    /// <summary>Reads a stored type name.</summary>
    /// <param name="text">The stored text.</param>
    /// <param name="type">The type, when recognised.</param>
    /// <returns><see langword="true"/> when the text names a type this build knows.</returns>
    public static bool TryParse(string? text, out PropertyType type)
    {
        switch (text)
        {
            case "text":
                type = PropertyType.Text;
                return true;
            case "number":
                type = PropertyType.Number;
                return true;
            case "select":
                type = PropertyType.Select;
                return true;
            case "multi_select":
                type = PropertyType.MultiSelect;
                return true;
            case "date":
                type = PropertyType.Date;
                return true;
            case "checkbox":
                type = PropertyType.Checkbox;
                return true;
            case "url":
                type = PropertyType.Url;
                return true;
            case "timestamp":
                type = PropertyType.Timestamp;
                return true;
            case "image":
                type = PropertyType.Image;
                return true;
            case "due_date":
                type = PropertyType.DueDate;
                return true;
            case "start_date":
                type = PropertyType.StartDate;
                return true;
            case "completion":
                type = PropertyType.Completion;
                return true;
            case "priority":
                type = PropertyType.Priority;
                return true;
            case "estimate":
                type = PropertyType.Estimate;
                return true;
            case "assignee":
                type = PropertyType.Assignee;
                return true;
            case "formula":
                type = PropertyType.Formula;
                return true;
            case "rollup":
                type = PropertyType.Rollup;
                return true;
            case "datetime":
                type = PropertyType.DateTime;
                return true;
            case "reminder":
                type = PropertyType.Reminder;
                return true;
            case "long_text":
                type = PropertyType.LongText;
                return true;
            default:
                type = default;
                return false;
        }
    }

    /// <summary>Writes a type for storage.</summary>
    /// <param name="type">The type.</param>
    /// <returns>The stored text.</returns>
    /// <exception cref="ArgumentOutOfRangeException">The type is not one this build defines.</exception>
    public static string ToText(PropertyType type) => type switch
    {
        PropertyType.Text => "text",
        PropertyType.Number => "number",
        PropertyType.Select => "select",
        PropertyType.MultiSelect => "multi_select",
        PropertyType.Date => "date",
        PropertyType.Checkbox => "checkbox",
        PropertyType.Url => "url",
        PropertyType.Timestamp => "timestamp",
        PropertyType.Image => "image",
        PropertyType.DueDate => "due_date",
        PropertyType.StartDate => "start_date",
        PropertyType.Completion => "completion",
        PropertyType.Priority => "priority",
        PropertyType.Estimate => "estimate",
        PropertyType.Assignee => "assignee",
        PropertyType.Formula => "formula",
        PropertyType.Rollup => "rollup",
        PropertyType.DateTime => "datetime",
        PropertyType.Reminder => "reminder",
        PropertyType.LongText => "long_text",
        _ => throw new ArgumentOutOfRangeException(nameof(type), type, "Unknown property type."),
    };

    /// <summary>Whether a type's values are computed on read rather than written.</summary>
    /// <param name="type">The type.</param>
    /// <returns><see langword="true"/> when nothing may write a value of this type.</returns>
    /// <remarks>
    /// Asked rather than compared against a member, because the set has already grown once: the
    /// rollup joined the formula here, and every rule that holds for a computed property - no
    /// stored value, never required, no options, refused on write - holds for both. A call site
    /// that pattern-matched <see cref="PropertyType.Formula"/> by name would have had to be found
    /// again for the second one.
    /// </remarks>
    public static bool IsComputed(this PropertyType type) =>
        type is PropertyType.Formula or PropertyType.Rollup;

    /// <summary>Whether a type draws its values from a declared list.</summary>
    /// <param name="type">The type.</param>
    /// <returns><see langword="true"/> for the select types.</returns>
    /// <remarks>
    /// Asked rather than pattern-matched at the call sites, so adding a third list-valued type is
    /// one edit here instead of a search for every place that compared against two names.
    /// </remarks>
    public static bool HasOptions(this PropertyType type) =>
        type is PropertyType.Select or PropertyType.MultiSelect;

    /// <summary>Whether a board, list, sheet or gallery may group by this type.</summary>
    /// <param name="type">The type.</param>
    /// <returns><see langword="true"/> when grouping produces a bounded set of groups.</returns>
    /// <remarks>
    /// <para>
    /// Single-select only for now. Grouping by free text or a number would produce a group per
    /// distinct value, which is a board nobody can read.
    /// </para>
    /// <para>
    /// Grouping by a multi-select, checkbox, completion, priority or assignee is decided
    /// (ADR-0054): a multi-select item sits in each group it carries and a move swaps one option
    /// for the other, and an assignee group is titled by the member's name on the client. It
    /// widens here together with the web board that can draw those groups, and with
    /// <c>canGroupBy</c> in <c>packages/structure-spec</c>; the catalog parity test holds the two
    /// to the same list.
    /// </para>
    /// </remarks>
    public static bool CanGroupBy(this PropertyType type) => type is PropertyType.Select;

    /// <summary>
    /// Whether a list may draw sections, or a matrix may lay out an axis, by this type.
    /// </summary>
    /// <param name="type">The type.</param>
    /// <returns><see langword="true"/> for a single select or anything checkbox-shaped.</returns>
    /// <remarks>
    /// Wider than <see cref="CanGroupBy"/> on purpose: a section heading and a matrix cell already
    /// draw a checkbox's two values, while a board's columns stay select-only until the board can
    /// draw the other shapes (ADR-0054). Each type here gives a small closed set of groups - the
    /// options plus "no value", or yes and no. The web's counterpart is <c>canSectionBy</c> in
    /// <c>packages/structure-spec</c>; the catalog parity test holds the matrix requirement to it.
    /// </remarks>
    public static bool CanSectionBy(this PropertyType type) =>
        type is PropertyType.Select or PropertyType.Checkbox or PropertyType.Completion;

    /// <summary>Whether a chart may bucket its bars by this type.</summary>
    /// <param name="type">The type.</param>
    /// <returns>
    /// <see langword="true"/> for a single select, a priority, a checkbox (or completion) or a
    /// date-shaped type.
    /// </returns>
    /// <remarks>
    /// Kept apart from <see cref="CanGroupBy"/> so the two can widen apart: a chart's buckets are
    /// folded on the server (<c>RunItemChart</c>), which reads one value per item. A multi-select
    /// would count an item in several bars and an assignee bar would be labelled by an identifier.
    /// A priority (1 to 4) and a checkbox (true or false; an unset one lands in the "no value"
    /// bucket) are each one value from a small closed set. A date is the time axis (plan 2.2): the
    /// chart folds each item's day into a period, which a board has no use for. The web's
    /// counterpart is <c>canChartBy</c> in <c>packages/structure-spec</c>; the two must widen
    /// together.
    /// </remarks>
    public static bool CanChartBy(this PropertyType type) =>
        type is PropertyType.Select or PropertyType.Priority or PropertyType.Checkbox
            or PropertyType.Completion
        || type.CanPlaceOnCalendar();

    /// <summary>Whether a chart may split its buckets into series by this type.</summary>
    /// <param name="type">The type.</param>
    /// <returns><see langword="true"/> for the choice types: one of a few values per item.</returns>
    /// <remarks>
    /// A split makes a series per distinct value, and a free-text or numeric property has a value
    /// per item - a legend nobody can read and a read that groups by every child. A single choice,
    /// a yes/no and a person each take one of a small set of values.
    /// </remarks>
    public static bool CanSplitBy(this PropertyType type) =>
        type is PropertyType.Select or PropertyType.Checkbox or PropertyType.Completion
            or PropertyType.Assignee;

    /// <summary>Whether a calendar may place items by this type.</summary>
    /// <param name="type">The type.</param>
    /// <returns><see langword="true"/> for the date-shaped types.</returns>
    public static bool CanPlaceOnCalendar(this PropertyType type) =>
        type is PropertyType.Date or PropertyType.Timestamp
            or PropertyType.DueDate or PropertyType.StartDate or PropertyType.DateTime;

    /// <summary>
    /// Whether a type names a task-semantic role, of which a schema may declare at most one.
    /// </summary>
    /// <param name="type">The type.</param>
    /// <returns><see langword="true"/> for a type that names a task-semantic role.</returns>
    /// <remarks>
    /// "The due date" is singular by meaning: two properties both claiming to be it would leave
    /// every view that binds to the meaning choosing arbitrarily. Ordinary types carry no such
    /// claim, so a schema may declare as many dates or checkboxes as it likes.
    /// </remarks>
    public static bool IsTaskSemantic(this PropertyType type) =>
        type is PropertyType.DueDate or PropertyType.StartDate or PropertyType.Completion
            or PropertyType.Priority or PropertyType.Estimate or PropertyType.Assignee
            or PropertyType.Reminder;
}
