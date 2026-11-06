using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Nix.Domain.Properties;

/// <summary>
/// Reads and writes a <see cref="PropertySchema"/> as the JSON stored in <c>item.schema</c>.
/// </summary>
/// <remarks>
/// <para>
/// <b>This is the seam ADR-0006 rests on.</b> A schema is parsed out of the column here and is
/// never handled as raw JSON above it, so moving schemas into tables later changes where the bytes
/// come from and nothing else.
/// </para>
/// <para>
/// <b>Reading is total; writing is not.</b> A stored schema is data a person authored through an
/// endpoint that validated it - but it is also data that an older build may not fully understand,
/// and a schema that fails to parse must not make the items beneath it unreadable. So reading
/// drops what it cannot interpret and keeps the rest, and the endpoint that accepts a schema is
/// where malformed input is refused with something a person can act on.
/// </para>
/// <para>
/// The shape:
/// <code>
/// {
///   "inherit": true,
///   "properties": [
///     { "key": "status", "label": "Status", "type": "select",
///       "options": ["Todo", "Doing", "Done"], "required": false }
///   ]
/// }
/// </code>
/// </para>
/// </remarks>
public static class PropertySchemaJson
{
    private const string PropertiesKey = "properties";
    private const string InheritKey = "inherit";
    private const string KeyKey = "key";
    private const string LabelKey = "label";
    private const string TypeKey = "type";
    private const string OptionsKey = "options";
    private const string RequiredKey = "required";
    private const string ExpressionKey = "expression";
    private const string AggregateKey = "aggregate";
    private const string SourceKey = "source";

    /// <summary>
    /// Reads a stored schema.
    /// </summary>
    /// <param name="json">The stored JSON, or <see langword="null"/> when the item declares none.</param>
    /// <returns>The schema, or <see cref="PropertySchema.Empty"/> when there is nothing usable.</returns>
    /// <remarks>
    /// Never throws. A malformed schema resolves to an empty one, which means the items beneath it
    /// are validated against less rather than becoming unreadable - the same posture the title
    /// reader takes for the same reason.
    /// </remarks>
    public static PropertySchema Read(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return PropertySchema.Empty;
        }

        JsonNode? root;
        try
        {
            root = JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            return PropertySchema.Empty;
        }

        if (root is not JsonObject document)
        {
            return PropertySchema.Empty;
        }

        var inherit = document[InheritKey] is JsonValue value && value.TryGetValue(out bool flag)
            ? flag
            : true;

        if (document[PropertiesKey] is not JsonArray declared)
        {
            return new PropertySchema { Properties = [], Inherit = inherit };
        }

