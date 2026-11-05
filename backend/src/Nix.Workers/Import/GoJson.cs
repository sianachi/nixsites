using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Nix.Workers.Import;

/// <summary>
/// Writes JSON byte for byte as Go's <c>encoding/json</c> Marshal did: fields in the order the
/// caller writes them, HTML-escaped strings with lowercase hex, and raw values compacted. The plan
/// checksum Core stores is over these bytes, so a retry must write the same ones.
/// </summary>
internal sealed class GoJsonWriter
{
    private const string Hex = "0123456789abcdef";
    private readonly StringBuilder _output = new();
    private bool _comma;

    public byte[] ToUtf8() => Encoding.UTF8.GetBytes(_output.ToString());

    public GoJsonWriter Begin()
    {
        Separate();
        _output.Append('{');
        _comma = false;
        return this;
    }

    public GoJsonWriter End()
    {
        _output.Append('}');
        _comma = true;
        return this;
    }

    public GoJsonWriter BeginArray()
    {
        Separate();
        _output.Append('[');
        _comma = false;
        return this;
    }

    public GoJsonWriter EndArray()
    {
        _output.Append(']');
        _comma = true;
        return this;
    }

    public GoJsonWriter Name(string name)
    {
        Separate();
        _output.Append('"').Append(name).Append("\":");
        _comma = false;
        return this;
    }

    public GoJsonWriter String(string? value)
    {
        Separate();
        if (value is null)
        {
            _output.Append("null");
        }
        else
        {
            AppendString(_output, value);
        }
        _comma = true;
        return this;
    }

    public GoJsonWriter Number(long value)
    {
        Separate();
        _output.Append(value.ToString(CultureInfo.InvariantCulture));
        _comma = true;
        return this;
    }

    public GoJsonWriter Bool(bool value)
    {
        Separate();
        _output.Append(value ? "true" : "false");
        _comma = true;
        return this;
    }

    public GoJsonWriter Null()
    {
        Separate();
        _output.Append("null");
        _comma = true;
        return this;
    }

    /// <summary>A RawMessage: "null" when absent, otherwise the value compacted as Go's Marshal compacts it.</summary>
    public GoJsonWriter Raw(JsonElement? value)
    {
        Separate();
        if (value is null)
        {
            _output.Append("null");
        }
        else
        {
            AppendCompact(_output, value.Value.GetRawText());
        }
        _comma = true;
        return this;
    }

    public GoJsonWriter Strings(IList<string>? values)
    {
        if (values is null)
        {
            return Null();
        }
        BeginArray();
        foreach (var value in values)
        {
            String(value);
        }
        return EndArray();
    }

    private void Separate()
    {
        if (_comma)
        {
            _output.Append(',');
        }
    }

    private static void AppendString(StringBuilder output, string value)
    {
        output.Append('"');
        for (var index = 0; index < value.Length; index++)
        {
            var c = value[index];
            switch (c)
            {
                case '"':
                    output.Append("\\\"");
                    continue;
                case '\\':
                    output.Append("\\\\");
                    continue;
                case '\b':
                    output.Append("\\b");
                    continue;
                case '\f':
                    output.Append("\\f");
                    continue;
                case '\n':
                    output.Append("\\n");
                    continue;
                case '\r':
                    output.Append("\\r");
                    continue;
                case '\t':
                    output.Append("\\t");
                    continue;
                case '<' or '>' or '&' or '\u2028' or '\u2029':
                    AppendEscape(output, c);
                    continue;
            }
            if (c < 0x20)
            {
                AppendEscape(output, c);
            }
            else if (char.IsHighSurrogate(c) && index + 1 < value.Length && char.IsLowSurrogate(value[index + 1]))
            {
                output.Append(c).Append(value[++index]);
            }
            else if (char.IsSurrogate(c))
            {
                // Go writes an invalid code unit as the replacement character.
                output.Append("\\ufffd");
            }
            else
            {
                output.Append(c);
            }
        }
        output.Append('"');
    }

