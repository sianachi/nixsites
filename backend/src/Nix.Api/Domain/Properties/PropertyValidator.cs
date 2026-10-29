using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using NodaTime;
using NodaTime.Text;

namespace Nix.Domain.Properties;

/// <summary>
/// One reason a property bag was refused.
/// </summary>
/// <param name="Key">The property at fault.</param>
/// <param name="Reason">What is wrong with it, in terms a person can act on.</param>
public sealed record PropertyViolation(string Key, string Reason);

/// <summary>
/// A merge's result: the bag as it would be stored, and the keys the write named.
/// </summary>
/// <param name="Merged">The bag after the changes were applied.</param>
/// <param name="Touched">
/// Every key the change document named, whether it set the value or cleared it.
/// </param>
/// <remarks>
/// The two travel together because the second cannot be recovered from the first: clearing a
/// property removes its key, so a merged bag cannot say whether a missing value was just deleted or
/// was never there. Carrying them as one value also removes the only way to use them wrongly -
/// pairing a bag from one write with the key list from another, which would quietly enforce the
/// wrong rule rather than fail.
/// </remarks>
public readonly record struct PropertyWrite(string Merged, ImmutableArray<string> Touched);

/// <summary>
/// Checks a property bag against the schema in force where the item sits.
/// </summary>
/// <remarks>
/// <para>
/// <b>Declared keys are checked strictly; undeclared keys are left alone.</b> That asymmetry is
/// ADR-0007 §4 and it is deliberate. A schema is edited by people, and if removing a property made
/// every existing value illegal, one schema edit would break the next write to every item beneath
/// it - on data the writer never touched. Preserving them means a property dropped from a schema
/// stops being validated and stops being displayed, and returns intact if the schema does.
/// </para>
/// <para>
/// It is also what keeps <c>title</c> working: it lives in the property bag and no schema declares
/// it.
/// </para>
/// <para>
/// <b>Every violation is reported, not just the first.</b> A form with three bad fields should say
/// so once rather than over three round trips.
/// </para>
/// <para>
/// <b>Nothing here asks whether an item is complete.</b> Both entry points check the values in
/// front of them and differ only in which values are owed: a create owes none, and a write owes
/// the ones it named. There is deliberately no "does this bag satisfy its schema" question,
/// because the only thing that ever asked it used the answer to refuse writes that had nothing to
/// do with the missing value. If a screen one day needs to show that a row is incomplete, that is
/// a read, and it should arrive with the reader that needs it.
/// </para>
/// </remarks>
public static class PropertyValidator
{
    /// <summary>The largest a property bag may be, matching the column's own bound.</summary>
    /// <remarks>
    /// Checked here as well as by the database so an oversized bag is a problem document naming
    /// the limit rather than a constraint violation surfacing as a 500.
    /// </remarks>
    public const int MaximumBytes = 32 * 1024;

    /// <summary>
    /// The most characters a <see cref="PropertyType.LongText"/> value may hold. A fraction of
    /// <see cref="MaximumBytes"/>, so one field cannot take the whole property bag; longer content
    /// belongs in the item's body.
    /// </summary>
    public const int MaximumLongTextLength = 8000;

    /// <summary>
    /// Every violation in a write, with required-ness enforced only on the keys it touched.
    /// </summary>
    /// <param name="write">The merged bag and the keys the write named.</param>
    /// <param name="schema">The effective schema at the item's position.</param>
    /// <returns>Every violation found, empty when the write is acceptable.</returns>
    /// <remarks>
    /// <para>
    /// <b>You cannot empty a required property; you are not blocked by one somebody else left
    /// empty.</b> Those are two different questions and this is the only place that tells them
    /// apart. Checking the whole merged bag for completeness - which this used to do - meant that
    /// declaring a property required retroactively write-locked every item beneath it: a board drag
    /// setting <c>status</c> was refused because <c>owner</c>, which the drag never touched and the
    /// board does not show, had never been filled in. The only way out was a write supplying every
    /// missing required value at once, and no interface offers one.
    /// </para>
    /// <para>
    /// It is the same principle the views take (see <c>ContainerViews</c>): a schema and the data
    /// under it are edited independently, so refusing a write on the state of something it did not
    /// touch makes the order of two unrelated edits matter. Required stays enforceable, because
    /// clearing a required value is itself a write to that key and is refused.
    /// </para>
    /// <para>
    /// Takes a <see cref="PropertyWrite"/> rather than the bag and the change document separately,
    /// so the two views of one write cannot be mismatched, and so the change document is parsed
    /// once - by the merge that already had to walk it - instead of twice per request.
    /// </para>
    /// </remarks>
    public static ImmutableArray<PropertyViolation> ValidateWrite(
        PropertyWrite write,
        PropertySchema schema) =>
        Validate(write.Merged, schema, write.Touched);

