using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Nix.Domain.Sites;

/// <summary>
/// The pure rules of a site: the vocabularies its columns draw from, the shapes slugs, paths and
/// hostnames must have, and how a title becomes a path. Nothing here reads a clock or a database.
/// </summary>
public static partial class SiteRules
{
    /// <summary>The docs layout: a sidebar tree with a table of contents.</summary>
    public const string DocsLayout = "docs";

    /// <summary>The blog and portfolio layout.</summary>
    public const string BlogLayout = "blog";

    /// <summary>The layout rendered from a theme page's own templates, styles and scripts.</summary>
    public const string CustomLayout = "custom";

    /// <summary>Rebuild only when a manager publishes.</summary>
    public const string ManualMode = "manual";

    /// <summary>Rebuild, debounced, after a confirmed edit inside the subtree.</summary>
    public const string AutoMode = "auto";

    /// <summary>Rebuild when the production release procedure publishes; Core plans nothing for it.</summary>
    public const string OnReleaseMode = "on_release";

    /// <summary>A site that has never been live.</summary>
    public const string DraftStatus = "draft";

    /// <summary>A site whose hostnames point at a build.</summary>
    public const string PublishedStatus = "published";

    /// <summary>A site that was withdrawn.</summary>
    public const string UnpublishedStatus = "unpublished";

    /// <summary>A build whose worker has not sealed it.</summary>
    public const string QueuedBuild = "queued";

    /// <summary>A build whose files are complete and whose host manifests are being written.</summary>
    public const string SealedBuild = "sealed";

    /// <summary>The build the hostnames point at.</summary>
    public const string LiveBuild = "live";

    /// <summary>A previous build, kept for rollback.</summary>
    public const string SupersededBuild = "superseded";

    /// <summary>A build that never went live.</summary>
    public const string FailedBuild = "failed";

    /// <summary>A build whose objects are deleted.</summary>
    public const string PurgedBuild = "purged";

    /// <summary>The kind of the hostname derived from the slug.</summary>
    public const string DefaultHost = "default";

    /// <summary>The kind of a hostname a manager attached.</summary>
    public const string CustomHost = "custom";

    /// <summary>An activation that goes live with a new build.</summary>
    public const string PublishActivation = "publish";

    /// <summary>An activation that points the hostnames back at a previous build.</summary>
    public const string RollbackActivation = "rollback";

    /// <summary>An activation that removes the host manifests.</summary>
    public const string UnpublishActivation = "unpublish";

    /// <summary>An activation that rewrites the host manifests after a hostname change, keeping the live build.</summary>
    public const string HostnamesActivation = "hostnames";

    /// <summary>A build object under the build prefix.</summary>
    public const string BuildObject = "build";

    /// <summary>A content-addressed image shared between builds.</summary>
    public const string AssetObject = "asset";

    /// <summary>The default and bounds of the automatic rebuild debounce, in seconds.</summary>
    public const int DefaultDebounceSeconds = 300;

    /// <summary>The shortest debounce a site may ask for.</summary>
    public const int MinimumDebounceSeconds = 60;

    /// <summary>The longest debounce a site may ask for.</summary>
    public const int MaximumDebounceSeconds = 3600;

    /// <summary>The most pages one build may hold.</summary>
    public const int MaximumPages = 5_000;

    /// <summary>The most objects one build may write.</summary>
    public const int MaximumObjects = 20_000;

    /// <summary>The most publishing notes a build response retains.</summary>
    public const int MaximumLossEntries = 128;

    /// <summary>The most bytes one build may write.</summary>
    public const long MaximumBuildBytes = 2L * 1024 * 1024 * 1024;

    /// <summary>The most bytes one object may hold.</summary>
    public const long MaximumObjectBytes = 50L * 1024 * 1024;

    /// <summary>The most entries one upload request may carry.</summary>
    public const int MaximumUploadBatch = 100;

    /// <summary>The most bytes one copied image may hold.</summary>
    public const long MaximumImageBytes = 10L * 1024 * 1024;

    /// <summary>
    /// The most bytes one captured Mermaid diagram (SVG) may hold; matches
    /// <c>MAX_DIAGRAM_BYTES</c> in <c>@nix/site-render</c>, which re-sanitises it before publishing.
    /// </summary>
    public const long MaximumDiagramBytes = 2L * 1024 * 1024;

