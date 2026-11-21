using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Nix.Domain.Automations;

/// <summary>
/// The loop and blast-radius bounds of ADR-0051 section 6 and Amendment 4, stated once.
/// </summary>
public static class AutomationGuards
{
    /// <summary>A rule fires at most once per item per this interval; later ones are throttled.</summary>
    public static readonly TimeSpan PerItemMinInterval = TimeSpan.FromSeconds(60);

    /// <summary>A rule runs at most this many times per rolling hour; later ones are throttled.</summary>
    public const int PerRuleHourly = 200;

    /// <summary>After this many consecutive failed runs a rule disables itself.</summary>
    public const int DisableAfterFailures = 5;

    /// <summary>How many rules one owner may keep in one workspace.</summary>
    public const int MaxRulesPerOwnerPerWorkspace = 50;

    /// <summary>How many runs are kept per rule; older ones are trimmed on each run.</summary>
    public const int RunsKeptPerRule = 500;
}

/// <summary>The hash a property-change rule compares against to tell a real change from a repeat.</summary>
public static class AutomationValueHash
{
    /// <summary>SHA-256, lowercase hex, of the value's JSON text; an absent value hashes as <c>null</c>.</summary>
    public static string Of(JsonNode? value)
    {
        var bytes = Encoding.UTF8.GetBytes(value?.ToJsonString() ?? "null");
        return Convert.ToHexStringLower(SHA256.HashData(bytes));
    }
}
