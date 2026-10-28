namespace Nix.Domain.Notifications;

/// <summary>
/// The one mapping between <see cref="NotificationKind"/> and its lowercase wire and storage
/// spelling, shared by the EF configuration, the raw-SQL writer, and the API response mapping so
/// the three can never drift out of step.
/// </summary>
public static class NotificationKindStorage
{
    /// <summary>Converts to the stored/wire spelling.</summary>
    public static string ToText(NotificationKind kind) => kind switch
    {
        NotificationKind.Reminder => "reminder",
        NotificationKind.Automation => "automation",
        NotificationKind.Calendar => "calendar",
        NotificationKind.System => "system",
        NotificationKind.Invitation => "invitation",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown notification kind."),
    };

    /// <summary>Parses the stored/wire spelling back.</summary>
    public static NotificationKind FromText(string text) => text switch
    {
        "reminder" => NotificationKind.Reminder,
        "automation" => NotificationKind.Automation,
        "calendar" => NotificationKind.Calendar,
        "system" => NotificationKind.System,
        "invitation" => NotificationKind.Invitation,
        _ => throw new InvalidOperationException($"Unknown stored notification kind '{text}'."),
    };
}