    /// <summary>
    /// Every violation in the values that were supplied, ignoring the ones that were not.
    /// </summary>
    /// <param name="properties">The values being supplied, as JSON.</param>
    /// <param name="schema">The schema in force.</param>
    /// <returns>One violation per supplied value that does not fit its declaration.</returns>
    /// <remarks>
    /// <b>What a create asks, because a required property is a statement about a finished item
    /// rather than about a first keystroke.</b> Checking completeness on create would mean an item
    /// could not be made inside a container that requires anything - the ordinary flow of making a
    /// note and then filling in its fields would be refused at the first step, and the only way to
    /// create one would be to know every required field up front.
    ///
    /// <para>
    /// Everything else is checked exactly as it would be later. A value supplied at creation faces
    /// its declaration's type and options, so this is not a way to store something the schema would
    /// refuse a moment afterwards.
    /// </para>
    /// </remarks>
    public static ImmutableArray<PropertyViolation> ValidateSupplied(
        string? properties,
        PropertySchema schema) =>
        Validate(properties, schema, NothingRequired);

    /// <summary>A create owes no required value, so nothing is enforced.</summary>
    /// <remarks>
    /// An empty <see cref="ImmutableArray{T}"/> rather than an empty set: immutable by
    /// construction, so a shared static cannot be added to by a later edit, and the runtime hands
    /// back the same instance rather than allocating.
    /// </remarks>
    private static readonly ImmutableArray<string> NothingRequired = [];

    /// <summary>
    /// The one check, over the declared properties.
    /// </summary>
    /// <param name="properties">The bag to check.</param>
    /// <param name="schema">The schema in force.</param>
    /// <param name="mustBePresent">
    /// The declared keys whose absence is a violation. Every other declared key may be missing:
    /// what varies between a create and a write is not how a value is checked but which values are
    /// owed at all.
    /// </param>
    private static ImmutableArray<PropertyViolation> Validate(
        string? properties,
        PropertySchema schema,
        ImmutableArray<string> mustBePresent)
    {
        ArgumentNullException.ThrowIfNull(schema);

        if (properties is not null && System.Text.Encoding.UTF8.GetByteCount(properties) > MaximumBytes)
        {
            return
            [
                new PropertyViolation(
                    string.Empty,
                    $"A property bag may be at most {MaximumBytes} bytes."),
            ];
        }

        JsonObject? bag;
        try
        {
            bag = properties is null ? null : JsonNode.Parse(properties) as JsonObject;
        }
        catch (JsonException)
        {
            return [new PropertyViolation(string.Empty, "The properties are not valid JSON.")];
        }

        if (properties is not null && bag is null)
        {
            return [new PropertyViolation(string.Empty, "The properties must be a JSON object.")];
        }

        var violations = ImmutableArray.CreateBuilder<PropertyViolation>();

        foreach (var definition in schema.Properties)
        {
            var value = bag?[definition.Key];

            if (IsAbsent(value))
            {
                // A scan rather than a set: a change document names one or two keys in the cases
                // that matter, and building a hash set to answer two questions costs more than
                // asking them. String equality here is ordinal, which is what the schema uses.
                if (definition.Required && mustBePresent.Contains(definition.Key))
                {
                    violations.Add(new PropertyViolation(definition.Key, $"{definition.Label} is required."));
                }

                continue;
            }

            var reason = Check(definition, value);
            if (reason is not null)
            {
                violations.Add(new PropertyViolation(definition.Key, reason));
            }
        }

        return violations.ToImmutable();
    }