        var properties = ImmutableArray.CreateBuilder<PropertyDefinition>(declared.Count);
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var entry in declared)
        {
            var definition = ReadDefinition(entry);

            // A duplicate key is a schema that cannot mean two things at once. The first wins,
            // because the alternative is a property whose behaviour depends on array order in a
            // way nobody authored deliberately.
            if (definition is not null && seen.Add(definition.Key))
            {
                properties.Add(definition);
            }
        }

        return new PropertySchema { Properties = properties.ToImmutable(), Inherit = inherit };
    }

    /// <summary>
    /// Writes a schema for storage.
    /// </summary>
    /// <param name="schema">The schema.</param>
    /// <returns>The JSON to store.</returns>
    public static string Write(PropertySchema schema)
    {
        ArgumentNullException.ThrowIfNull(schema);

        var properties = new JsonArray();
        foreach (var property in schema.Properties)
        {
            var entry = new JsonObject
            {
                [KeyKey] = property.Key,
                [LabelKey] = property.Label,
                [TypeKey] = PropertyTypes.ToText(property.Type),
                [RequiredKey] = property.Required,
            };

            if (!property.Options.IsEmpty)
            {
                var options = new JsonArray();
                foreach (var option in property.Options)
                {
                    options.Add(option);
                }

                entry[OptionsKey] = options;
            }

            if (property.Expression is not null)
            {
                entry[ExpressionKey] = property.Expression;
            }

            if (property.Aggregate is { } aggregate)
            {
                entry[AggregateKey] = RollupAggregates.ToText(aggregate);
            }

            if (property.Source is not null)
            {
                entry[SourceKey] = property.Source;
            }

            if (property.ChoiceSource is { } choices)
            {
                entry["choiceSource"] = new JsonObject
                {
                    ["itemId"] = choices.ItemId?.ToString(),
                    ["field"] = choices.Field,
                };
            }

            if (property.Unique)
            {
                entry["unique"] = true;
            }

            properties.Add(entry);
        }

        var document = new JsonObject
        {
            [InheritKey] = schema.Inherit,
            [PropertiesKey] = properties,
        };

        return document.ToJsonString();
    }

    /// <summary>
    /// A stored schema without any <c>unique</c> flag, for copies (templates, captures): the flag
    /// is a promise about one collection's records, and a copy starts with none of them.
    /// </summary>
    /// <param name="json">The stored schema JSON.</param>
    /// <returns>The same JSON with every <c>unique</c> member removed.</returns>
    public static string? StripUnique(string? json)
    {
        if (string.IsNullOrWhiteSpace(json) || !json.Contains("\"unique\"", StringComparison.Ordinal))
        {
            return json;
        }

        try
        {
            if (JsonNode.Parse(json) is JsonObject { } document && document[PropertiesKey] is JsonArray declared)
            {
                foreach (var entry in declared.OfType<JsonObject>())
                {
                    entry.Remove("unique");
                }

                return document.ToJsonString();
            }
        }
        catch (JsonException)
        {
            // An unreadable schema carries no flag the reader would honour either.
        }

        return json;
    }

    private static PropertyDefinition? ReadDefinition(JsonNode? entry)
    {
        if (entry is not JsonObject property)
        {
            return null;
        }

        var key = ReadString(property[KeyKey]);
        if (key is null || key.Length == 0)
        {
            return null;
        }

        if (!PropertyTypes.TryParse(ReadString(property[TypeKey]), out var type))
        {
            // A type this build does not know is not a type. Dropped rather than guessed at, so an
            // older instance stops validating a property instead of inventing a rule for it.
            return null;
        }

        var options = ImmutableArray<string>.Empty;
        if (type.HasOptions() && property[OptionsKey] is JsonArray declared)
        {
            var builder = ImmutableArray.CreateBuilder<string>(declared.Count);
            foreach (var option in declared)
            {
                var text = ReadString(option);
                if (text is not null && !builder.Contains(text, StringComparer.Ordinal))
                {
                    builder.Add(text);
                }
            }

            options = builder.ToImmutable();
        }

        var required = property[RequiredKey] is JsonValue flag && flag.TryGetValue(out bool value) && value;

        // Only a formula carries one. Read for any other type it would be a field the writer's own
        // rules refuse, arriving through a hand-edited column, and keeping it would let a later
        // retype turn text nobody had read into a live expression.
        var expression = type == PropertyType.Formula ? ReadString(property[ExpressionKey]) : null;

        // A formula with no expression is not a formula. Dropped rather than kept as a property
        // that can only ever read as an error - the same posture as an unknown type above, and the
        // same reason: reading is total, and what cannot be interpreted is left out rather than
        // guessed at.
        if (type == PropertyType.Formula && string.IsNullOrWhiteSpace(expression))
        {
            return null;
        }

        RollupAggregate? aggregate = null;
        string? source = null;
        if (type == PropertyType.Rollup)
        {
            if (!RollupAggregates.TryParse(ReadString(property[AggregateKey]), out var parsed))
            {
                // A reduction this build does not know is not a reduction. Dropped rather than
                // guessed at, the same posture an unknown type takes and for the same reason: an
                // older instance stops showing a rollup instead of folding it a way nobody chose.
                return null;
            }

            aggregate = parsed;
            source = ReadString(property[SourceKey]);

            // Only a count can fold nothing. Anything else with no property to reduce is a
            // declaration that cannot mean anything, so it is left out rather than kept as a
            // property that can only ever read as empty.
            if (source is null && !parsed.CountsChildren())
            {
                return null;
            }
        }

        return new PropertyDefinition(
            key,
            ReadString(property[LabelKey]) ?? key,
            type,
            options,
            required,
            expression,
            aggregate,
            source,
            ReadChoiceSource(property["choiceSource"]),
            property["unique"] is JsonValue unique && unique.TryGetValue(out bool isUnique) && isUnique);
    }

    private static PropertyChoiceSource? ReadChoiceSource(JsonNode? node)
    {
        if (node is not JsonObject source || ReadString(source["field"]) is not { Length: > 0 } field)
        {
            return null;
        }

        var id = ReadString(source["itemId"]);
        if (id is not null && !Guid.TryParse(id, out _))
        {
            return null;
        }

        return new PropertyChoiceSource(id is null ? null : Guid.Parse(id), field);
    }

    private static string? ReadString(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue(out string? text) ? text : null;
}
