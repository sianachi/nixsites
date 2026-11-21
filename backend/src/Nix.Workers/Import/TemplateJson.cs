using System.Text.Json;

namespace Nix.Workers.Import;

/// <summary>The template plan's JSON: written in a fixed order, read strictly.</summary>
internal static class TemplateJson
{
    public static byte[] Write(TemplatePlan plan) => WorkerJson.Write(writer =>
    {
        writer.WriteStartObject();
        writer.WriteNumber("version", plan.Version);
        writer.WriteString("sourceSha256", plan.SourceSha256);
        WriteProfile(writer, plan.Profile);
        writer.WriteString("rootItemType", plan.RootItemType);
        writer.WriteNumber("itemCount", plan.ItemCount);
        writer.WriteNumber("bodyCount", plan.BodyCount);
        writer.WriteNumber("viewCount", plan.ViewCount);
        writer.WriteStartArray("items");
        foreach (var item in plan.Items)
        {
            writer.WriteStartObject();
            writer.WriteString("sourceId", item.SourceId);
            writer.WriteString("parentSourceId", item.ParentSourceId);
            writer.WriteString("seq", item.Seq);
            writer.WriteString("title", item.Title);
            writer.WriteString("itemType", item.ItemType);
            WorkerJson.WriteRaw(writer, "properties", item.Properties);
            WorkerJson.WriteRaw(writer, "schema", item.Schema);
            WorkerJson.WriteRaw(writer, "views", item.Views);
            WorkerJson.WriteRaw(writer, "body", item.Body);
            WorkerJson.WriteOptionalRaw(writer, "recurrence", item.Recurrence);
            writer.WriteEndObject();
        }
        writer.WriteEndArray();
        if (plan.Files is { Count: > 0 })
        {
            PlanJson.WriteFileVersions(writer, "files", plan.Files);
        }
        writer.WriteEndObject();
    });

    private static void WriteProfile(Utf8JsonWriter writer, TemplateProfile profile)
    {
        writer.WriteStartObject("profile");
        writer.WriteString("kind", profile.Kind);
        writer.WriteNumber("version", profile.Version);
        writer.WriteString("key", profile.Key);
        writer.WriteString("name", profile.Name);
        writer.WriteString("description", profile.Description);
        writer.WriteBoolean("includeBody", profile.IncludeBody);
        writer.WriteBoolean("includeChildren", profile.IncludeChildren);
        if (profile.Initialization is { } initialization)
        {
            writer.WriteStartObject("initialization");
            writer.WriteNumber("version", initialization.Version);
            WriteList(writer, "inputs", initialization.Inputs, input =>
            {
                writer.WriteString("key", input.Key);
                writer.WriteString("label", input.Label);
                writer.WriteString("type", input.Type);
                writer.WriteBoolean("required", input.Required);
                WriteOptionalString(writer, "defaultValue", input.DefaultValue);
            });
            WriteList(writer, "rules", initialization.Rules, rule =>
            {
                writer.WriteString("sourceId", rule.SourceId);
                writer.WriteString("propertyKey", rule.PropertyKey);
                writer.WriteString("kind", rule.Kind);
                WorkerJson.WriteOptionalRaw(writer, "value", rule.Value);
                WriteOptionalString(writer, "inputKey", rule.InputKey);
                if (rule.OffsetDays is { } offset)
                {
                    writer.WriteNumber("offsetDays", offset);
                }
                WriteOptionalString(writer, "timeOfDay", rule.TimeOfDay);
                WriteOptionalString(writer, "timeZone", rule.TimeZone);
            });
            WriteList(writer, "references", initialization.References, reference =>
            {
                writer.WriteString("sourceItemId", reference.SourceItemId);
                writer.WriteString("policy", reference.Policy);
                WriteOptionalString(writer, "inputKey", reference.InputKey);
            });
            writer.WriteEndObject();
        }
        writer.WriteEndObject();
    }

    private static void WriteOptionalString(Utf8JsonWriter writer, string name, string? value)
    {
        if (value is not null)
        {
            writer.WriteString(name, value);
        }
    }

    /// <summary>A list of objects under <paramref name="name"/>, or null when there is no list.</summary>
    private static void WriteList<T>(Utf8JsonWriter writer, string name, IList<T>? values, Action<T> writeMembers)
    {
        if (values is null)
        {
            writer.WriteNull(name);
            return;
        }
        writer.WriteStartArray(name);
        foreach (var value in values)
        {
            writer.WriteStartObject();
            writeMembers(value);
            writer.WriteEndObject();
        }
        writer.WriteEndArray();
    }

    public static TemplatePlan ReadPlan(JsonElement root) =>
        WorkerJson.Read(root, ImportJsonContext.Default.TemplatePlan) ?? new TemplatePlan();

    /// <summary>The profile's strict read: no unknown member, and every selection present and non-null.</summary>
    public static TemplateProfile ReadProfile(JsonElement element) =>
        WorkerJson.Read(element, ImportJsonContext.Default.TemplateProfile) ?? throw new JsonException("the template profile is incomplete");

    public static TemplateInitialization ReadInitialization(JsonElement element) =>
        WorkerJson.Read(element, ImportJsonContext.Default.TemplateInitialization) ?? new TemplateInitialization();
}
