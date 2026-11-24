using System.Globalization;
using Nix.Domain.Primitives;

namespace Nix.Features.PetRuns;

/// <summary>Builds the line that hands a selected note's text to the planner model.</summary>
public static class PetRunExcerpt
{
    private const int Limit = 650;

    /// <summary>Describes the note excerpt, and says so when the note was cut.</summary>
    /// <param name="itemId">The selected item.</param>
    /// <param name="markdown">The note text.</param>
    /// <returns>The untrusted excerpt line.</returns>
    public static string Describe(Guid itemId, string markdown)
    {
        var head = $"Untrusted excerpt from selected Nix item {itemId:D}";
        var cut = TextCut.Cut(markdown, Limit);
        return markdown.Length <= Limit
            ? $"{head}: {cut}"
            : $"{head} (the first {Limit} of {markdown.Length.ToString(CultureInfo.InvariantCulture)} characters; the rest was not read): {cut}";
    }
}
