using System.Collections.Immutable;

namespace Nix.Domain.Properties;

/// <summary>
/// One property a schema declares: what it is called, what it holds, and what it will accept.
/// </summary>
/// <param name="Key">
/// The key the value is stored under in an item's property bag. Stable; the label may change
/// freely, this may not.
/// </param>
/// <param name="Label">What a person sees. Free text, and the only part safe to rename.</param>
/// <param name="Type">What kind of value it holds.</param>
/// <param name="Options">
/// The values a select property will accept, in the order they should be offered. Empty for every
/// other type.
/// </param>
/// <param name="Required">Whether a write must supply a value.</param>
/// <param name="Expression">
/// For a <see cref="PropertyType.Formula"/>: the expression evaluated on read, without a leading
/// <c>=</c>. Null for every other type.
/// </param>
/// <param name="Aggregate">
/// For a <see cref="PropertyType.Rollup"/>: which reduction is folded across the children. Null for
/// every other type.
/// </param>
/// <param name="Source">
/// For a <see cref="PropertyType.Rollup"/>: the children's property key being folded, or null for a
/// count of the children themselves. Null for every other type.
/// </param>
/// <param name="Unique">
/// For a text or url field: no two direct children of the declaring collection may hold the same
/// canonical value. Scope is the declaring item's own children, not its descendants.
/// </param>
/// <remarks>
/// <para>
/// <b><see cref="Key"/> and <see cref="Label"/> are separate on purpose.</b> A property bag is keyed
/// by the stable identifier, so renaming "Status" to "Stage" is a label edit that leaves every
/// stored value where it was. Collapsing them would make a rename a data migration.
/// </para>
/// <para>
/// <b><see cref="Options"/> is not the board's column list.</b> The specification is explicit that
/// board columns are freely definable and not tied to a property's allowed values - a board may
/// show three of six statuses, or order them differently, and that is the view's business rather
/// than the schema's.
/// </para>
/// <para>
/// <b><see cref="Expression"/> is last and defaulted</b>, like every field added to a positional
/// record here since it was first cut: an argument inserted anywhere else would silently re-bind
/// the constructions that already exist rather than fail to compile.
/// </para>
/// </remarks>
public sealed record PropertyDefinition(
    string Key,
    string Label,
    PropertyType Type,
    ImmutableArray<string> Options,
    bool Required,
    string? Expression = null,
    RollupAggregate? Aggregate = null,
    string? Source = null,
    PropertyChoiceSource? ChoiceSource = null,
    bool Unique = false)
{
    /// <summary>Whether a value is declared or this field allows new choices.</summary>
    /// <param name="value">The value to look for.</param>
    /// <returns><see langword="true"/> when the value is declared or the source allows new values.</returns>
    public bool Allows(string value) => ChoiceSource is not null || Options.Contains(value, StringComparer.Ordinal);
}

/// <summary>Suggestions from direct children of a note. Null ItemId means the current container.</summary>
/// <param name="ItemId">The source note, or null for siblings.</param>
/// <param name="Field">A stored field key, or title for child titles.</param>
public sealed record PropertyChoiceSource(Guid? ItemId, string Field);
