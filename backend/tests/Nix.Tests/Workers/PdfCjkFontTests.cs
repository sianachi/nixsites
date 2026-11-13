using Nix.Workers.Archive;
using Nix.Workers.Export;
using Nix.Workers.Render;
using UglyToad.PdfPig;

namespace Nix.Tests.Workers;

/// <summary>Chinese, Japanese and Korean text is drawn with the Noto fallbacks instead of "?", and wraps inside the margins.</summary>
public sealed class PdfCjkFontTests
{
    [Fact]
    public async Task Cjk_text_is_drawn_in_titles_paragraphs_code_and_tables()
    {
        Assert.SkipUnless(CjkFonts.Has("NotoSansSC") && CjkFonts.Has("NotoSansKR"), "The PDF fallback fonts are not fetched (scripts/fetch-pdf-fonts.sh).");
        const string Mixed = "Nix 是一个工作区，ひらがな カタカナ 한국어 Ελληνικά";
        Assert.False(ExportWriters.PdfTextRequiresSubstitution(Mixed));

        var text = await TextAsync(new ExportRecord
        {
            Id = "1",
            Title = "会议记录",
            Blocks =
            [
                RenderTree.Paragraph(Mixed),
                new Block { Kind = "paragraph", Runs = [new Run { Text = "粗体", Styles = ["bold"] }, new Run { Text = " 斜体", Styles = ["italic"] }] },
                new Block { Kind = "code", Text = "// 注释" },
                new Block { Kind = "table", Rows = [new Row { Header = true, Cells = [[new Run { Text = "名前" }], [new Run { Text = "이름" }]] }] },
            ],
        });

        foreach (var expected in new[] { "会议记录", "是一个工作区", "ひらがな", "カタカナ", "한국어", "Ελληνικά", "粗体", "斜体", "注释", "名前", "이름" })
        {
            Assert.Contains(expected, text, StringComparison.Ordinal);
        }
        Assert.DoesNotContain('?', text);
    }

    [Fact]
    public async Task A_long_cjk_paragraph_wraps_inside_the_right_margin()
    {
        Assert.SkipUnless(CjkFonts.Has("NotoSansSC"), "The PDF fallback fonts are not fetched (scripts/fetch-pdf-fonts.sh).");
        using var output = new MemoryStream();
        await ExportWriters.WriteAsync("pdf", One(new ExportRecord { Id = "1", Title = "长段落", Blocks = [RenderTree.Paragraph(string.Concat(Enumerable.Repeat("这是一个没有空格的长句子", 30)))] }), output, Limits, "a4", TestContext.Current.CancellationToken);

        using var document = PdfDocument.Open(output.ToArray());
        var page = document.GetPage(1);
        Assert.All(page.Letters, letter => Assert.True(letter.BoundingBox.Right <= page.Width - 49, $"'{letter.Value}' ends at {letter.BoundingBox.Right}"));
    }

    private static readonly StreamLimits Limits = new(100L << 20, 4 << 20, 100_000);

    private static async Task<string> TextAsync(ExportRecord record)
    {
        using var output = new MemoryStream();
        await ExportWriters.WriteAsync("pdf", One(record), output, Limits, "a4", TestContext.Current.CancellationToken);
        using var document = PdfDocument.Open(output.ToArray());
        return string.Concat(document.GetPages().SelectMany(page => page.Letters).Select(letter => letter.Value)).Replace(" ", string.Empty, StringComparison.Ordinal);
    }

    private static async IAsyncEnumerable<ExportRecord> One(ExportRecord record)
    {
        await Task.CompletedTask;
        yield return record;
    }
}
