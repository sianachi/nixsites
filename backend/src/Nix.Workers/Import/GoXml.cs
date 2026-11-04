using System.Text;
using System.Xml;

namespace Nix.Workers.Import;

/// <summary>
/// XML read as Go's encoding/xml tokenizer read it: no namespace resolution, element and attribute
/// names matched by the part after the first colon, an empty element as a start and an end token.
/// DTDs are prohibited and nothing is ever resolved, so an entity can neither expand nor fetch.
/// </summary>
internal static class GoXml
{
    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    public enum TokenKind
    {
        Start,
        End,
        Text,
        Comment,
        ProcInst,
    }

    public sealed record Token(TokenKind Kind, string Name, IReadOnlyList<(string Name, string Value)> Attributes, string Text)
    {
        /// <summary>The first attribute with this local name, or empty (Go's attribute helper).</summary>
        public string Attribute(string local) => Attributes.FirstOrDefault(attribute => attribute.Name == local).Value ?? string.Empty;
    }

    /// <summary>Go's validateXML: the reason the body is refused, or null.</summary>
    public static string? Validate(byte[] body, int maxDepth, int maxTokens)
    {
        if (maxDepth <= 0 || maxTokens <= 0 || RejectsDeclarations(body))
        {
            return "XML document types and entities are not supported";
        }
        var depth = 0;
        var tokens = 0;
        try
        {
            foreach (var token in Tokens(body))
            {
                if (++tokens > maxTokens)
                {
                    return "XML token count exceeds the configured limit";
                }
                switch (token.Kind)
                {
                    case TokenKind.Start:
                        if (++depth > maxDepth || token.Attributes.Count > 256)
                        {
                            return "XML structure exceeds the configured limit";
                        }
                        break;
                    case TokenKind.End:
                        if (--depth < 0)
                        {
                            return "XML element nesting is invalid";
                        }
                        break;
                    case TokenKind.ProcInst when !string.Equals(token.Name, "xml", StringComparison.OrdinalIgnoreCase):
                        return "XML processing instructions are not supported";
                }
            }
        }
        catch (XmlException exception)
        {
            return "decode XML: " + exception.Message;
        }
        return depth != 0 ? "XML element nesting is incomplete" : null;
    }

    private static bool RejectsDeclarations(byte[] body)
    {
        var upper = Encoding.Latin1.GetString(body).ToUpperInvariant();
        return upper.Contains("<!DOCTYPE", StringComparison.Ordinal) || upper.Contains("<!ENTITY", StringComparison.Ordinal);
    }

    /// <summary>The token stream; malformed input throws <see cref="XmlException"/>.</summary>
    public static IEnumerable<Token> Tokens(byte[] body)
    {
        string text;
        try
        {
            text = StrictUtf8.GetString(body);
        }
        catch (DecoderFallbackException exception)
        {
            throw new XmlException("invalid UTF-8", exception);
        }
        if (text.StartsWith('﻿'))
        {
            text = text[1..];
        }
        return Read(text);
    }

    private static IEnumerable<Token> Read(string text)
    {
        using var reader = new XmlTextReader(new StringReader(text))
        {
            Namespaces = false,
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            WhitespaceHandling = WhitespaceHandling.All,
            Normalization = true,
        };
        while (reader.Read())
        {
            switch (reader.NodeType)
            {
                case XmlNodeType.Element:
                    var name = Local(reader.Name);
                    var empty = reader.IsEmptyElement;
                    var attributes = new List<(string, string)>(reader.AttributeCount);
                    while (reader.MoveToNextAttribute())
                    {
                        attributes.Add((Local(reader.Name), reader.Value));
                    }
                    yield return new Token(TokenKind.Start, name, attributes, string.Empty);
                    if (empty)
                    {
                        yield return new Token(TokenKind.End, name, [], string.Empty);
                    }
                    break;
                case XmlNodeType.EndElement:
                    yield return new Token(TokenKind.End, Local(reader.Name), [], string.Empty);
                    break;
                case XmlNodeType.Text or XmlNodeType.CDATA or XmlNodeType.Whitespace or XmlNodeType.SignificantWhitespace:
                    yield return new Token(TokenKind.Text, string.Empty, [], reader.Value);
                    break;
                case XmlNodeType.Comment:
                    yield return new Token(TokenKind.Comment, string.Empty, [], reader.Value);
                    break;
                case XmlNodeType.XmlDeclaration:
                    // Go refused any declared encoding but UTF-8 without a CharsetReader.
                    var encoding = reader.GetAttribute("encoding");
                    if (!string.IsNullOrEmpty(encoding) && !string.Equals(encoding, "utf-8", StringComparison.OrdinalIgnoreCase))
                    {
                        throw new XmlException("xml: encoding \"" + encoding + "\" declared but Decoder.CharsetReader is nil");
                    }
                    yield return new Token(TokenKind.ProcInst, "xml", [], string.Empty);
                    break;
                case XmlNodeType.ProcessingInstruction:
                    yield return new Token(TokenKind.ProcInst, reader.Name, [], string.Empty);
                    break;
                default:
                    throw new XmlException("XML directives are not supported");
            }
        }
    }

    /// <summary>Go's name split: the part after the first colon, unless either side would be empty.</summary>
    private static string Local(string name)
    {
        var colon = name.IndexOf(':', StringComparison.Ordinal);
        return colon < 1 || colon == name.Length - 1 ? name : name[(colon + 1)..];
    }

    /// <summary>The first element as a small tree, for the xml.Unmarshal reads of relationships and numbering.</summary>
    public static Element Tree(byte[] body)
    {
        var stack = new Stack<Element>();
        Element? root = null;
        foreach (var token in Tokens(body))
        {
            if (token.Kind == TokenKind.Start)
            {
                var element = new Element(token.Name, token.Attributes);
                if (stack.TryPeek(out var parent))
                {
                    parent.Nested.Add(element);
                }
                else if (root is null)
                {
                    root = element;
                }
                stack.Push(element);
            }
            else if (token.Kind == TokenKind.End)
            {
                stack.Pop();
            }
        }
        return root ?? new Element(string.Empty, []);
    }

    public sealed class Element(string name, IReadOnlyList<(string Name, string Value)> attributes)
    {
        public string Name { get; } = name;

        public List<Element> Nested { get; } = [];

        public IEnumerable<Element> Children(string local) => Nested.Where(child => child.Name == local);

        /// <summary>xml.Unmarshal's attribute: the last one with this local name wins, absent is empty.</summary>
        public string Attribute(string local) => FindAttribute(local) ?? string.Empty;

        public string? FindAttribute(string local) => attributes.LastOrDefault(attribute => attribute.Name == local).Value;
    }
}
