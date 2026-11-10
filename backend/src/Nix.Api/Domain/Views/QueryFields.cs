using System.Collections.Immutable;

namespace Nix.Domain.Views;

/// <summary>
/// The structural fields a query rule may test besides property keys: facts about the item rather
/// than values in its property bag, spelled as <c>$</c>-prefixed names so the rule grammar stays
/// one shape (owner decision D2 of the queries plan).
/// </summary>
/// <remarks>
/// <para>
/// <b>The prefix is reserved.</b> A schema declaration (<c>PropertySchemaRules</c>), a generic
/// create (<c>CreateItem</c>) and a generic property write (<c>SetItemProperties</c>) refuse a
/// client <c>$</c> key; the template draft edit, template capture and template and document
/// import paths drop every <c>$</c> key but habit content
/// (<c>ReservedPropertyContent</c>). A <c>$</c> name in a rule can therefore only mean a
/// field from this closed set, and one outside it is refused rather than read as a property.
/// ADR-0060 records the ad-hoc query surface these fields belong to.
/// </para>
/// <para>
/// <b>Only a query compiles them.</b> A container view evaluates its rules in the browser over
/// children it already holds, and its children are all "inside" the container by construction;
/// <see cref="QueryRules"/> refuses a structural field on any other view kind.
/// </para>
/// </remarks>
public static class QueryFields
{
    /// <summary>The prefix that marks a structural field.</summary>
    public const char Prefix = '$';

    /// <summary>The item's body kind (<c>item.type</c>): task, note, habit, ...</summary>
    public const string Type = "$type";

    /// <summary>
    /// The item sits somewhere beneath the named ancestor, read through the closure table. The
    /// value is the ancestor's id.
    /// </summary>
    /// <remarks>
    /// A rule matches rows, so an ancestor the caller cannot see - missing, in another workspace,
    /// or locked - simply matches nothing, the same answer as an empty folder, and says nothing
    /// about it; a scope, by contrast, names the container the whole request is about, so it
    /// answers the item read's own 404 or 423 for it.
    /// </remarks>
    public const string Inside = "$inside";

    /// <summary>The day the item was created, in the caller's zone.</summary>
    public const string Created = "$created";

    /// <summary>The day the item was last modified, in the caller's zone.</summary>
    public const string Modified = "$modified";

    /// <summary>
    /// The completion state the task feature defines: the reserved <c>completion</c> property set
    /// to <c>true</c>. Absent or <c>false</c> both read as not done.
    /// </summary>
    public const string Done = "$done";

    /// <summary>
    /// Reserved for "has tag". Refused until the product has a tag model to read - there is no
    /// tag storage today, and a field that silently matched nothing would read as "no tagged items".
    /// </summary>
    public const string Tag = "$tag";

    /// <summary>The longest <see cref="Type"/> value a rule may carry - a body kind is a short word.</summary>
    public const int MaximumTypeLength = 64;

    /// <summary>The fields a rule may test today.</summary>
    public static readonly ImmutableArray<string> Filterable = [Type, Inside, Created, Modified, Done];

    /// <summary>The fields a query may be ordered by, beside any property key.</summary>
    public static readonly ImmutableArray<string> Sortable = [Type, Created, Modified];

    /// <summary>The fields a query may be grouped by, beside a property key.</summary>
    public static readonly ImmutableArray<string> Groupable = [Type];

    /// <summary>Whether a name is in the reserved <c>$</c> space.</summary>
    /// <param name="name">A rule's property, a sort key, a group key or a property key.</param>
    /// <returns><see langword="true"/> when it starts with <see cref="Prefix"/>.</returns>
    public static bool IsReserved(string name)
    {
        ArgumentNullException.ThrowIfNull(name);
        return name.Length > 0 && name[0] == Prefix;
    }

    /// <summary>Whether a structural field reads days.</summary>
    /// <param name="field">The field name.</param>
    /// <returns><see langword="true"/> for the two timestamps.</returns>
    public static bool IsDay(string field) => field is Created or Modified;

    /// <summary>
    /// The sentence refusing a rule over a structural field, or null when it is meaningful.
    /// </summary>
    /// <param name="rule">A leaf rule whose property is reserved and whose grammar already passed.</param>
    /// <returns>How to finish "'&lt;view name&gt;': ...", or <see langword="null"/>.</returns>
    public static string? Refuse(FilterRule rule)
    {
        ArgumentNullException.ThrowIfNull(rule);

        switch (rule.Property)
        {
            case Type:
                if (rule.Operator is not (QueryOperators.EqualTo or QueryOperators.NotEqualTo))
                {
                    return $"'{Type}' compares with '{QueryOperators.EqualTo}' or '{QueryOperators.NotEqualTo}'";
                }

                return rule.Value.Length > MaximumTypeLength
                    ? $"a '{Type}' value may be at most {MaximumTypeLength} characters"
                    : null;

            case Inside:
                if (rule.Operator is not (QueryOperators.EqualTo or QueryOperators.NotEqualTo))
                {
                    return $"'{Inside}' compares with '{QueryOperators.EqualTo}' or '{QueryOperators.NotEqualTo}'";
                }

                return Guid.TryParseExact(rule.Value, "D", out _)
                    ? null
                    : $"'{Inside}' reads an item id";

            case Created:
            case Modified:
                return QueryOperators.IsDateShaped(rule.Operator)
                    ? null
                    : $"'{rule.Property}' is a day, so it compares with the day operators";

            case Done:
                if (rule.Operator is not (QueryOperators.EqualTo or QueryOperators.NotEqualTo))
                {
                    return $"'{Done}' compares with '{QueryOperators.EqualTo}' or '{QueryOperators.NotEqualTo}'";
                }

                return rule.Value is "true" or "false"
                    ? null
                    : $"'{Done}' reads true or false";

            case Tag:
                return $"'{Tag}' is reserved and cannot be filtered on yet";

            default:
                return $"'{rule.Property}' is not a field a query can test; names starting with "
                    + $"'{Prefix}' are reserved for {string.Join(", ", Filterable)}";
        }
    }
}