    /// <summary>
    /// Whether a value counts as not supplied.
    /// </summary>
    /// <remarks>
    /// An explicit null is the same as absent, because that is what a client clearing a field
    /// sends. Treating them differently would make "required" satisfiable by sending null.
    /// </remarks>
    private static bool IsAbsent(JsonNode? value) => value is null;

    private static string? Check(PropertyDefinition definition, JsonNode? value) => definition.Type switch
    {
        PropertyType.Text => ReadString(value) is null ? $"{definition.Label} must be text." : null,

        PropertyType.Number => value is JsonValue number && number.TryGetValue(out double _)
            ? null
            : $"{definition.Label} must be a number.",

        PropertyType.Checkbox => value is JsonValue flag && flag.TryGetValue(out bool _)
            ? null
            : $"{definition.Label} must be true or false.",

        PropertyType.Date => CheckDate(definition, value),
        PropertyType.Timestamp => CheckTimestamp(definition, value),
        PropertyType.Url => CheckUrl(definition, value),
        PropertyType.Select => CheckSelect(definition, value),
        PropertyType.MultiSelect => CheckMultiSelect(definition, value),
        PropertyType.Image => CheckImage(definition, value),

        // The task types are value-shaped like the plain types they refine - the type carries the
        // meaning, not a new representation - so a due date is checked exactly as a date is. That
        // identity is load-bearing: every stored comparison is `left(value, 10)` over the same
        // yyyy-MM-dd text, and a task type with its own shape would quietly fall out of it.
        PropertyType.DueDate => CheckDate(definition, value),
        PropertyType.StartDate => CheckDate(definition, value),
        PropertyType.Completion => CheckCompletion(definition, value),
        PropertyType.Priority => CheckPriority(definition, value),
        PropertyType.Estimate => CheckEstimate(definition, value),
        PropertyType.Assignee => CheckAssignee(definition, value),

        // The one type whose every value is wrong. A formula property is evaluated on read from
        // the item's other properties, so a stored value for one would be a second answer able to
        // disagree with the computed one - and the stored one would win, silently, wherever a
        // reader took the bag at face value. Refusing the write is what keeps "computed" true.
        PropertyType.Formula => $"{definition.Label} is computed from a formula and cannot be set.",

        // Same rule, same reason: a rollup is folded from this item's children when it is read, so
        // a stored value for one would be a second answer able to disagree with the children it
        // claims to summarise - and the stored one would win wherever a reader took the bag at
        // face value.
        PropertyType.Rollup =>
            $"{definition.Label} is rolled up from this item's children and cannot be set.",

        PropertyType.DateTime => CheckDateTime(definition, value),

        // Value-shaped exactly like Timestamp - an RFC 9557 moment with its zone - the type is the
        // meaning: this is the instant a reminder fires, checked the same way a plain Timestamp
        // property is.
        PropertyType.Reminder => CheckTimestamp(definition, value),

        PropertyType.LongText => CheckLongText(definition, value),

        // A type this build defines and this switch does not handle is a bug here, not a value the
        // caller got wrong - and the arm it falls into decides whether that bug is loud or silent.
        // It used to be `_ => null`, which is "accepted": an unhandled member let any JSON node
        // through, unchecked, straight into whatever renders that property. Throwing matches
        // PropertyTypes.ToText, which already treats an undefined member as a bug, and
        // Every_type_this_build_defines_refuses_a_value_of_the_wrong_shape turns it into a failing
        // test rather than a production surprise. The arm cannot simply be deleted: a switch
        // expression over an enum warns CS8509 without one, and warnings are errors here.
        // The parameter name, not `nameof(definition.Type)`: CA2208 requires paramName to be an
        // actual parameter of this method, and the member is carried by the value argument instead
        // - so the exception still reports which type it was.
        _ => throw new ArgumentOutOfRangeException(
            nameof(definition),
            definition.Type,
            "Unknown property type."),
    };

