using System.Globalization;

namespace Nix.Features.Connections;

internal sealed record ConnectorProvider(string Id, string ClientId, string ClientSecret, string Authorize, string Token, bool UsePkce)
{
    internal static ConnectorProvider? Find(IConfiguration config, string provider)
    {
        var section = config.GetSection("Nix:Connectors").GetSection(provider);
        var id = section["ClientId"];
        var secret = section["ClientSecret"];
        if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(secret))
        {
            return null;
        }

        var tenant = section["Tenant"] ?? "organizations";
        var microsoft = string.Equals(tenant, "organizations", StringComparison.Ordinal) || Guid.TryParse(tenant, out _);
        return provider switch
        {
            "google" => new(provider, id, secret, "https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token", true),
            "microsoft" when microsoft => new(provider, id, secret,
                string.Create(CultureInfo.InvariantCulture, $"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize"),
                string.Create(CultureInfo.InvariantCulture, $"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"), true),
            "slack" => new(provider, id, secret, "https://slack.com/oauth/v2/authorize", "https://slack.com/api/oauth.v2.access", false),
            "github" => new(provider, id, secret, "https://github.com/login/oauth/authorize", "https://github.com/login/oauth/access_token", true),
            "linear" => new(provider, id, secret, "https://linear.app/oauth/authorize", "https://api.linear.app/oauth/token", true),
            _ => null,
        };
    }

    internal string[] Scopes(IEnumerable<ConnectorActionDefinition> actions)
    {
        var scopes = actions.SelectMany(ScopeFor).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal);
        return Id is "microsoft" or "github" ? [.. scopes, "offline_access"] : [.. scopes];
    }

    private static string[] ScopeFor(ConnectorActionDefinition action)
    {
        const string google = "https://www.googleapis.com/auth/";
        var write = action.Kind == "write";
        return action.Id.Split('.')[0] switch
        {
            "gmail" => write ? [google + "gmail.readonly", google + "gmail.send"] : [google + "gmail.readonly"],
            "google-drive" => write ? [google + "drive.readonly", google + "drive.file"] : [google + "drive.readonly"],
            "google-calendar" => write ? [google + "calendar.events"] : [google + "calendar.events.readonly", google + "calendar.events.freebusy"],
            "outlook-mail" => write ? ["Mail.Read", "Mail.Send"] : ["Mail.Read"],
            "onedrive" => write ? ["Files.ReadWrite"] : ["Files.Read"],
            "outlook-calendar" => write ? ["Calendars.ReadWrite"] : ["Calendars.Read"],
            "teams" => write ? ["ChannelMessage.Read.All", "ChannelMessage.Send"] : ["ChannelMessage.Read.All"],
            "slack" => write ? ["channels:history", "groups:history", "chat:write"] : ["channels:history", "groups:history"],
            "linear" => write ? ["read", "issues:create"] : ["read"],
            _ => [],
        };
    }
}
