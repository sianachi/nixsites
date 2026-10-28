using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Domain.Properties;

namespace Nix.Domain.Items;

/// <summary>
/// Reads and writes the well-known members of an item's property bag.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why the title lives here rather than in a column.</b> The entity model gives an item no
/// title of its own: a name is one of the schema-driven properties an item carries, like any
/// other, and the M0 schema follows that. The API promotes it to a first-class field because every
/// client needs it to render a row, and this is the mapping that makes the promotion honest.
/// </para>
/// <para>
/// The cost is a small JSON parse per item read, which is fine at a page of fifty and is not
/// where this should stay. The goal that introduces property schemas owns the typed
/// representation, and the moment properties are validated on write it should also own an
/// expression index over the title - ordering a folder by name is a query nobody can serve from a
/// string parse.
/// </para>
/// <para>
/// Missing, null, or non-string titles all read as empty rather than throwing. A property bag is
/// client-influenced data and a malformed one is a display problem, not a reason to fail the
/// request that listed it.
/// </para>
/// </remarks>
public static class ItemProperties
{
    /// <summary>
    /// Merges a set of changes into a property bag.
    /// </summary>
    /// <param name="properties">The stored bag, or <see langword="null"/> when the item has none.</param>
    /// <param name="changes">The properties to set, as a JSON object.</param>
    /// <returns>
    /// The merged bag and the keys the changes named, or <see langword="null"/> when the changes
    /// are not a usable JSON object.
    /// </returns>
    /// <remarks>
    /// <para>
    /// <b>A merge rather than a replacement</b>, because a caller sets the properties it is
    /// changing and knows nothing about the rest. A board that replaced the bag would drop every
    /// property it does not display, which is most of them.
    /// </para>
    /// <para>
    /// <b>An explicit null removes the key.</b> That is what a client clearing a field sends, and
    /// keeping a null around would leave "set but empty" and "not set" indistinguishable to
    /// everything downstream.
    /// </para>
    /// <para>
    /// <b>The touched keys come back with the bag because only this method can still see them.</b>
    /// Once a null has removed a key, the merged bag cannot tell "cleared" from "never set", and
    /// that distinction is the whole of the required-value rule
    /// (<see cref="PropertyValidator.ValidateWrite"/>). Returning both together also means the two
    /// cannot disagree: there is no way to hand a validator the bag from one write and the key list
    /// from another, which would fail silently rather than loudly.
    /// </para>
    /// </remarks>
    public static PropertyWrite? Merge(string? properties, string changes)
    {
        ArgumentNullException.ThrowIfNull(changes);

        try
        {
            if (JsonNode.Parse(changes) is not JsonObject incoming)
            {
                return null;
            }

            var bag = ReadObject(properties) ?? new JsonObject();
            var touched = ImmutableArray.CreateBuilder<string>(incoming.Count);

            foreach (var change in incoming)
            {
                touched.Add(change.Key);

                if (change.Value is null)
                {
                    bag.Remove(change.Key);
                    continue;
                }

                // Deep-cloned because a node belongs to exactly one parent: assigning it straight
                // across would detach it from the document being read and leave that one malformed.
                bag[change.Key] = change.Value.DeepClone();
            }

            return new PropertyWrite(bag.ToJsonString(), touched.MoveToImmutable());
        }
        catch (JsonException)
        {
            return null;
        }
        catch (ArgumentException)
        {
            // A document naming the same member twice - {"owner":"Ada","owner":null} - parses, and
            // then throws here on enumeration rather than at the parse. These are client bytes, so
            // the answer is the same 422 any other malformed body gets, never an unhandled
            // exception surfacing as a 500.
            return null;
        }
    }