    /// <summary>
    /// A completion is a boolean, checked exactly as a checkbox is - the type refines meaning,
    /// never representation.
    /// </summary>
    private static string? CheckCompletion(PropertyDefinition definition, JsonNode? value)
    {
        return value is JsonValue flag && flag.TryGetValue(out bool _)
            ? null
            : $"{definition.Label} must be true or false.";
    }

    /// <summary>
    /// A priority is an integer from 1 (most urgent) to 4 (least): a closed scale with intrinsic
    /// order, which is what makes priorities from different containers comparable in one list.
    /// </summary>
    private static string? CheckPriority(PropertyDefinition definition, JsonNode? value)
    {
        return value is JsonValue number
            && number.TryGetValue(out double parsed)
            && double.IsInteger(parsed)
            && parsed is >= 1 and <= 4
            ? null
            : $"{definition.Label} must be a whole number from 1 (most urgent) to 4.";
    }

    /// <summary>
    /// An estimate is a non-negative number. The unit is the team's convention; the type promises
    /// only that a rollup can sum it.
    /// </summary>
    private static string? CheckEstimate(PropertyDefinition definition, JsonNode? value)
    {
        return value is JsonValue number
            && number.TryGetValue(out double parsed)
            && double.IsFinite(parsed)
            && parsed >= 0
            ? null
            : $"{definition.Label} must be a number of zero or more.";
    }

    /// <summary>
    /// An assignee is the assigned principal's identifier, written exactly the way
    /// <see cref="Domain.Identity.PrincipalId"/> itself renders one - a lowercase, hyphenated UUID
    /// with no braces. The check is a round trip rather than a loose parse: the text must read as
    /// a UUID and, printed back in that canonical form, must equal what was written. That is what
    /// catches the near misses a hand-written client sends - upper case hex, braces, a missing
    /// dash, an empty string - the same way a stricter type refuses a near-miss shape elsewhere in
    /// this file rather than normalising it on the way in.
    /// </summary>
    /// <remarks>
    /// <b>Deliberately does not check that the principal exists or is a member of the
    /// workspace.</b> This is a pure domain rule with no I/O, and membership is a fact that
    /// changes after the value is written - a principal leaving the workspace must not turn every
    /// item already assigned to them into a write that fails, which is the same argument ADR-0007
    /// section 4 makes for an undeclared key surviving a schema edit. The surface that offers a
    /// principal to assign - not this validator - is where membership belongs.
    /// </remarks>
    private static string? CheckAssignee(PropertyDefinition definition, JsonNode? value)
    {
        var text = ReadString(value);

        return text is not null
            && Guid.TryParseExact(text, "D", out var principal)
            && string.Equals(text, principal.ToString("D", CultureInfo.InvariantCulture), StringComparison.Ordinal)
            ? null
            : $"{definition.Label} must be the assigned person's id, as a lowercase UUID.";
    }