    /// <summary>
    /// The most bytes one published download (PDF, plain text or CSV) may hold; matches
    /// <c>MAX_DOWNLOAD_BYTES</c> in <c>@nix/site-render</c> and the eligibility statement.
    /// </summary>
    public const long MaximumDownloadBytes = 20L * 1024 * 1024;

    /// <summary>
    /// The most bytes one published video (MP4 or WebM) may hold; matches <c>MAX_VIDEO_BYTES</c> in
    /// <c>@nix/site-render</c> and the eligibility statement.
    /// </summary>
    public const long MaximumVideoBytes = 50L * 1024 * 1024;

    /// <summary>The most custom hostnames one site may attach.</summary>
    public const int MaximumCustomHostnames = 10;

    private const int MaximumSegmentLength = 80;

    // Names a deployment's own services answer, or may one day; never a site, even when the sites
    // domain is the app's apex. "home" is a namespace (home.<domain> holds a second deployment's sites).
    private static readonly HashSet<string> InfrastructureSlugs = new(StringComparer.Ordinal)
    {
        "www", "app", "api", "auth", "login", "logout", "signin", "signup", "admin", "root", "mail", "smtp",
        "imap", "pop", "ftp", "ns1", "ns2", "dns", "cdn", "static", "assets", "files", "collab", "ws", "status",
        "docs", "help", "support", "billing", "account", "accounts", "security", "home", "sites",
    };

    // Kept for the deployment owner's own sites; claimable only through Nix:Sites:ReservedSlugOwners.
    private static readonly HashSet<string> OwnerSlugs = new(StringComparer.Ordinal) { "nix", "osinachi" };

    /// <summary>Whether <paramref name="layout"/> names a theme layout.</summary>
    public static bool IsLayout(string? layout) => layout is DocsLayout or BlogLayout or CustomLayout;

    /// <summary>Checks that a custom layout names a theme page; returns the refusal, or null when the pair is acceptable.</summary>
    /// <param name="layout">The layout the site will have.</param>
    /// <param name="themeItemId">The theme page the settings name, if any.</param>
    /// <returns>A sentence naming what is wrong, or null.</returns>
    public static string? ThemeRefusal(string layout, Guid? themeItemId) =>
        layout == CustomLayout && themeItemId is null
            ? "The custom layout needs a theme page. Choose the page that holds the templates, styles and scripts."
            : null;

    /// <summary>Whether <paramref name="mode"/> names a republish mode.</summary>
    public static bool IsRepublishMode(string? mode) => mode is ManualMode or AutoMode or OnReleaseMode;

    /// <summary>Whether <paramref name="slug"/> is a valid site slug: 2 to 40 lowercase letters, digits and single hyphens.</summary>
    public static bool IsSlug(string? slug) => slug is not null && SlugPattern().IsMatch(slug);

    /// <summary>Whether <paramref name="slug"/> is reserved: an infrastructure name or one kept for the deployment owner.</summary>
    public static bool IsReservedSlug(string slug) => IsInfrastructureSlug(slug) || OwnerSlugs.Contains(slug);

    /// <summary>Whether <paramref name="slug"/> names a deployment service and can never be a site.</summary>
    public static bool IsInfrastructureSlug(string slug) => InfrastructureSlugs.Contains(slug);

    /// <summary>Whether <paramref name="path"/> is <c>/</c> or a lowercase slash-terminated path.</summary>
    public static bool IsPath(string? path) => path is { Length: <= 512 } && PathPattern().IsMatch(path);

    /// <summary>Whether <paramref name="hostname"/> is a lowercase DNS name with at least two labels.</summary>
    public static bool IsHostname(string? hostname) =>
        hostname is { Length: <= 253 } && HostnamePattern().IsMatch(hostname) && !NumericTldPattern().IsMatch(hostname);

    /// <summary>Whether <paramref name="color"/> is a <c>#rrggbb</c> colour.</summary>
    public static bool IsAccent(string? color) => color is not null && AccentPattern().IsMatch(color);

    /// <summary>Whether <paramref name="digest"/> is a lowercase SHA-256 hex digest.</summary>
    public static bool IsSha256(string? digest) => digest is { Length: 64 } && digest.All(static c => c is (>= '0' and <= '9') or (>= 'a' and <= 'f'));

