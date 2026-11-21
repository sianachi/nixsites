using System.Xml;
using System.Xml.Linq;

namespace Nix.Workers.Import;

/// <summary>
/// Reads untrusted XML with <see cref="XmlReader"/>: a document type is refused outright, so no
/// entity can expand or fetch, and nothing is ever resolved. Elements and attributes are matched by
/// local name, so a document in either OOXML namespace reads the same.
/// </summary>
internal static class SafeXml
{
    private const int MaxAttributes = 256;

    private static readonly XmlReaderSettings Settings = new()
    {
        DtdProcessing = DtdProcessing.Prohibit,
        XmlResolver = null,
    };

    /// <summary>A reader over <paramref name="body"/>; malformed input throws <see cref="XmlException"/> as it is read.</summary>
    public static XmlReader Open(byte[] body) => XmlReader.Create(new MemoryStream(body, writable: false), Settings);

    /// <summary>The reason the document is refused, or null: well formed, bounded in depth and size, no processing instruction.</summary>
    public static string? Validate(byte[] body, int maxDepth, int maxTokens)
    {
        if (maxDepth <= 0 || maxTokens <= 0)
        {
            return "XML limits must be positive";
        }
        try
        {
            using var reader = Open(body);
            var tokens = 0;
            while (reader.Read())
            {
                // An empty element counts as its start and its end.
                tokens += reader is { NodeType: XmlNodeType.Element, IsEmptyElement: true } ? 2 : 1;
                if (tokens > maxTokens)
                {
                    return "XML token count exceeds the configured limit";
                }
                switch (reader.NodeType)
                {
                    case XmlNodeType.Element when reader.Depth >= maxDepth || reader.AttributeCount > MaxAttributes:
                        return "XML structure exceeds the configured limit";
                    case XmlNodeType.ProcessingInstruction:
                        return "XML processing instructions are not supported";
                }
            }
        }
        catch (XmlException exception)
        {
            return "decode XML: " + exception.Message;
        }
        return null;
    }

    /// <summary>The document element as a tree.</summary>
    public static XElement Root(byte[] body)
    {
        using var reader = Open(body);
        return XDocument.Load(reader).Root ?? throw new XmlException("the XML document is empty");
    }

    public static IEnumerable<XElement> Children(this XElement element, string local) =>
        element.Elements().Where(child => child.Name.LocalName == local);

    /// <summary>The value of the attribute with this local name, or null.</summary>
    public static string? FindAttribute(this XElement element, string local) =>
        element.Attributes().LastOrDefault(attribute => !attribute.IsNamespaceDeclaration && attribute.Name.LocalName == local)?.Value;

    /// <summary>The value of the attribute with this local name, or empty.</summary>
    public static string AttributeValue(this XElement element, string local) => element.FindAttribute(local) ?? string.Empty;

    /// <summary>The value of the current element's attribute with this local name, or empty.</summary>
    public static string AttributeValue(this XmlReader reader, string local)
    {
        var value = string.Empty;
        if (reader.MoveToFirstAttribute())
        {
            do
            {
                if (reader.LocalName == local && reader.Prefix != "xmlns" && reader.Name != "xmlns")
                {
                    value = reader.Value;
                    break;
                }
            }
            while (reader.MoveToNextAttribute());
            reader.MoveToElement();
        }
        return value;
    }
}
