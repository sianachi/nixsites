using System.Text.Json;

namespace Nix.Workers.Import;

/// <summary>The template plan's JSON, written byte for byte as Go wrote it and read with Go's strict decoders.</summary>
internal static class TemplateJson
{
    public static byte[] Write(TemplatePlan plan)
    {
        var writer = new GoJsonWriter();
        writer.Begin()
            .Name("version").Number(plan.Version)
            .Name("sourceSha256").String(plan.SourceSha256)
            .Name("profile");
        WriteProfile(writer, plan.Profile);
        writer.Name("rootItemType").String(plan.RootItemType)
            .Name("itemCount").Number(plan.ItemCount)
            .Name("bodyCount").Number(plan.BodyCount)
            .Name("viewCount").Number(plan.ViewCount)
            .Name("items").BeginArray();
        foreach (var item in plan.Items)
        {
            writer.Begin()
                .Name("sourceId").String(item.SourceId)
                .Name("parentSourceId").String(item.ParentSourceId)
                .Name("seq").String(item.Seq)
                .Name("title").String(item.Title)
                .Name("itemType").String(item.ItemType)
                .Name("properties").Raw(item.Properties)
                .Name("schema").Raw(item.Schema)
                .Name("views").Raw(item.Views)
                .Name("body").Raw(item.Body);
            PlanJson.OptionalRaw(writer, "recurrence", item.Recurrence);
            writer.End();
        }
        writer.EndArray();
        if (plan.Files is { Count: > 0 })
        {
            writer.Name("files");
            PlanJson.WriteFileVersions(writer, plan.Files);
        }
        writer.End();
        return writer.ToUtf8();
    }

    private static void WriteProfile(GoJsonWriter writer, TemplateProfile profile)
    {
        writer.Begin()
            .Name("kind").String(profile.Kind)
            .Name("version").Number(profile.Version)
            .Name("key").String(profile.Key)
            .Name("name").String(profile.Name)
            .Name("description").String(profile.Description)
            .Name("includeBody").Bool(profile.IncludeBody)
            .Name("includeChildren").Bool(profile.IncludeChildren);
        if (profile.Initialization is { } initialization)
        {
            writer.Name("initialization").Begin().Name("version").Number(initialization.Version).Name("inputs");
            WriteList(writer, initialization.Inputs, input =>
            {
                writer.Begin().Name("key").String(input.Key).Name("label").String(input.Label).Name("type").String(input.Type).Name("required").Bool(input.Required);
                if (input.DefaultValue is not null)
                {
                    writer.Name("defaultValue").String(input.DefaultValue);
                }
                writer.End();
            });
            writer.Name("rules");
            WriteList(writer, initialization.Rules, rule =>
            {
                writer.Begin().Name("sourceId").String(rule.SourceId).Name("propertyKey").String(rule.PropertyKey).Name("kind").String(rule.Kind);
                PlanJson.OptionalRaw(writer, "value", rule.Value);
                if (rule.InputKey is not null)
                {
                    writer.Name("inputKey").String(rule.InputKey);
                }
                if (rule.OffsetDays is { } offset)
                {
                    writer.Name("offsetDays").Number(offset);
                }
                if (rule.TimeOfDay is not null)
                {
                    writer.Name("timeOfDay").String(rule.TimeOfDay);
                }
                if (rule.TimeZone is not null)
                {
                    writer.Name("timeZone").String(rule.TimeZone);
                }
                writer.End();
            });
            writer.Name("references");
            WriteList(writer, initialization.References, reference =>
            {
                writer.Begin().Name("sourceItemId").String(reference.SourceItemId).Name("policy").String(reference.Policy);
                if (reference.InputKey is not null)
                {
                    writer.Name("inputKey").String(reference.InputKey);
                }
                writer.End();
            });
            writer.End();
        }
        writer.End();
    }

    private static void WriteList<T>(GoJsonWriter writer, IList<T>? values, Action<T> write)
    {
        if (values is null)
        {
            writer.Null();
            return;
        }
        writer.BeginArray();
        foreach (var value in values)
        {
            write(value);
        }
        writer.EndArray();
    }