    private static JsonObject? ReadObject(string? properties)
    {
        if (string.IsNullOrWhiteSpace(properties))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(properties) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>The property an item's display name is stored under.</summary>
    public const string TitleKey = "title";

    /// <summary>The reserved key of the due-date task type, fixed by <c>PropertySchemaRules</c>.</summary>
    public const string DueDateKey = "due_date";

    /// <summary>The reserved key of the reminder task type, fixed by <c>PropertySchemaRules</c>.</summary>
    public const string ReminderKey = "reminder";

    /// <summary>
    /// The system property recording which principal set an item's <see cref="DueDateKey"/>.
    /// </summary>
    /// <remarks>
    /// Written only by <see cref="StampSetBy"/> and <see cref="RestampCopiedSetBy"/> - never by a
    /// client directly (<see cref="IsReservedSchedulingKey"/>). ADR-0051 section 4: the recipient
    /// of a due-task reminder is the principal named here when it is an active principal of the
    /// item's own tenant, falling back to <see cref="Item.CreatedBy"/> otherwise.
    /// </remarks>
    public const string DueSetByKey = "$due_set_by";

    /// <summary>
    /// The system property recording which principal set an item's <see cref="ReminderKey"/>, with
    /// exactly the same mechanics and recipient rule as <see cref="DueSetByKey"/>.
    /// </summary>
    public const string ReminderSetByKey = "$reminder_set_by";

    /// <summary>The reserved key of the completion task type.</summary>
    public const string CompletionKey = "completion";

    /// <summary>The prefix of the keys only the habit endpoints write.</summary>
    public const string HabitPrefix = "$habit_";

    /// <summary>
    /// The prefix of the keys only calendar sync writes (<c>$cal_source</c>, <c>$cal_link</c>,
    /// <c>$cal_readonly</c>; ADR-0052). They say which external event an item mirrors and whether
    /// it may be pushed, so a client that could write them could forge a mirror or unlock a
    /// read-only event.
    /// </summary>
    public const string CalendarPrefix = "$cal_";

    /// <summary>The calendar sync key naming the provider an item was pulled from.</summary>
    public const string CalendarSourceKey = "$cal_source";

    /// <summary>The calendar sync key naming the link an item belongs to.</summary>
    public const string CalendarLinkKey = "$cal_link";

    /// <summary>The calendar sync key marking an event the owner cannot edit upstream.</summary>
    public const string CalendarReadOnlyKey = "$cal_readonly";

    /// <summary>Each scheduled key paired with the system key that records who set it.</summary>
    private static readonly (string Key, string SetByKey)[] SetByPairs =
    [
        (DueDateKey, DueSetByKey),
        (ReminderKey, ReminderSetByKey),
    ];

    /// <summary>
    /// Whether a property key belongs to the scheduler or the habit endpoints and must never be
    /// written by a generic client property write.
    /// </summary>
    /// <remarks>
    /// <see cref="DueSetByKey"/> and <see cref="ReminderSetByKey"/> choose who receives a reminder,
    /// so a client that could write them could send notifications to another principal.
    /// <see cref="HabitPrefix"/> keys are validated only by the habit endpoints
    /// (<c>HabitSettings.Validate</c>, check-in rules), so a generic write would bypass them.
    /// </remarks>
    public static bool IsReservedSchedulingKey(string key)
    {
        ArgumentNullException.ThrowIfNull(key);
        return string.Equals(key, DueSetByKey, StringComparison.Ordinal)
            || string.Equals(key, ReminderSetByKey, StringComparison.Ordinal)
            || key.StartsWith(HabitPrefix, StringComparison.Ordinal)
            || key.StartsWith(CalendarPrefix, StringComparison.Ordinal);
    }

    /// <summary>
    /// Stamps or clears <see cref="DueSetByKey"/> and <see cref="ReminderSetByKey"/> on a bag, for
    /// each of <see cref="DueDateKey"/> and <see cref="ReminderKey"/> this write names among the
    /// keys it touched.
    /// </summary>
    /// <param name="bag">The property bag this write is about to store, as JSON.</param>
    /// <param name="touchedKeys">The keys this specific write named.</param>
    /// <param name="principalId">The principal making this write.</param>
    /// <returns>The bag, with each set-by key set or removed as its scheduled key requires.</returns>
    /// <remarks>
    /// <para>
    /// <b>The single point every scheduled-key write funnels through.</b> A write that
    /// sets a scheduled key to a value stamps who set it; a write that clears it (an explicit null,
    /// or - for create - simply not naming it) removes the stamp too, so a value and its setter
    /// cannot drift apart. A write that never names a scheduled key leaves its existing stamp
    /// untouched, because it is not a write of that key at all.
    /// </para>
    /// <para>
    /// Called once per write, after the bag for that write is known and before it is stored -
    /// after <see cref="Merge"/> for an edit, and against the incoming bag itself for a create -
    /// so both callers land on the one rule rather than restating it.
    /// </para>
    /// <para>
    /// <b>Reopening a dated item is a schedule write too.</b> A write that names
    /// <see cref="CompletionKey"/> and leaves it anything but <see langword="true"/> on an item
    /// with a <see cref="DueDateKey"/> brings that item's due reminders back, so it re-attributes
    /// <see cref="DueSetByKey"/> to whoever reopened it (ADR-0051 Amendment 4). Completing an item
    /// only suppresses reminders and changes no attribution.
    /// </para>
    /// </remarks>
    public static string StampSetBy(
        string bag,
        IReadOnlyCollection<string> touchedKeys,
        string principalId)
    {
        ArgumentNullException.ThrowIfNull(bag);
        ArgumentNullException.ThrowIfNull(touchedKeys);
        ArgumentNullException.ThrowIfNull(principalId);

        var reopens = touchedKeys.Contains(CompletionKey);
        if (!reopens && !SetByPairs.Any(pair => touchedKeys.Contains(pair.Key)))
        {
            return bag;
        }

        JsonObject document;
        try
        {
            document = JsonNode.Parse(bag) as JsonObject ?? [];
        }
        catch (JsonException)
        {
            return bag;
        }

        foreach (var (key, setByKey) in SetByPairs)
        {
            if (touchedKeys.Contains(key))
            {
                Attribute(document, key, setByKey, principalId);
            }
        }

        if (reopens
            && !IsTrue(document[CompletionKey])
            && document[DueDateKey] is not null)
        {
            document[DueSetByKey] = principalId;
        }

        return document.ToJsonString();
    }

    private static bool IsTrue(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;

    /// <summary>
    /// Re-attributes a bag copied from another source (a template application, a document
    /// import) to the principal performing the copy: any set-by value the source carried is
    /// dropped, and each scheduled key that survived the copy is stamped with
    /// <paramref name="principalId"/>.
    /// </summary>
    /// <remarks>
    /// A copied set-by value is never trusted: it names whoever set the value in the source, or
    /// whatever the author of an imported file chose, and keeping it would send the copy's
    /// reminders to that principal. Calendar sync keys (<see cref="CalendarPrefix"/>) are dropped
    /// too: a copy mirrors no external event.
    /// </remarks>
    public static string? RestampCopiedSetBy(string? bag, string principalId)
    {
        ArgumentNullException.ThrowIfNull(principalId);
        if (bag is null
            || (!SetByPairs.Any(pair => bag.Contains(pair.Key, StringComparison.Ordinal) || bag.Contains(pair.SetByKey, StringComparison.Ordinal))
                && !bag.Contains(CalendarPrefix, StringComparison.Ordinal)))
        {
            return bag;
        }

        try
        {
            if (JsonNode.Parse(bag) is not JsonObject document)
            {
                return bag;
            }

            foreach (var (key, setByKey) in SetByPairs)
            {
                Attribute(document, key, setByKey, principalId);
            }

            foreach (var calendarKey in document.Select(pair => pair.Key)
                .Where(key => key.StartsWith(CalendarPrefix, StringComparison.Ordinal))
                .ToList())
            {
                document.Remove(calendarKey);
            }

            return document.ToJsonString();
        }
        catch (JsonException)
        {
            return bag;
        }
        catch (ArgumentException)
        {
            // A member named twice parses, then throws on first use of the object. Returned
            // unchanged so the caller's envelope validation refuses it as a 4xx, as Merge does.
            return bag;
        }
    }

    private static void Attribute(JsonObject document, string key, string setByKey, string principalId)
    {
        if (document.TryGetPropertyValue(key, out var value) && value is not null)
        {
            document[setByKey] = principalId;
        }
        else
        {
            document.Remove(setByKey);
        }
    }

    /// <summary>
    /// Reads the title out of a property bag.
    /// </summary>
    /// <param name="properties">The stored JSON object, or <see langword="null"/>.</param>
    /// <returns>The title, or an empty string when there is none.</returns>
    public static string ReadTitle(string? properties)
    {
        if (string.IsNullOrWhiteSpace(properties))
        {
            return string.Empty;
        }

        try
        {
            return JsonNode.Parse(properties) is JsonObject bag
                && bag.TryGetPropertyValue(TitleKey, out var title)
                && title is JsonValue value
                && value.TryGetValue<string>(out var text)
                    ? text
                    : string.Empty;
        }
        catch (JsonException)
        {
            // Unparseable properties are a display problem for one row, not a reason to fail the
            // request that listed it. The write path is what should have prevented this.
            return string.Empty;
        }
    }

    /// <summary>
    /// Returns a property bag with the title set, preserving every other member.
    /// </summary>
    /// <param name="properties">The existing bag, or <see langword="null"/> to start a new one.</param>
    /// <param name="title">The title to store.</param>
    /// <returns>The updated JSON object.</returns>
    /// <remarks>
    /// <para>
    /// Preserving the rest matters: a rename must not silently drop properties a later goal added,
    /// and "read, replace one key, write the whole bag" is the only shape that survives a schema
    /// this code does not yet know about.
    /// </para>
    /// <para>
    /// A bag naming a member twice is returned unchanged, without the title: it cannot be
    /// rewritten, and every caller that can receive one (document and template imports, template
    /// drafts) validates the result with <c>TemplateDefinitionValidator.ValidateEnvelope</c>, which
    /// refuses it - a 4xx, never an unhandled exception.
    /// </para>
    /// </remarks>
    public static string WithTitle(string? properties, string title)
    {
        ArgumentNullException.ThrowIfNull(title);

        JsonObject bag;
        try
        {
            bag = string.IsNullOrWhiteSpace(properties)
                ? []
                : JsonNode.Parse(properties) as JsonObject ?? [];
        }
        catch (JsonException)
        {
            bag = [];
        }

        try
        {
            bag[TitleKey] = title;
        }
        catch (ArgumentException)
        {
            return properties!;
        }

        return bag.ToJsonString();
    }

    /// <summary>
    /// Whether the bag marks its item as a calendar event the owner cannot edit at its source.
    /// </summary>
    /// <param name="properties">The stored bag, or <see langword="null"/>.</param>
    /// <returns><see langword="true"/> when <see cref="CalendarReadOnlyKey"/> is JSON true.</returns>
    public static bool ReadCalendarReadOnly(string? properties)
    {
        if (string.IsNullOrWhiteSpace(properties))
        {
            return false;
        }

        try
        {
            return JsonNode.Parse(properties) is JsonObject bag
                && bag.TryGetPropertyValue(CalendarReadOnlyKey, out var flag)
                && flag is JsonValue value
                && value.TryGetValue<bool>(out var readOnly)
                && readOnly;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