    /// <summary>
    /// Turns a title into one path segment: accents stripped, lowercase, every other run of
    /// characters one hyphen, at most 80 characters. An empty result is <c>untitled</c>.
    /// </summary>
    /// <param name="title">The title, which may be null or empty.</param>
    /// <returns>A segment matching <c>[a-z0-9][a-z0-9-]*</c>.</returns>
    public static string Slugify(string? title)
    {
        var builder = new StringBuilder(MaximumSegmentLength);
        foreach (var character in (title ?? string.Empty).Normalize(NormalizationForm.FormKD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(character) == UnicodeCategory.NonSpacingMark)
            {
                continue;
            }

            var lower = char.ToLowerInvariant(character);
            if (lower is (>= 'a' and <= 'z') or (>= '0' and <= '9'))
            {
                builder.Append(lower);
            }
            else if (builder.Length > 0 && builder[^1] != '-')
            {
                builder.Append('-');
            }
        }

        return Trim(builder.ToString(), MaximumSegmentLength) is { Length: > 0 } slug ? slug : "untitled";
    }

    /// <summary>
    /// Derives the path of an item that has none: its parent's path plus the slug of its title,
    /// with a numeric suffix until nothing else holds the path.
    /// </summary>
    /// <param name="parentPath">The parent page's path, or <c>/</c> for a child of the root.</param>
    /// <param name="title">The item's title.</param>
    /// <param name="isTaken">Whether a path is already held by another page or a redirect.</param>
    /// <returns>An unused path.</returns>
    public static string DerivePath(string parentPath, string? title, Func<string, bool> isTaken)
    {
        ArgumentNullException.ThrowIfNull(parentPath);
        ArgumentNullException.ThrowIfNull(isTaken);

        var slug = Slugify(title);
        var candidate = parentPath + slug + "/";
        for (var attempt = 2; isTaken(candidate); attempt++)
        {
            var suffix = "-" + attempt.ToString(CultureInfo.InvariantCulture);
            candidate = parentPath + Trim(slug, MaximumSegmentLength - suffix.Length) + suffix + "/";
        }

        return candidate;
    }

    /// <summary>Trims, drops a trailing dot and lowercases a hostname; DNS names compare in lowercase.</summary>
    /// <param name="hostname">A hostname as typed or configured.</param>
    /// <returns>The normalized hostname, which may still be invalid.</returns>
    public static string NormalizeHost(string hostname)
    {
        ArgumentNullException.ThrowIfNull(hostname);
#pragma warning disable CA1308 // Justification: hostnames are canonically lowercase, and the stored form is compared against it.
        return hostname.Trim().TrimEnd('.').ToLowerInvariant();
#pragma warning restore CA1308
    }

    /// <summary>The host manifest key for one hostname, lowercase.</summary>
    /// <param name="hostname">A valid hostname.</param>
    /// <returns>The key relative to the sites bucket.</returns>
    public static string HostKey(string hostname) => "sites/_hosts/" + hostname + ".json";

    private static string Trim(string slug, int length)
    {
        var cut = slug.Length > length ? slug[..length] : slug;
        return cut.Trim('-');
    }