    private static void AppendEscape(StringBuilder output, char c) =>
        output.Append("\\u").Append(Hex[(c >> 12) & 0xf]).Append(Hex[(c >> 8) & 0xf]).Append(Hex[(c >> 4) & 0xf]).Append(Hex[c & 0xf]);

    /// <summary>Go's compact with HTML escaping: insignificant whitespace dropped, &lt; &gt; &amp; U+2028 U+2029 escaped, everything else verbatim.</summary>
    private static void AppendCompact(StringBuilder output, string raw)
    {
        var inString = false;
        var escaped = false;
        foreach (var c in raw)
        {
            if (c is '<' or '>' or '&' or '\u2028' or '\u2029')
            {
                AppendEscape(output, c);
                escaped = false;
                continue;
            }
            if (inString)
            {
                output.Append(c);
                if (escaped)
                {
                    escaped = false;
                }
                else if (c == '\\')
                {
                    escaped = true;
                }
                else if (c == '"')
                {
                    inString = false;
                }
                continue;
            }
            if (c is ' ' or '\t' or '\n' or '\r')
            {
                continue;
            }
            if (c == '"')
            {
                inString = true;
            }
            output.Append(c);
        }
    }
}

/// <summary>
/// Reads one JSON object the way Go's decoder filled a struct: a key matches its field exactly or
/// case-insensitively, the last duplicate wins, null leaves the zero value, and, when strict, an
/// unknown key fails the whole decode (DisallowUnknownFields).
/// </summary>
internal sealed class GoFields
{
    private readonly Dictionary<string, JsonElement> _values = new(StringComparer.Ordinal);

    private GoFields()
    {
    }

    /// <summary>Null for a JSON null (Go leaves the struct zero); throws for any other non-object.</summary>
    public static GoFields? Read(JsonElement element, bool strict, params string[] names)
    {
        if (element.ValueKind == JsonValueKind.Null)
        {
            return null;
        }
        if (element.ValueKind != JsonValueKind.Object)
        {
            throw new JsonException("cannot unmarshal " + element.ValueKind + " into an object");
        }
        var fields = new GoFields();
        foreach (var property in element.EnumerateObject())
        {
            var name = Array.Find(names, candidate => candidate == property.Name)
                ?? Array.Find(names, candidate => string.Equals(candidate, property.Name, StringComparison.OrdinalIgnoreCase));
            if (name is null)
            {
                if (strict)
                {
                    throw new JsonException("json: unknown field \"" + property.Name + "\"");
                }
                continue;
            }
            fields._values[name] = property.Value;
        }
        return fields;
    }

    public static GoFields Require(JsonElement element, bool strict, params string[] names) =>
        Read(element, strict, names) ?? new GoFields();

    public bool Has(string name) => _values.ContainsKey(name);

    /// <summary>The present, non-null value of a field.</summary>
    public bool TryGet(string name, out JsonElement value) =>
        _values.TryGetValue(name, out value) && value.ValueKind != JsonValueKind.Null;

    public string String(string name) => OptionalString(name) ?? string.Empty;

    public string? OptionalString(string name)
    {
        if (!TryGet(name, out var value))
        {
            return null;
        }
        return value.ValueKind == JsonValueKind.String ? value.GetString() : throw Mismatch(name);
    }

    public int Int(string name) => OptionalInt(name) ?? 0;

