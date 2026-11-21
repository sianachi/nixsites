using System.Text.Json.Nodes;

namespace Nix.Domain.Items;

/// <summary>
/// The optional features an item switches on for itself. All off unless someone turns them on.
/// </summary>
/// <param name="Comments">Whether people may add comments and replies to the item.</param>
/// <param name="Suggesting">Whether the item's editor offers suggesting (track changes).</param>
/// <param name="ReviewStates">Whether a file's versions carry Draft, In review and Approved states.</param>
/// <param name="FullWidth">Whether a note's body uses the full width of its pane.</param>
/// <param name="WithholdFromPets">Whether this item is excluded from pet work and model inputs.</param>
/// <remarks>
/// The item stores these settings together as JSON. The workspace stores defaults for the editor
/// switches. A missing value reads as off. A malformed pet protection flag withholds the item.
/// </remarks>
public sealed record ItemSettings(
    bool Comments = false, bool Suggesting = false, bool ReviewStates = false, bool FullWidth = false,
    bool WithholdFromPets = false)
{
    /// <summary>Reads the stored JSON, tolerating null and anything unexpected.</summary>
    /// <param name="json">The stored object, or null.</param>
    /// <returns>The settings, including protection when a stored pet protection flag is malformed.</returns>
    public static ItemSettings Read(string? json)
    {
        JsonObject? node = null;
        try
        {
            node = string.IsNullOrWhiteSpace(json) ? null : JsonNode.Parse(json) as JsonObject;
        }
        catch (System.Text.Json.JsonException)
        {
        }

        return new ItemSettings(
            Flag(node, "comments"), Flag(node, "suggesting"), Flag(node, "reviewStates"), Flag(node, "fullWidth"),
            node?.ContainsKey("withholdFromPets") == true
                && (node["withholdFromPets"] is not JsonValue value || !value.TryGetValue<bool>(out var mark) || mark));
    }

    /// <summary>The JSON to merge over the stored object: only the switches named, so two edits do not overwrite each other.</summary>
    /// <param name="comments">The comments switch, or null to leave it.</param>
    /// <param name="suggesting">The suggesting switch, or null to leave it.</param>
    /// <param name="reviewStates">The review-states switch, or null to leave it.</param>
    /// <param name="fullWidth">The full-width switch, or null to leave it.</param>
    /// <returns>A JSON object holding only the named switches.</returns>
    public static string Patch(bool? comments, bool? suggesting, bool? reviewStates, bool? fullWidth)
    {
        var patch = new JsonObject();
        if (comments is { } c)
        {
            patch["comments"] = c;
        }

        if (suggesting is { } s)
        {
            patch["suggesting"] = s;
        }

        if (reviewStates is { } r)
        {
            patch["reviewStates"] = r;
        }

        if (fullWidth is { } f)
        {
            patch["fullWidth"] = f;
        }

        return patch.ToJsonString();
    }

    /// <summary>Switches comments on in stored settings that do not say either way.</summary>
    /// <param name="json">The stored object, or null.</param>
    /// <returns>The JSON with comments on, or null when it already has a comments value or cannot be read.</returns>
    public static string? WithCommentsOn(string? json)
    {
        try
        {
            var node = string.IsNullOrWhiteSpace(json) ? [] : JsonNode.Parse(json) as JsonObject;
            if (node is null || node.ContainsKey("comments"))
            {
                return null;
            }

            node["comments"] = true;
            return node.ToJsonString();
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }

    private static bool Flag(JsonObject? node, string key) =>
        node?[key] is JsonValue value && value.TryGetValue<bool>(out var on) && on;
}