    public static TemplatePlan ReadPlan(JsonElement root)
    {
        var fields = GoFields.Require(root, true, "version", "sourceSha256", "profile", "rootItemType", "itemCount", "bodyCount", "viewCount", "items", "files");
        return new TemplatePlan
        {
            Version = fields.Int("version"),
            SourceSha256 = fields.String("sourceSha256"),
            // Go's TemplateProfile.UnmarshalJSON ran on a JSON null too, and refused it as incomplete.
            Profile = fields.Has("profile") ? ReadProfile(fields.Raw("profile")!.Value) : new TemplateProfile(),
            RootItemType = fields.String("rootItemType"),
            ItemCount = fields.Int("itemCount"),
            BodyCount = fields.Int("bodyCount"),
            ViewCount = fields.Int("viewCount"),
            Items = fields.List("items", element =>
            {
                var item = GoFields.Require(element, true, "sourceId", "parentSourceId", "seq", "title", "itemType", "properties", "schema", "views", "body", "recurrence");
                return new TemplateItem
                {
                    SourceId = item.String("sourceId"),
                    ParentSourceId = item.OptionalString("parentSourceId"),
                    Seq = item.String("seq"),
                    Title = item.String("title"),
                    ItemType = item.String("itemType"),
                    Properties = item.Raw("properties"),
                    Schema = item.Raw("schema"),
                    Views = item.Raw("views"),
                    Body = item.Raw("body"),
                    Recurrence = item.Raw("recurrence"),
                };
            }) ?? [],
            Files = fields.List("files", PlanJson.ReadFileVersion),
        };
    }

    /// <summary>The profile's strict decode: no unknown member, and every selection present and non-null.</summary>
    public static TemplateProfile ReadProfile(JsonElement element)
    {
        var fields = GoFields.Require(element, true, "kind", "version", "key", "name", "description", "includeBody", "includeChildren", "initialization");
        var kind = fields.OptionalString("kind");
        var version = fields.OptionalInt("version");
        var key = fields.OptionalString("key");
        var name = fields.OptionalString("name");
        var description = fields.OptionalString("description");
        var includeBody = fields.OptionalBool("includeBody");
        var includeChildren = fields.OptionalBool("includeChildren");
        var initialization = fields.TryGet("initialization", out var value) ? ReadInitialization(value) : null;
        if (kind is null || version is null || key is null || name is null || description is null || includeBody is null || includeChildren is null)
        {
            throw new JsonException("the template profile is incomplete");
        }
        return new TemplateProfile
        {
            Kind = kind,
            Version = version.Value,
            Key = key,
            Name = name,
            Description = description,
            IncludeBody = includeBody.Value,
            IncludeChildren = includeChildren.Value,
            Initialization = initialization,
        };
    }

    public static TemplateInitialization ReadInitialization(JsonElement element)
    {
        var fields = GoFields.Require(element, true, "version", "inputs", "rules", "references");
        return new TemplateInitialization
        {
            Version = fields.Int("version"),
            Inputs = fields.List("inputs", input =>
            {
                var values = GoFields.Require(input, true, "key", "label", "type", "required", "defaultValue");
                var key = values.OptionalString("key");
                var label = values.OptionalString("label");
                var type = values.OptionalString("type");
                var required = values.OptionalBool("required");
                if (key is null || label is null || type is null || required is null)
                {
                    throw new JsonException("template initialization input is missing a required field");
                }
                return new TemplateInitializationInput { Key = key, Label = label, Type = type, Required = required.Value, DefaultValue = values.OptionalString("defaultValue") };
            }),
            Rules = fields.List("rules", rule =>
            {
                var values = GoFields.Require(rule, true, "sourceId", "propertyKey", "kind", "value", "inputKey", "offsetDays", "timeOfDay", "timeZone");
                return new TemplateInitializationRule
                {
                    SourceId = values.String("sourceId"),
                    PropertyKey = values.String("propertyKey"),
                    Kind = values.String("kind"),
                    Value = values.Raw("value"),
                    InputKey = values.OptionalString("inputKey"),
                    OffsetDays = values.OptionalInt("offsetDays"),
                    TimeOfDay = values.OptionalString("timeOfDay"),
                    TimeZone = values.OptionalString("timeZone"),
                };
            }),
            References = fields.List("references", reference =>
            {
                var values = GoFields.Require(reference, true, "sourceItemId", "policy", "inputKey");
                return new TemplateReferenceRule { SourceItemId = values.String("sourceItemId"), Policy = values.String("policy"), InputKey = values.OptionalString("inputKey") };
            }),
        };
    }
}