    public int? OptionalInt(string name)
    {
        if (!TryGet(name, out var value))
        {
            return null;
        }
        return value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) ? number : throw Mismatch(name);
    }

    public long Long(string name)
    {
        if (!TryGet(name, out var value))
        {
            return 0;
        }
        return value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number) ? number : throw Mismatch(name);
    }

    public bool Bool(string name) => OptionalBool(name) ?? false;

    public bool? OptionalBool(string name)
    {
        if (!TryGet(name, out var value))
        {
            return null;
        }
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => throw Mismatch(name),
        };
    }

    /// <summary>A RawMessage: absent is null, a JSON null is kept as a null element.</summary>
    public JsonElement? Raw(string name) => _values.TryGetValue(name, out var value) ? value.Clone() : null;

    /// <summary>A slice: absent or null is null, an array maps each element.</summary>
    public List<T>? List<T>(string name, Func<JsonElement, T> map)
    {
        ArgumentNullException.ThrowIfNull(map);
        if (!TryGet(name, out var value))
        {
            return null;
        }
        if (value.ValueKind != JsonValueKind.Array)
        {
            throw Mismatch(name);
        }
        return [.. value.EnumerateArray().Select(map)];
    }

    public static string StringValue(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString()!,
        JsonValueKind.Null => string.Empty,
        _ => throw new JsonException("cannot unmarshal " + value.ValueKind + " into a string"),
    };

    private static JsonException Mismatch(string name) => new("json: cannot unmarshal field \"" + name + "\" of the wrong type");
}

internal static class GoJson
{
    // Go's decoder stops at 10000 levels; the reader is iterative, so the same bound is safe here.
    private const int MaxDepth = 10_000;

    /// <summary>Parses exactly one JSON value; trailing content fails, as Go's decodeStrictJSON did.</summary>
    public static JsonElement Parse(ReadOnlySpan<byte> body)
    {
        var reader = new Utf8JsonReader(body, new JsonReaderOptions { MaxDepth = MaxDepth });
        using var document = JsonDocument.ParseValue(ref reader);
        if (reader.Read())
        {
            throw new JsonException("JSON contains multiple values");
        }
        return document.RootElement.Clone();
    }

    public static bool IsNull(JsonElement? value) => value is null || value.Value.ValueKind == JsonValueKind.Null;

    public static bool IsObject(JsonElement? value) => value is { ValueKind: JsonValueKind.Object };

    public static bool IsArray(JsonElement? value) => value is { ValueKind: JsonValueKind.Array };

    /// <summary>The RawMessage as Go held it: a JSON null is dropped.</summary>
    public static JsonElement? Nullable(JsonElement? value) => IsNull(value) ? null : value;

    /// <summary>Byte length of the value as it appeared in the source.</summary>
    public static int RawLength(JsonElement? value) => value is null ? 0 : Encoding.UTF8.GetByteCount(value.Value.GetRawText());

    public static bool DepthWithin(JsonElement? value, int maximum, out string error) =>
        DepthWithin(value is null ? [] : Encoding.UTF8.GetBytes(value.Value.GetRawText()), maximum, out error);

    /// <summary>Bounds nesting without materialising another tree; structural bytes are ASCII, so bytes scan as Go scanned them.</summary>
    public static bool DepthWithin(ReadOnlySpan<byte> body, int maximum, out string error)
    {
        error = string.Empty;
        if (maximum <= 0)
        {
            error = "JSON depth limit must be positive";
            return false;
        }
        var depth = 0;
        var inString = false;
        var escaped = false;
        foreach (var c in body)
        {
            if (inString)
            {
                if (escaped)
                {
                    escaped = false;
                }
                else if (c == (byte)'\\')
                {
                    escaped = true;
                }
                else if (c == (byte)'"')
                {
                    inString = false;
                }
                continue;
            }
            switch (c)
            {
                case (byte)'"':
                    inString = true;
                    break;
                case (byte)'{' or (byte)'[':
                    if (++depth > maximum)
                    {
                        error = "JSON nesting exceeds the configured depth limit";
                        return false;
                    }
                    break;
                case (byte)'}' or (byte)']':
                    if (--depth < 0)
                    {
                        error = "JSON nesting is malformed";
                        return false;
                    }
                    break;
            }
        }
        if (inString || depth != 0)
        {
            error = "JSON nesting is malformed";
            return false;
        }
        return true;
    }
}