    [GeneratedRegex("^[a-z0-9](-?[a-z0-9]){1,39}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 250)]
    private static partial Regex SlugPattern();

    [GeneratedRegex("^/([a-z0-9][a-z0-9-]{0,79}/)*$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 250)]
    private static partial Regex PathPattern();

    [GeneratedRegex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 250)]
    private static partial Regex HostnamePattern();

    [GeneratedRegex("\\.[0-9]+$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 250)]
    private static partial Regex NumericTldPattern();

    [GeneratedRegex("^#[0-9a-f]{6}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 250)]
    private static partial Regex AccentPattern();
}

/// <summary>One link in a site's top navigation.</summary>
/// <param name="Label">The link text.</param>
/// <param name="Path">The target page path.</param>
public sealed record SiteNavLink(string Label, string Path);

/// <summary>The presentation settings of a site. Part of the build manifest, so bounded on every field.</summary>
/// <param name="Name">The site name, shown in the header and the title.</param>
/// <param name="Description">A one-line description used in meta tags.</param>
/// <param name="Accent">The accent colour as <c>#rrggbb</c>.</param>
/// <param name="Navigation">The top navigation.</param>
/// <param name="FooterText">Text shown in the footer.</param>
/// <param name="BuiltWithNix">Whether the "Built with Nix" link shows.</param>
/// <param name="Language">The language tag, for the <c>lang</c> attribute.</param>
/// <param name="Noindex">Whether search engines are asked to leave the whole site out.</param>
/// <param name="Author">The person who writes the site, for structured data; null for none.</param>
/// <param name="HeadingMark">The shape before headings and cards: <c>square</c>, <c>diamond</c> or <c>none</c>.</param>
/// <param name="Typeface">The type family: <c>rounded</c>, <c>serif</c> or <c>legible</c>.</param>
/// <param name="Spacing">The vertical rhythm: <c>compact</c>, <c>comfortable</c> or <c>airy</c>.</param>
/// <param name="ThemeItemId">The page under the site root whose files are the custom layout's theme; null for none.</param>
public sealed record SiteSettings(
    string Name,
    string Description,
    string Accent,
    IReadOnlyList<SiteNavLink> Navigation,
    string FooterText,
    bool BuiltWithNix,
    string Language,
    bool Noindex = false,
    string? Author = null,
    string HeadingMark = "square",
    string Typeface = "rounded",
    string Spacing = "comfortable",
    Guid? ThemeItemId = null)
{
    private static readonly string[] HeadingMarks = ["square", "diamond", "none"];
    private static readonly string[] Typefaces = ["rounded", "serif", "legible"];
    private static readonly string[] Spacings = ["compact", "comfortable", "airy"];

    /// <summary>The accent a new site starts with.</summary>
    public const string DefaultAccent = "#2f5fd0";

    /// <summary>Gets the settings a new site starts with.</summary>
    /// <param name="name">The site name, usually the root item's title.</param>
    /// <returns>The default settings.</returns>
    public static SiteSettings Default(string name) =>
        new(Clip(name, 120), string.Empty, DefaultAccent, [], string.Empty, BuiltWithNix: true, "en");

    /// <summary>Checks every bound; returns the first refusal, or null when the settings are acceptable.</summary>
    /// <returns>A sentence naming what is wrong, or null.</returns>
    public string? Validate()
    {
        if (string.IsNullOrWhiteSpace(Name) || Name.Length > 120 || HasControl(Name))
        {
            return "The site name must be 1 to 120 characters.";
        }

        if (Description is null || Description.Length > 500 || HasControl(Description))
        {
            return "The description may be at most 500 characters.";
        }

        if (!SiteRules.IsAccent(Accent))
        {
            return "The accent must be a lowercase #rrggbb colour.";
        }

        if (FooterText is null || FooterText.Length > 300 || HasControl(FooterText))
        {
            return "The footer text may be at most 300 characters.";
        }

        if (Language is null || Language.Length is < 2 or > 35 || !Language.All(static c => char.IsAsciiLetterOrDigit(c) || c == '-'))
        {
            return "The language must be a language tag such as 'en' or 'pt-BR'.";
        }

        if (Author is not null && (string.IsNullOrWhiteSpace(Author) || Author.Length > 120 || HasControl(Author)))
        {
            return "The author may be at most 120 characters.";
        }

        if (!HeadingMarks.Contains(HeadingMark))
        {
            return "The heading mark must be square, diamond or none.";
        }

        if (!Typefaces.Contains(Typeface))
        {
            return "The typeface must be rounded, serif or legible.";
        }

        if (!Spacings.Contains(Spacing))
        {
            return "The spacing must be compact, comfortable or airy.";
        }

        if (ThemeItemId == Guid.Empty)
        {
            return "The theme page must be an item.";
        }

        if (Navigation is null || Navigation.Count > 20)
        {
            return "A site may have at most 20 navigation links.";
        }

        foreach (var link in Navigation)
        {
            if (link is null
                || string.IsNullOrWhiteSpace(link.Label)
                || link.Label.Length > 60
                || HasControl(link.Label)
                || !SiteRules.IsPath(link.Path))
            {
                return "Each navigation link needs a label of at most 60 characters and a path like '/guide/'.";
            }
        }

        return null;
    }

    private static bool HasControl(string value) => value.Any(char.IsControl);

    private static string Clip(string? value, int length) =>
        value is null ? string.Empty : value.Length > length ? value[..length] : value;
}