    private static string? CheckDate(PropertyDefinition definition, JsonNode? value)
    {
        var text = ReadString(value);

        // ISO 8601 date, no time and no zone. A property that means "the 3rd" must not shift to
        // the 2nd for a reader in another zone, which is exactly what storing an instant would do.
        return text is not null
            && DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _)
            ? null
            : $"{definition.Label} must be a date, as yyyy-MM-dd.";
    }

    /// <summary>
    /// A date-or-time is accepted whenever either half of the union it names would accept it: a
    /// bare <c>yyyy-MM-dd</c> date, or an RFC 9557 timestamp with its zone.
    /// </summary>
    /// <remarks>
    /// Reuses <see cref="CheckDate"/> and <see cref="CheckTimestamp"/> rather than parsing the
    /// value a third way, so this type can never accept something neither of the types it unions
    /// would - the two checks it defers to are exactly what a plain <see cref="Date"/> or
    /// <see cref="Timestamp"/> property already enforces. The date shape is tried first because a
    /// synced calendar's all-day events are the common case; either order accepts the same set.
    /// </remarks>
    private static string? CheckDateTime(PropertyDefinition definition, JsonNode? value)
    {
        if (CheckDate(definition, value) is null)
        {
            return null;
        }

        if (CheckTimestamp(definition, value) is null)
        {
            return null;
        }

        return $"{definition.Label} must be a date, as yyyy-MM-dd, or a time with its zone, " +
            "as 2026-03-17T09:00:00+00:00[Europe/London].";
    }

    /// <summary>
    /// The zone database every stored timestamp is resolved against.
    /// </summary>
    /// <remarks>
    /// NodaTime's own copy, not the host's. Zone rules change - governments move their clocks -
    /// and a value that resolved one way on a developer's machine and another on a server would be
    /// a bug nobody could reproduce.
    /// </remarks>
    private static readonly IDateTimeZoneProvider Zones = DateTimeZoneProviders.Tzdb;

    /// <summary>
    /// Reads a timestamp: a local time, the offset it was written at, and the zone it belongs to.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The zone is stored because the instant alone is not enough.</b> A 09:00 Europe/London
    /// standup kept only as a moment becomes 10:00 London the day the clocks change - the instant
    /// was preserved and the meaning was thrown away. Keeping the zone keeps what somebody meant,
    /// and the instant is derivable from it at any time.
    /// </para>
    /// <para>
    /// RFC 9557, which is what Temporal and the JavaScript date libraries emit:
    /// <c>2026-03-17T09:00:00+00:00[Europe/London]</c>. One string rather than an object, because a
    /// property value flows through sorting, filtering and every view's cells, none of which know
    /// what an object-shaped value is.
    /// </para>
    /// <para>
    /// <b>The offset is checked against the zone.</b> A value whose offset disagrees with what its
    /// zone was actually doing at that moment renders differently depending on which half is
    /// believed, and there is no way to know which one was meant.
    /// </para>
    /// </remarks>
    private static string? CheckTimestamp(PropertyDefinition definition, JsonNode? value)
    {
        const string shape =
            "must be a time with its zone, as 2026-03-17T09:00:00+00:00[Europe/London]";

        var text = ReadString(value);
        if (text is null)
        {
            return $"{definition.Label} {shape}.";
        }

        var open = text.IndexOf('[', StringComparison.Ordinal);
        if (open < 0 || !text.EndsWith(']'))
        {
            // A bare offset is not a zone. "+01:00" says what the clock read, not which rules it
            // was following, so it cannot survive the next time those rules change.
            return $"{definition.Label} {shape}.";
        }

        var zoneId = text[(open + 1)..^1];
        var zone = Zones.GetZoneOrNull(zoneId);
        if (zone is null)
        {
            return $"{definition.Label} names the time zone '{zoneId}', which is not one this build knows.";
        }

        var moment = OffsetDateTimePattern.Rfc3339.Parse(text[..open]);
        if (!moment.Success)
        {
            return $"{definition.Label} {shape}.";
        }

        var written = moment.Value;
        if (zone.GetUtcOffset(written.ToInstant()) != written.Offset)
        {
            return $"{definition.Label} has an offset that '{zoneId}' was not using at that moment.";
        }

        return null;
    }

    /// <summary>
    /// Reads a long text: a string that may contain line breaks, at most
    /// <see cref="MaximumLongTextLength"/> characters.
    /// </summary>
    private static string? CheckLongText(PropertyDefinition definition, JsonNode? value)
    {
        var text = ReadString(value);
        if (text is null)
        {
            return $"{definition.Label} must be text.";
        }

        return text.Length > MaximumLongTextLength
            ? $"{definition.Label} must be at most 8,000 characters."
            : null;
    }

    private static string? CheckUrl(PropertyDefinition definition, JsonNode? value)
    {
        var text = ReadString(value);

        // Absolute only, and only over http. A relative URL has no meaning outside the page it was
        // written on, and allowing arbitrary schemes here would put javascript: one render away
        // from being clicked.
        return text is not null
            && Uri.TryCreate(text, UriKind.Absolute, out var uri)
            && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
            ? null
            : $"{definition.Label} must be an http or https address.";
    }

    /// <summary>
    /// Reads a cover image: an address a browser may fetch and draw.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>http and https only, and this is a security check rather than a tidiness rule.</b> A URL
    /// property is text somebody chooses to click; this value goes into an <c>img src</c> and is
    /// fetched by every reader's browser without anybody deciding to. <c>javascript:</c> and
    /// <c>data:</c> are one render away from being executed or inlined.
    /// </para>
    /// <para>
    /// <b>It is not the only check, and must not be described as one.</b> Values are validated
    /// against the declaration in force when they are written, and a schema edit deliberately does
    /// not revalidate what is already stored - that asymmetry is ADR-0007 §4 and this class's own
    /// opening remark. So a value written while the property was text or a link survives a retype
    /// to <see cref="PropertyType.Image"/> having never met this method. The renderer checks the
    /// scheme again for exactly that reason; see <c>isFetchableAddress</c> in
    /// <c>packages/web-views/src/gallery/gallery-view.tsx</c>, which is the layer that holds regardless of the
    /// order somebody made two independent edits in.
    /// </para>
    /// <para>
    /// <b>The file extension is deliberately not checked.</b> A URL with no extension serves images
    /// perfectly well - most image hosts and every content-negotiating endpoint have none - and an
    /// extension guarantees nothing about what comes back, because the server does not fetch it.
    /// Validating one would be a claim this build cannot back, and it would refuse addresses that
    /// work.
    /// </para>
    /// <para>
    /// <b>Or a file reference: <c>nix-file:</c> followed by a file item's id.</b> The same scheme
    /// note bodies use for uploaded images. It is never put into an <c>img src</c>; the renderer
    /// resolves it by fetching the file item's content through Core, which checks the reader's
    /// access to that item, so a reference to an item the reader cannot see draws nothing rather
    /// than disclosing it. Only a well-formed id is accepted, so the scheme cannot smuggle text.
    /// </para>
    /// </remarks>
    private static string? CheckImage(PropertyDefinition definition, JsonNode? value)
    {
        var text = ReadString(value);

        return text is not null
            && (IsFileImageReference(text)
                || (Uri.TryCreate(text, UriKind.Absolute, out var uri)
                    && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)))
            ? null
            // Its own sentence rather than the link one: somebody who has been told to enter "an
            // http or https address" has no reason to think a picture was wanted.
            : $"{definition.Label} must be a link to an image, over http or https.";
    }

    // Written by packages/web-collections/src/properties/inputs/image-value.tsx (FILE_IMAGE_PREFIX); keep the two in step.
    private const string FileImageReferencePrefix = "nix-file:";

    private static bool IsFileImageReference(string text) =>
        text.StartsWith(FileImageReferencePrefix, StringComparison.Ordinal)
        && Guid.TryParseExact(text[FileImageReferencePrefix.Length..], "D", out _);

    private static string? CheckSelect(PropertyDefinition definition, JsonNode? value)
    {
        var text = ReadString(value);
        if (text is null)
        {
            return $"{definition.Label} must be one of its options.";
        }

        return definition.Allows(text)
            ? null
            : $"{definition.Label} does not offer '{text}'.";
    }

    private static string? CheckMultiSelect(PropertyDefinition definition, JsonNode? value)
    {
        if (value is not JsonArray values)
        {
            return $"{definition.Label} must be a list of its options.";
        }

        foreach (var entry in values)
        {
            var text = ReadString(entry);
            if (text is null)
            {
                // Named as what it is rather than as "null": a bag carrying a number where a
                // select value belongs is a different mistake from one carrying a value the
                // schema does not offer, and a message that conflated them would send somebody
                // checking their options list for an entry that was never the problem.
                return $"{definition.Label} takes text values; '{entry?.ToJsonString() ?? "null"}' is not one.";
            }

            if (!definition.Allows(text))
            {
                return $"{definition.Label} does not offer '{text}'.";
            }
        }

        return null;
    }

    private static string? ReadString(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue(out string? text) ? text : null;
}
