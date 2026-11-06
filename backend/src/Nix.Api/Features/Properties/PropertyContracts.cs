using System.Text.Json.Nodes;
using Nix.Domain.Properties;

namespace Nix.Features.Properties;

/// <summary>
/// One property a schema declares, as the API presents it.
/// </summary>
/// <param name="Key">The stable key the value is stored under.</param>
/// <param name="Label">What a person sees. The only part safe to rename.</param>
/// <param name="Type">
/// The stored name of a property type, as written by
/// <see cref="Nix.Domain.Properties.PropertyTypes.ToText(Nix.Domain.Properties.PropertyType)"/>.
/// <see cref="Nix.Domain.Properties.PropertyType"/> is where the types and their names are
/// declared.
/// </param>
/// <param name="Options">The values a select accepts, in offer order. Empty for other types.</param>
/// <param name="Required">Whether a write must supply a value.</param>
/// <param name="Expression">
/// For a formula property: the expression evaluated on read, without a leading <c>=</c>. Null for
/// every other type.
/// </param>
/// <param name="Aggregate">
/// For a rollup property: how the children are folded - the stored name of a
/// <see cref="Nix.Domain.Properties.RollupAggregate"/>. Null for every other type.
/// </param>
/// <param name="Source">
/// For a rollup property: the children's property key being folded, or null for a count of the
/// children themselves. Null for every other type.
/// </param>
/// <remarks>
/// <para>
/// <b>The expression is published and the value is not.</b> A formula property has no stored value
/// to send; a client evaluates the expression against the item's other properties wherever it draws
/// one. That is the whole of goal 2.1's "evaluated on read" seam, and it is why a client that meets
/// this field must not look for a matching entry in an item's property bag - there will never be
/// one, and a write attempting to add one is refused.
/// </para>
/// <para>
/// <see cref="Type"/> is an open string rather than an enumeration, for the same reason an item's
/// kind is: adding a property type should be a feature, not a breaking change to every generated
/// client. A client that meets a type it does not know should render the raw value rather than
/// fail to parse the schema.
/// </para>
/// <para>
/// The vocabulary itself is declared in <see cref="Nix.Domain.Properties.PropertyType"/> and is
/// deliberately not repeated here: a prose copy of a set declared elsewhere has no way of being
/// told the set changed.
/// </para>
/// </remarks>
internal sealed record PropertyDefinitionResponse(
    string Key,
    string Label,
    string Type,
    IReadOnlyList<string> Options,
    bool Required,
    string? Expression,
    string? Aggregate,
    string? Source,
    PropertyChoiceSource? ChoiceSource = null,
    bool? Unique = null);

/// <summary>
/// The property schema in force at an item.
/// </summary>
/// <param name="Properties">Every ancestor's declaration merged, nearest winning.</param>
/// <param name="Declared">
/// What this item declares itself, which is the subset an editor may change here.
/// </param>
/// <param name="Inherit">Whether ancestors above this item contribute.</param>
/// <remarks>
/// <b>Both lists are returned, and the difference matters.</b> An editor showing only the merged
/// result would save every inherited property back onto the item, silently converting inheritance
/// into a copy - after which changing the parent's schema would stop reaching the child.
/// </remarks>
internal sealed record EffectiveSchemaResponse(
    IReadOnlyList<PropertyDefinitionResponse> Properties,
    IReadOnlyList<PropertyDefinitionResponse> Declared,
    bool Inherit);

/// <summary>
/// Replaces the schema an item declares for its subtree.
/// </summary>
/// <param name="Properties">The properties to declare. An empty list declares none.</param>
/// <param name="Inherit">
/// Whether ancestors above this item contribute. False makes this the outermost schema its subtree
/// sees, which is what a scratch item under a heavily-schema'd workspace needs.
/// </param>
internal sealed record SetSchemaRequest(
    IReadOnlyList<PropertyDefinitionRequest> Properties,
    bool Inherit);

/// <summary>One property being declared.</summary>
/// <param name="Key">The stable key.</param>
/// <param name="Label">What a person sees.</param>
/// <param name="Type">
/// The stored name of a property type, read by
/// <see cref="Nix.Domain.Properties.PropertyTypes.TryParse(string, out Nix.Domain.Properties.PropertyType)"/>.
/// A name this build does not know is refused rather than guessed at.
/// </param>
/// <param name="Options">The values a select accepts.</param>
/// <param name="Required">Whether a write must supply a value.</param>
/// <param name="Expression">
/// For a formula property: the expression to evaluate on read, without a leading <c>=</c>. Refused
/// on any other type, and refused when a formula omits it.
/// </param>
/// <param name="Aggregate">
/// For a rollup property: how to fold the children. Refused on any other type, refused when a
/// rollup omits it, and refused when the name is not one this build knows.
/// </param>
/// <param name="Source">
/// For a rollup property: the children's property key to fold. Optional only for a count, which can
/// be taken of the children themselves.
/// </param>
internal sealed record PropertyDefinitionRequest(
    string Key,
    string Label,
    string Type,
    IReadOnlyList<string>? Options,
    bool Required,
    string? Expression = null,
    string? Aggregate = null,
    string? Source = null,
    PropertyChoiceSource? ChoiceSource = null,
    bool? Unique = null);

/// <summary>
/// Writes property values onto an item.
/// </summary>
/// <param name="Properties">
/// The properties to set. A member set to null clears that property; anything not mentioned is
/// left alone.
/// </param>
/// <remarks>
/// <b>A merge, not a replacement.</b> A board dragging a card between columns sends one property;
/// replacing the bag would drop every other property the item carries, which is most of them.
/// </remarks>
internal sealed record SetPropertiesRequest(JsonObject Properties, bool? Strict = null);
