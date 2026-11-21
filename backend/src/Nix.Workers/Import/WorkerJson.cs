using System.Buffers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using System.Text.Unicode;

namespace Nix.Workers.Import;

/// <summary>
/// The import family's JSON, on System.Text.Json throughout: plans are written with
/// <see cref="Utf8JsonWriter"/> and every document is read through <see cref="ImportJsonContext"/>.
/// </summary>
/// <remarks>
/// A plan's checksum is taken over the bytes that were stored, so the exact encoding only has to
/// be stable, not match any earlier writer.
/// </remarks>
internal static class WorkerJson
{
    /// <summary>The deepest nesting any document may have; the per-job limits are tighter.</summary>
    public const int MaxDepth = 10_000;

    // Text outside ASCII is written as is, so a plan in another script does not triple in size.
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
        MaxDepth = MaxDepth,
    };

    public static byte[] Write(Action<Utf8JsonWriter> write)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            write(writer);
        }
        return buffer.WrittenSpan.ToArray();
    }

    /// <summary>Writes a stored JSON value under <paramref name="name"/>, or null when there is none.</summary>
    public static void WriteRaw(Utf8JsonWriter writer, string name, JsonElement? value)
    {
        writer.WritePropertyName(name);
        if (value is { } element)
        {
            element.WriteTo(writer);
        }
        else
        {
            writer.WriteNullValue();
        }
    }

    /// <summary>Writes a stored JSON value under <paramref name="name"/>, or nothing when there is none.</summary>
    public static void WriteOptionalRaw(Utf8JsonWriter writer, string name, JsonElement? value)
    {
        if (value is not null)
        {
            WriteRaw(writer, name, value);
        }
    }

    public static void WriteStrings(Utf8JsonWriter writer, string name, IEnumerable<string>? values)
    {
        if (values is null)
        {
            writer.WriteNull(name);
            return;
        }
        writer.WriteStartArray(name);
        foreach (var value in values)
        {
            writer.WriteStringValue(value);
        }
        writer.WriteEndArray();
    }

    /// <summary>Parses exactly one JSON value; trailing content fails.</summary>
    public static JsonElement Parse(ReadOnlySpan<byte> body)
    {
        var reader = new Utf8JsonReader(body, new JsonReaderOptions { MaxDepth = MaxDepth });
        var element = JsonElement.ParseValue(ref reader);
        if (reader.Read())
        {
            throw new JsonException("JSON contains multiple values");
        }
        return element;
    }

    /// <summary>
    /// Reads a typed document: unknown members are refused unless the type opts out, and a JSON null
    /// gives null. The message names where the document is wrong, not the .NET type it was read into.
    /// </summary>
    public static T? Read<T>(JsonElement element, JsonTypeInfo<T> type)
        where T : class
    {
        try
        {
            return element.Deserialize(type);
        }
        catch (JsonException exception)
        {
            throw new JsonException("the JSON does not have the expected shape at " + (exception.Path ?? "$"), exception);
        }
    }

    public static bool IsNull(JsonElement? value) => value is null || value.Value.ValueKind == JsonValueKind.Null;

    public static bool IsObject(JsonElement? value) => value is { ValueKind: JsonValueKind.Object };

    public static bool IsArray(JsonElement? value) => value is { ValueKind: JsonValueKind.Array };

    /// <summary>The value, with a JSON null treated as absent.</summary>
    public static JsonElement? Nullable(JsonElement? value) => IsNull(value) ? null : value;

    /// <summary>Byte length of the value as it appeared in the source.</summary>
    public static int RawLength(JsonElement? value) => value is null ? 0 : Encoding.UTF8.GetByteCount(value.Value.GetRawText());

    public static bool DepthWithin(JsonElement? value, int maximum) =>
        value is null || DepthWithin(Encoding.UTF8.GetBytes(value.Value.GetRawText()), maximum);

    /// <summary>Whether the document nests no deeper than <paramref name="maximum"/>, without building a tree.</summary>
    public static bool DepthWithin(ReadOnlySpan<byte> body, int maximum)
    {
        if (maximum <= 0)
        {
            return false;
        }
        var reader = new Utf8JsonReader(body, new JsonReaderOptions { MaxDepth = maximum });
        try
        {
            while (reader.Read())
            {
            }
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}

/// <summary>
/// How the import family reads JSON: names match without regard to case, a member the type does
/// not declare fails the read, and null is refused where the type says a value is always there.
/// </summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    RespectNullableAnnotations = true,
    RespectRequiredConstructorParameters = true,
    MaxDepth = WorkerJson.MaxDepth)]
[JsonSerializable(typeof(ImportPlan))]
[JsonSerializable(typeof(TemplatePlan))]
[JsonSerializable(typeof(TemplateProfile))]
[JsonSerializable(typeof(TemplateInitialization))]
[JsonSerializable(typeof(NixManifest))]
[JsonSerializable(typeof(NixBundle))]
[JsonSerializable(typeof(NixBodyEnvelope))]
[JsonSerializable(typeof(NixSchemaProperty))]
[JsonSerializable(typeof(NixViewsSnapshot))]
internal sealed partial class ImportJsonContext : JsonSerializerContext;
