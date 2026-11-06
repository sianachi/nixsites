using Nix.Domain.Items;

namespace Nix.Domain.Properties;

/// <summary>Pure storage rules shared by every schema-writing boundary.</summary>
public static class PropertySchemaRules
{
    /// <summary>Returns the first reason a schema cannot be stored, or null.</summary>
    public static string? Refuse(PropertySchema schema)
    {
        ArgumentNullException.ThrowIfNull(schema);

        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in schema.Properties)
        {
            if (property.Key.Length == 0)
            {
                return "Every property needs a key.";
            }

            // The '$' space belongs to the structural query fields ($type, $inside, ...), so a
            // property spelled that way could never be filtered on as itself.
            if (property.Key[0] == Nix.Domain.Views.QueryFields.Prefix)
            {
                return $"'{property.Key}' starts with '{Nix.Domain.Views.QueryFields.Prefix}', which is reserved for query fields such as $type; choose another key.";
            }

            if (!keys.Add(property.Key))
            {
                return $"'{property.Key}' is declared more than once; a property cannot mean two things.";
            }

            // A task type names a role, and the role's key is the role's name. A smart list that
            // means "the due date" is compiled cross-workspace against a key, so a workspace-chosen
            // key would leave 3.4 replacing one convention with another - and the storage
            // projection in the migration (item.due_day) can only be generated from a key that is
            // fixed. Label stays free; that is where a workspace calls it "Deadline". This rule
            // also makes "at most one property per task type" emergent rather than checked: a
            // second due_date would have to reuse the key, and the duplicate-key rule above has
            // already refused that.
            if (property.Type.IsTaskSemantic()
                && !string.Equals(property.Key, PropertyTypes.ToText(property.Type), StringComparison.Ordinal))
            {
                return $"A {PropertyTypes.ToText(property.Type)} property must use the key "
                    + $"'{PropertyTypes.ToText(property.Type)}'; '{property.Key}' is a different name "
                    + "for a role the whole workspace has to agree on. Rename the label instead.";
            }

            if (string.Equals(property.Key, ItemProperties.TitleKey, StringComparison.Ordinal))
            {
                return "'title' is managed by the item itself and cannot be redeclared.";
            }

            if (property.Unique && property.Type is not (PropertyType.Text or PropertyType.Url))
            {
                return $"'{property.Label}' cannot be unique: only text and url fields can.";
            }

            if (property.Type.HasOptions() && property.Options.IsEmpty && property.ChoiceSource is null)
            {
                return $"'{property.Label}' is a select and needs at least one option.";
            }

            if (!property.Type.HasOptions() && !property.Options.IsEmpty)
            {
                return $"'{property.Label}' is not a select, so it cannot carry options.";
            }

            if (property.ChoiceSource is { } choices
                && (property.Type is not (PropertyType.Text or PropertyType.Select or PropertyType.MultiSelect)
                    || string.IsNullOrWhiteSpace(choices.Field) || choices.Field.Length > 160
                    || choices.Field.StartsWith('$') || choices.ItemId == Guid.Empty))
            {
                return $"'{property.Label}' needs a text or choice type and a valid source field.";
            }

            if (property.Type == PropertyType.Formula)
            {
                if (string.IsNullOrWhiteSpace(property.Expression))
                {
                    return $"'{property.Label}' is a formula and needs an expression.";
                }

                if (property.Expression.Length > FormulaReferences.MaximumExpressionLength)
                {
                    return $"'{property.Label}' has an expression longer than "
                        + $"{FormulaReferences.MaximumExpressionLength} characters, which is more "
                        + "than a formula property will evaluate.";
                }
            }
            else if (property.Expression is not null)
            {
                // Cheap to ignore and expensive to police is ADR-0020's rule for a field a kind
                // does not use - but an expression is not inert decoration. A property carrying one
                // while typed as text would evaluate the moment somebody retyped it to a formula,
                // silently, with an expression nobody had looked at since.
                return $"'{property.Label}' is not a formula, so it cannot carry an expression.";
            }

            if (property.Type == PropertyType.Rollup)
            {
                if (property.Aggregate is not { } aggregate)
                {
                    return $"'{property.Label}' is a rollup and needs to say how it folds its "
                        + "children.";
                }

                if (property.Source is null && !aggregate.CountsChildren())
                {
                    return $"'{property.Label}' folds its children with "
                        + $"{RollupAggregates.ToText(aggregate)}, which needs a property to fold. "
                        + "Only a count can be taken of the children themselves.";
                }

                // A rollup reads the *children's* property of that name, not its own - but a
                // rollup keyed the same as what it folds is a declaration nobody can read, and on
                // a schema that cascades it is one the children inherit too, where it would then
                // fold itself. Refused as the confusion it is rather than resolved silently.
                if (string.Equals(property.Source, property.Key, StringComparison.Ordinal))
                {
                    return $"'{property.Label}' folds a property with its own key, which would "
                        + "fold itself in every item beneath this one. Give the rollup its own key.";
                }

                // Checked only when this schema declares the folded property itself, which is the
                // common case: a rollup folds the *children's* values, and a schema that cascades
                // is what the children carry. Where the source is declared further down it cannot
                // be checked here at all - the rules are pure and see one item's declaration - and
                // the fold then answers honestly for a value of the wrong kind rather than
                // guessing. What this catches is the case somebody can see themselves making.
                if (Find(schema, property.Source) is { } folded && !Fits(aggregate, folded.Type))
                {
                    return $"'{property.Label}' folds '{folded.Label}' with "
                        + $"{RollupAggregates.ToText(aggregate)}, which needs "
                        + (aggregate.IsNumeric() ? "a number." : "a checkbox.");
                }
            }
            else if (property.Aggregate is not null || property.Source is not null)
            {
                // The expression rule's argument, for the other computed type: a fold left on a
                // property retyped away from a rollup would start folding again the moment
                // somebody retyped it back, having been out of sight in between.
                return $"'{property.Label}' is not a rollup, so it cannot say how to fold children.";
            }

            // A computed property has no value to require: nothing writes one, so there is no
            // write for the requirement to be about.
            if (property.Type.IsComputed() && property.Required)
            {
                return $"'{property.Label}' is computed, so it cannot be required - "
                    + "nothing writes a value for it to be missing.";
            }
        }

