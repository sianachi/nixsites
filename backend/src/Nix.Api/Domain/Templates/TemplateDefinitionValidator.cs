using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Recurrence;
using Nix.Domain.Views;

namespace Nix.Domain.Templates;

/// <summary>Validates portable and stored template envelopes without performing I/O.</summary>
public sealed class TemplateDefinitionValidator
{
    private const int MaximumTemplateItems = 200;
    private const int MaximumTemplateDepth = 32;
    private static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);

    public string? ValidateTemplateTree(IReadOnlyList<Item> items, bool tolerateViewDrift = false)
    {
        ArgumentNullException.ThrowIfNull(items);

        var effectiveByItem = new Dictionary<ItemId, PropertySchema>(items.Count);
        foreach (var item in items)
        {
            var declared = PropertySchemaJson.Read(item.Schema);
            var effective = item.ParentId is { } parentId && declared.Inherit
                ? PropertySchema.Merge(effectiveByItem[parentId], declared)
                : declared;
            effectiveByItem[item.Id] = effective;
            if (ValidateEnvelope(item.Properties, item.Schema, item.Views, effective, tolerateViewDrift)
                is { } refusal)
            {
                return $"Template item '{ItemProperties.ReadTitle(item.Properties)}' is invalid: {refusal}";
            }
        }

        return null;
    }

    public string? ValidateEnvelope(
        string? properties,
        string? schema,
        string? views,
        PropertySchema? effectiveSchema = null,
        bool tolerateViewDrift = false)
    {
        var parsedSchema = effectiveSchema;
        StoredViews? parsedViews = null;
        if (properties is not null)
        {
            if (Encoding.UTF8.GetByteCount(properties) > PropertyValidator.MaximumBytes)
            {
                return $"An item property bag may be at most {PropertyValidator.MaximumBytes} bytes.";
            }

            try
            {
                if (JsonNode.Parse(properties) is not JsonObject bag)
                {
                    return "Item properties must be a JSON object.";
                }

                // Counting the members refuses duplicate names (ArgumentException, handled below).
                _ = bag.Count;
            }
            catch (JsonException)
            {
                return "Item properties are not valid JSON.";
            }
            catch (ArgumentException)
            {
                // JsonNode.Parse accepts a member named twice and the object throws on first use.
                return "Item properties name the same property more than once.";
            }
        }

        if (schema is not null)
        {
            if (Encoding.UTF8.GetByteCount(schema) > PropertyValidator.MaximumBytes)
            {
                return $"A property schema may be at most {PropertyValidator.MaximumBytes} bytes.";
            }

            try
            {
                if (JsonNode.Parse(schema) is not JsonObject document
                    || document["properties"] is not JsonArray propertiesArray)
                {
                    return "A property schema must contain a properties array.";
                }

                if (document["inherit"] is { } inheritNode && !IsBoolean(inheritNode))
                {
                    return "A property schema's inherit value must be true or false.";
                }

                var keys = new HashSet<string>(StringComparer.Ordinal);
                foreach (var entry in propertiesArray)
                {
                    if (entry is not JsonObject property
                        || ReadString(property["key"]) is not { } key
                        || ReadString(property["type"]) is not { } type)
                    {
                        return "Every property definition needs string key and type values.";
                    }

                    if (!PropertyTypes.TryParse(type, out _))
                    {
                        return $"This template uses property type '{type}', which this build does not support.";
                    }

                    if (!keys.Add(key))
                    {
                        return $"'{key}' is declared more than once; a property cannot mean two things.";
                    }

                    if (property["label"] is { } label && ReadString(label) is null)
                    {
                        return $"Property '{key}' has a label that is not text.";
                    }

                    if (property["required"] is { } required && !IsBoolean(required))
                    {
                        return $"Property '{key}' has a required value that is not true or false.";
                    }

                    if (property["options"] is { } optionsNode
                        && (optionsNode is not JsonArray options || options.Any(option => ReadString(option) is null)))
                    {
                        return $"Property '{key}' has malformed options.";
                    }
                }

                var typedSchema = PropertySchemaJson.Read(schema);
                if (typedSchema.Properties.Length != propertiesArray.Count)
                {
                    return "The property schema contains a definition this build cannot read.";
                }

                if (PropertySchemaRules.Refuse(typedSchema) is { } schemaReason)
                {
                    return schemaReason;
                }

                parsedSchema ??= typedSchema;
            }
            catch (JsonException)
            {
                return "The property schema is not valid JSON.";
            }
        }

        if (views is not null)
        {
            if (Encoding.UTF8.GetByteCount(views) > ViewDefinitionsJson.MaximumBytes)
            {
                return $"A view set may be at most {ViewDefinitionsJson.MaximumBytes} bytes.";
            }

            try
            {
                if (JsonNode.Parse(views) is not JsonObject document
                    || document["views"] is not JsonArray viewArray
                    || viewArray.Count > ViewDefinitionsJson.MaximumViews)
                {
                    return $"A view set must contain at most {ViewDefinitionsJson.MaximumViews} views.";
                }

                var ids = new HashSet<string>(StringComparer.Ordinal);
                foreach (var entry in viewArray)
                {
                    if (entry is not JsonObject view
                        || ReadString(view["id"]) is not { } id
                        || ReadString(view["kind"]) is not { } kind)
                    {
                        return "Every view needs string id and kind values.";
                    }

                    if (!ViewKinds.TryParse(kind, out _))
                    {
                        return $"This template uses view kind '{kind}', which this build does not support.";
                    }

                    if (!ids.Add(id))
                    {
                        return $"'{id}' is used by more than one view; a shared link names one view.";
                    }

                    if (view["name"] is { } name && ReadString(name) is null)
                    {
                        return $"View '{id}' has a name that is not text.";
                    }

                    if (view["sortDescending"] is { } descending && !IsBoolean(descending))
                    {
                        return $"View '{id}' has a sort direction that is not true or false.";
                    }

                    foreach (var key in ViewStringKeys)
                    {
                        if (view[key] is { } value && ReadString(value) is null)
                        {
                            return $"View '{id}' has a malformed '{key}' value.";
                        }
                    }

                    foreach (var key in ViewStringArrayKeys)
                    {
                        if (view[key] is { } valuesNode
                            && (valuesNode is not JsonArray values
                                || values.Any(value => ReadString(value) is null)))
                        {
                            return $"View '{id}' has a malformed '{key}' value.";
                        }
                    }

                    if (view["filters"] is { } filtersNode
                        && (filtersNode is not JsonArray filters || filters.Any(InvalidFilter)))
                    {
                        return $"View '{id}' has a malformed filter.";
                    }

                    if (view["interactiveForm"] is { } formNode && !CanReadInteractiveForm(formNode))
                    {
                        return $"View '{id}' has malformed interactive-form configuration.";
                    }
                }

                if (document["default"] is { } defaultNode && ReadString(defaultNode) is null)
                {
                    return "A view set's default value must be text.";
                }

                var typedViews = ViewDefinitionsJson.Read(views);
                if (typedViews.Views.Length != viewArray.Count)
                {
                    return "The view set contains a definition this build cannot read.";
                }

                if (ViewDefinitionRules.Refuse(typedViews.Views, typedViews.Default) is { } viewReason)
                {
                    return viewReason;
                }

                if (ViewDefinitionRules.RefuseDocumentVisibility(
                        typedViews.Views,
                        typedViews.Default,
                        typedViews.HideDocument) is { } visibilityReason)
                {
                    return visibilityReason;
                }

                parsedViews = typedViews;
            }
            catch (JsonException)
            {
                return "The view set is not valid JSON.";
            }
        }

        if (parsedViews is not null
            && ValidateViewDependencies(parsedSchema ?? PropertySchema.Empty, parsedViews, tolerateViewDrift)
                is { } dependencyReason)
        {
            return dependencyReason;
        }

        return null;
    }

    public string? ValidateViewDependencies(
        PropertySchema schema,
        StoredViews stored,
        bool tolerateDrift = false)
    {
        ArgumentNullException.ThrowIfNull(schema);
        ArgumentNullException.ThrowIfNull(stored);

        // Match the live product for content that came from inside the workspace. SetContainerViews
        // stores any structurally-valid view set - the structural rules are ViewDefinitionRules,
        // enforced by every caller before this - and the read path reports a view whose configured
        // property is missing or mistyped as *unrenderable* rather than refusing it (see
        // ViewDefinition.CanRender and GetContainerViewsHandler). A template captured from, or
        // applied to, a working container must therefore accept exactly what that container holds;
        // a dangling column that renders as nothing live cannot be what blocks saving it as a
        // template. Import stays strict, because its content is external and unvetted.
        if (tolerateDrift)
        {
            return null;
        }

        foreach (var view in stored.Views)
        {
            foreach (var column in view.Columns)
            {
                if (!string.Equals(column, "title", StringComparison.Ordinal)
                    && schema.Find(column) is null)
                {
                    return $"View '{view.Name}' uses column '{column}', which its schema does not declare.";
                }
            }

            // A list's sections and a matrix's axes take the wider section predicate, and a list
            // may also section by `$type`, which names each item's body kind rather than a property.
            var sections = view.Kind is ViewKind.List or ViewKind.Matrix;
            if (view.GroupBy is { } groupBy
                && !(view.Kind == ViewKind.List && string.Equals(groupBy, "$type", StringComparison.Ordinal))
                && (schema.Find(groupBy) is not { } grouping
                    || !(view.Kind == ViewKind.Chart ? grouping.Type.CanChartBy()
                        : sections ? grouping.Type.CanSectionBy() : grouping.Type.CanGroupBy())))
            {
                return sections
                    ? $"View '{view.Name}' groups by '{groupBy}', which must be a declared select or checkbox property."
                    : $"View '{view.Name}' groups by '{groupBy}', which must be a declared single-select property.";
            }

            if (view.RowBy is { } rowBy
                && (schema.Find(rowBy) is not { } rows || !rows.Type.CanSectionBy()))
            {
                return $"View '{view.Name}' lays out rows by '{rowBy}', which must be a declared select or checkbox property.";
            }

            if (view.DateProperty is { } dateProperty
                && (schema.Find(dateProperty) is not { } date || !date.Type.CanPlaceOnCalendar()))
            {
                return $"View '{view.Name}' uses '{dateProperty}' as a date, which must be a declared date or timestamp property.";
            }

            if (view.EndDateProperty is { } endDateProperty
                && (schema.Find(endDateProperty) is not { } endDate || !endDate.Type.CanPlaceOnCalendar()))
            {
                return $"View '{view.Name}' uses '{endDateProperty}' as an end date, which must be a declared date or timestamp property.";
            }

            if (view.CoverProperty is { } coverProperty
                && schema.Find(coverProperty)?.Type != PropertyType.Image)
            {
                return $"View '{view.Name}' uses '{coverProperty}' as a cover, which must be a declared image property.";
            }

            if (view.SortBy is { } sortBy
                && !string.Equals(sortBy, "title", StringComparison.Ordinal)
                && schema.Find(sortBy) is null)
            {
                return $"View '{view.Name}' sorts by '{sortBy}', which its schema does not declare.";
            }

            foreach (var filter in view.Filters)
            {
                // A template's views are checked against its own schema, and neither an "any of"
                // group nor a structural query field is a property that schema can declare.
                if (filter.IsGroup)
                {
                    return $"View '{view.Name}' uses an \"any of\" filter group, which a template cannot store.";
                }

                if (QueryFields.IsReserved(filter.Property))
                {
                    return $"View '{view.Name}' filters by '{filter.Property}', a query field a template cannot store.";
                }

                var isTitle = string.Equals(filter.Property, "title", StringComparison.Ordinal);
                var property = schema.Find(filter.Property);
                if (property is null && !isTitle)
                {
                    return $"View '{view.Name}' filters by '{filter.Property}', which its schema does not declare.";
                }

                if ((QueryOperators.ReadsDay(filter.Operator)
                        || string.Equals(filter.Operator, QueryOperators.WithinNext, StringComparison.Ordinal))
                    && (property is null || !property.Type.CanPlaceOnCalendar()))
                {
                    return $"View '{view.Name}' uses a date filter on '{filter.Property}', which must be a date or timestamp property.";
                }
            }

            if (view.InteractiveForm is not { } form)
            {
                continue;
            }

            foreach (var block in form.Pages.SelectMany(page => page.Blocks).Where(block => block.Kind == "field"))
            {
                var property = block.PropertyKey is { } propertyKey ? schema.Find(propertyKey) : null;
                if (property is null)
                {
                    return $"View '{view.Name}' form field '{block.Id}' names a property its schema does not declare.";
                }

                if (block.IdentityRole is not null && property.Type != PropertyType.Text)
                {
                    return $"View '{view.Name}' form field '{block.Id}' assigns respondent identity to a non-text property.";
                }
            }
        }

        return null;
    }

    private static readonly string[] ViewStringKeys =
    [
        "name", "groupBy", "dateProperty", "endDateProperty", "coverProperty", "cardSize",
        "mode", "sortBy", "companionViewId", "companionPlacement", "open",
    ];

    private static readonly string[] ViewStringArrayKeys = ["columns", "groupOrder"];

    private static string? ReadString(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue(out string? text) ? text : null;

    private static bool IsBoolean(JsonNode node) =>
        node is JsonValue value && value.TryGetValue(out bool _);

    private static bool InvalidFilter(JsonNode? node) =>
        node is not JsonObject rule
        || ReadString(rule["property"]) is null
        || ReadString(rule["operator"]) is null
        || ReadString(rule["value"]) is null;

    private static bool CanReadInteractiveForm(JsonNode node)
    {
        try
        {
            return node.Deserialize<InteractiveFormDefinition>(WebJson) is not null;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    public string? ValidateImport(
        TemplateImportDescriptor descriptor,
        IReadOnlyList<TemplateImportItem> items)
    {
        ArgumentNullException.ThrowIfNull(descriptor);
        ArgumentNullException.ThrowIfNull(items);

        if (!IsPortableTemplateKey(descriptor.StableKey))
        {
            return "A template profile key must use 1 to 160 lowercase letters, digits, dots, underscores, or hyphens, and start and end with a letter or digit.";
        }

        if (string.IsNullOrWhiteSpace(descriptor.Title) || descriptor.Title.Length > 200)
        {
            return "A template title must be between 1 and 200 characters.";
        }

        if (descriptor.Description is { Length: > 1000 } || !IsSha256Digest(descriptor.Digest))
        {
            return "The template description or lowercase SHA-256 digest is invalid.";
        }

        if (descriptor.Origin == TemplateOrigin.Managed
            && (string.IsNullOrWhiteSpace(descriptor.ManagedSource) || descriptor.ManagedSource.Length > 500))
        {
            return "A managed template needs a managed source of at most 500 characters.";
        }

        if (descriptor.Origin == TemplateOrigin.User && descriptor.ManagedSource is not null)
        {
            return "A user-imported template cannot declare a managed source.";
        }

        if (descriptor.Origin is not (TemplateOrigin.User or TemplateOrigin.Managed))
        {
            return "Only user and managed template profiles may be imported.";
        }

        if (items.Count == 0 || items.Count > MaximumTemplateItems || items.Count(item => item.ParentSourceId is null) != 1)
        {
            return $"A template needs one root and at most {MaximumTemplateItems:N0} items.";
        }

        var seen = new HashSet<Guid>();
        var depths = new Dictionary<Guid, int>();
        var effectiveSchemas = new Dictionary<Guid, PropertySchema>();
        foreach (var item in items)
        {
            if (item.SourceId == Guid.Empty || !seen.Add(item.SourceId))
            {
                return "Every template item needs a unique non-empty source identifier.";
            }

            if (item.ParentSourceId is { } parent && !seen.Contains(parent))
            {
                return "Template items must be parent-first and may reference only an earlier parent.";
            }


            var depth = item.ParentSourceId is { } parentSource ? depths[parentSource] + 1 : 0;
            if (depth > MaximumTemplateDepth)
            {
                return $"A template may be at most {MaximumTemplateDepth} levels deep.";
            }

            depths[item.SourceId] = depth;

            if (string.IsNullOrWhiteSpace(item.ItemType) || item.ItemType.Length > 64)
            {
                return "Every template item needs a body type of at most 64 characters.";
            }

            var declaredSchema = PropertySchemaJson.Read(item.Schema);
            var effectiveSchema = item.ParentSourceId is { } schemaParent && declaredSchema.Inherit
                ? PropertySchema.Merge(effectiveSchemas[schemaParent], declaredSchema)
                : declaredSchema;
            effectiveSchemas[item.SourceId] = effectiveSchema;
            if (ValidateEnvelope(
                    item.Properties,
                    item.Schema,
                    item.Views,
                    effectiveSchema) is { } refusal)
            {
                return refusal;
            }

            if (item.Recurrence is not null
                && (RecurrenceRuleJson.Read(item.Recurrence) is null
                    || !RecurrenceRuleJson.IsWithinBounds(item.Recurrence)))
            {
                return $"Template item '{item.SourceId}' has an invalid recurrence rule.";
            }
        }

        if (descriptor.Initialization is { } initialization
            && TemplateInitializationValidator.Validate(initialization, seen) is { } initializationRefusal)
        {
            return initializationRefusal;
        }

        return null;
    }

    private static bool IsPortableTemplateKey(string value)
    {
        if (value.Length is < 1 or > 160 || !IsLowerLetterOrDigit(value[0])
            || !IsLowerLetterOrDigit(value[^1]))
        {
            return false;
        }

        foreach (var character in value)
        {
            if (!IsLowerLetterOrDigit(character) && character is not ('.' or '_' or '-'))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsLowerLetterOrDigit(char value) =>
        value is >= 'a' and <= 'z' or >= '0' and <= '9';

    private static bool IsSha256Digest(string value)
    {
        if (value.Length != 64)
        {
            return false;
        }

        foreach (var character in value)
        {
            if (character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))
            {
                return false;
            }
        }

        return true;
    }

    public int Depth(IReadOnlyList<Item> items, ItemId rootId)
    {
        ArgumentNullException.ThrowIfNull(items);

        var depthById = new Dictionary<ItemId, int> { [rootId] = 0 };
        var maximum = 0;
        foreach (var item in items)
        {
            if (item.Id == rootId)
            {
                continue;
            }

            var depth = depthById[item.ParentId!.Value] + 1;
            depthById[item.Id] = depth;
            maximum = Math.Max(maximum, depth);
        }

        return maximum;
    }

}
