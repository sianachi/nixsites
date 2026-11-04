using System.Globalization;
using System.Text;

namespace Nix.Workers.Render;

/// <summary>Writes blocks as CommonMark/GFM, byte for byte as the Go worker did.</summary>
public static class MarkdownRenderer
{
    public static string Render(IList<Block> blocks)
    {
        var output = new StringBuilder();
        Write(output, blocks, string.Empty);
        return output.ToString().Trim();
    }

    private static void Write(StringBuilder output, IList<Block>? blocks, string prefix)
    {
        var index = 0;
        foreach (var block in blocks ?? [])
        {
            if (index++ > 0)
            {
                output.Append('\n').Append(prefix.TrimEnd(' ')).Append('\n');
            }
            switch (block.Kind)
            {
                case "heading":
                    output.Append(prefix).Append('#', Math.Min(Math.Max(block.Level, 1), 6)).Append(' ').Append(Inline(block.RunsOrEmpty));
                    break;
                case "quote":
                    {
                        var inner = new StringBuilder();
                        Write(inner, block.Blocks, string.Empty);
                        output.Append(PrefixLines(inner.ToString(), prefix + "> "));
                        break;
                    }
                case "callout":
                    {
                        var inner = new StringBuilder();
                        inner.Append("[!").Append((block.Tone ?? string.Empty).ToUpperInvariant()).Append("]\n\n");
                        Write(inner, block.Blocks, string.Empty);
                        output.Append(PrefixLines(inner.ToString(), prefix + "> "));
                        break;
                    }
                case "code":
                    {
                        var language = new string((block.Language ?? string.Empty).Where(c => c is not ('`' or '\n' or '\r')).ToArray());
                        output.Append(PrefixLines("```" + language + "\n" + (block.Text ?? string.Empty) + "\n```", prefix));
                        break;
                    }
                case "rule":
                    output.Append(prefix).Append("---");
                    break;
                case "pageBreak":
                    output.Append(prefix).Append("<!-- nix-page-break -->");
                    break;
                case "image":
                    output.Append(prefix).Append("![").Append(Escape(block.Alt ?? string.Empty)).Append("](").Append(Destination(block.Src ?? string.Empty)).Append(')');
                    break;
                case "list":
                    {
                        var item = 0;
                        foreach (var entry in block.ItemsOrEmpty)
                        {
                            if (item > 0)
                            {
                                output.Append('\n');
                            }
                            var marker = "- ";
                            if (block.Ordered)
                            {
                                marker = (Math.Max(block.Start, 1) + item).ToString(CultureInfo.InvariantCulture) + ". ";
                            }
                            if (entry.Checked is { } check)
                            {
                                marker += check ? "[x] " : "[ ] ";
                            }
                            var inner = new StringBuilder();
                            Write(inner, entry.Blocks, string.Empty);
                            var indent = new string(' ', marker.Length);
                            var body = PrefixLines(inner.ToString(), indent);
                            output.Append(prefix).Append(marker).Append(body.StartsWith(indent, StringComparison.Ordinal) ? body[indent.Length..] : body);
                            item++;
                        }
                        break;
                    }
                case "table":
                    {
                        var rows = block.RowsOrEmpty;
                        if (rows.Count == 0)
                        {
                            // Go's `continue` skipped the separator bookkeeping too; the next block still gets its blank line.
                            continue;
                        }
                        var width = rows.Max(row => row.Cells.Count);
                        string Line(IList<IList<Run>> cells)
                        {
                            var parts = new string[width];
                            for (var column = 0; column < width; column++)
                            {
                                parts[column] = column < cells.Count
                                    ? Inline(cells[column]).Replace("|", "\\|", StringComparison.Ordinal).Replace("\n", " ", StringComparison.Ordinal)
                                    : string.Empty;
                            }
                            return prefix + "| " + string.Join(" | ", parts) + " |";
                        }
                        output.Append(Line(rows[0].Cells)).Append('\n');
                        output.Append(prefix).Append('|').Append(string.Concat(Enumerable.Repeat(" --- |", width)));
                        foreach (var row in rows.Skip(1))
                        {
                            output.Append('\n').Append(Line(row.Cells));
                        }
                        break;
                    }
                case "details":
                    {
                        var open = block.Level > 0 ? $"<details data-toggle-level=\"{block.Level.ToString(CultureInfo.InvariantCulture)}\">" : "<details>";
                        var inner = new StringBuilder();
                        Write(inner, block.Blocks, string.Empty);
                        output.Append(PrefixLines(open + "\n<summary>" + Inline(block.SummaryOrEmpty) + "</summary>\n\n" + inner + "\n\n</details>", prefix));
                        break;
                    }
                default: // paragraph, and any kind this build does not know but whose runs it can keep.
                    output.Append(PrefixLines(Inline(block.RunsOrEmpty), prefix));
                    break;
            }
        }
    }

    private static string PrefixLines(string text, string prefix)
    {
        var lines = text.Split('\n');
        for (var index = 0; index < lines.Length; index++)
        {
            lines[index] = lines[index].Length == 0 ? prefix.TrimEnd(' ') : prefix + lines[index];
        }
        return string.Join('\n', lines);
    }

    public static string Inline(IList<Run> runs)
    {
        ArgumentNullException.ThrowIfNull(runs);
        var output = new StringBuilder();
        foreach (var run in runs)
        {
            if (run.Text == "\n")
            {
                output.Append("\\\n");
                continue;
            }
            var text = Escape(run.Text);
            if (run.Has("code"))
            {
                text = "`" + run.Text.Replace("`", "\\`", StringComparison.Ordinal) + "`";
            }
            if (run.Has("strike"))
            {
                text = "~~" + text + "~~";
            }
            if (run.Has("italic"))
            {
                text = "*" + text + "*";
            }
            if (run.Has("bold"))
            {
                text = "**" + text + "**";
            }
            if (!string.IsNullOrEmpty(run.Href))
            {
                text = "[" + text + "](" + Destination(run.Href) + ")";
            }
            output.Append(text);
        }
        return output.ToString();
    }

    public static string Escape(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        var output = new StringBuilder(value.Length);
        var atLineStart = true;
        foreach (var rune in value.EnumerateRunes())
        {
            var c = rune.Value;
            if ("\\`*_[]<|~".Contains((char)Math.Min(c, char.MaxValue), StringComparison.Ordinal) && c <= char.MaxValue
                || atLineStart && c <= char.MaxValue && "#>-+".Contains((char)c, StringComparison.Ordinal))
            {
                output.Append('\\');
            }
            output.Append(rune.ToString());
            atLineStart = c == '\n';
        }
        return output.ToString();
    }

    public static string Destination(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (value.Contains(' ', StringComparison.Ordinal) || value.Contains('\t', StringComparison.Ordinal))
        {
            return "<" + value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("<", "%3C", StringComparison.Ordinal).Replace(">", "%3E", StringComparison.Ordinal).Replace("\"", "%22", StringComparison.Ordinal) + ">";
        }
        return value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("(", "\\(", StringComparison.Ordinal).Replace(")", "\\)", StringComparison.Ordinal)
            .Replace("<", "%3C", StringComparison.Ordinal).Replace(">", "%3E", StringComparison.Ordinal).Replace("\"", "%22", StringComparison.Ordinal);
    }
}