        return RefuseCycle(schema);
    }

    /// <summary>The property a schema declares under a key, or null.</summary>
    private static PropertyDefinition? Find(PropertySchema schema, string? key)
    {
        if (key is null)
        {
            return null;
        }

        foreach (var property in schema.Properties)
        {
            if (string.Equals(property.Key, key, StringComparison.Ordinal))
            {
                return property;
            }
        }

        return null;
    }

    /// <summary>
    /// Whether a fold can reduce values of a type.
    /// </summary>
    /// <remarks>
    /// <b>A count fits anything</b>, because counting how many children carry a value asks nothing
    /// of the value. Everything else needs a shape: the four numeric reductions need a number, and
    /// any/all need a true-or-false. A sum over text answering zero forever is bad; an "all" over a
    /// select answering <em>true</em> - "everything is done" - is worse, and is what this refuses
    /// where it can see it.
    /// </remarks>
    private static bool Fits(RollupAggregate aggregate, PropertyType type)
    {
        if (aggregate == RollupAggregate.Count)
        {
            return true;
        }

        return aggregate.IsNumeric()
            ? type is PropertyType.Number or PropertyType.Priority or PropertyType.Estimate
            : type is PropertyType.Checkbox or PropertyType.Completion;
    }

    /// <summary>
    /// Returns the reason a schema's formulas refer in a circle, or null.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Checked over the properties this schema declares, which is not the whole graph.</b> An
    /// effective schema merges ancestors, so a formula here can read one declared three levels up
    /// and the pair could close a circle that neither declaration shows on its own. The engine
    /// catches that case where it evaluates - anything on or downstream of a cycle reads
    /// <c>#CYCLE!</c> - which is the layer that sees the merged set. Refusing here is what stops
    /// the mistake somebody can actually see themselves making, in the editor they are making it
    /// in, rather than leaving a schema that stores fine and reads as an error everywhere.
    /// </para>
    /// <para>
    /// The alternative - resolving ancestors before accepting a schema - would make storing a
    /// schema depend on where the item currently sits, so moving an item could retroactively
    /// invalidate a declaration it was allowed to make. These rules are pure and stay pure.
    /// </para>
    /// </remarks>
    private static string? RefuseCycle(PropertySchema schema)
    {
        // Only the formulas that survived the loop above, which means every one of them has an
        // expression - so this map is non-null-valued by construction rather than by inspection.
        Dictionary<string, string>? formulas = null;
        foreach (var property in schema.Properties)
        {
            if (property.Type == PropertyType.Formula && property.Expression is { } expression)
            {
                formulas ??= new Dictionary<string, string>(StringComparer.Ordinal);
                formulas[property.Key] = expression;
            }
        }

        if (formulas is null)
        {
            return null;
        }

        return FormulaReferences.FindCycle(formulas) is { } key
            ? $"'{key}' is a formula that refers back to itself, directly or through another formula."
            : null;
    }
}
