using Nix.Domain.Sites;
using Nix.Features.Sites;

namespace Nix.Tests.Features.Sites;

public sealed class SiteSettingsTests
{
    private static readonly System.Text.Json.JsonSerializerOptions WebJson = new(System.Text.Json.JsonSerializerDefaults.Web);

    [Fact]
    public void The_default_settings_are_valid_and_carry_the_root_title()
    {
        var settings = SiteSettings.Default("Nix Docs");

        Assert.Null(settings.Validate());
        Assert.Equal("Nix Docs", settings.Name);
        Assert.True(settings.BuiltWithNix);
    }

    [Fact]
    public void A_very_long_default_name_is_clipped_not_refused()
    {
        Assert.Null(SiteSettings.Default(new string('x', 400)).Validate());
    }

    [Fact]
    public void Every_bound_is_checked()
    {
        var valid = SiteSettings.Default("Docs");

        Assert.NotNull((valid with { Name = " " }).Validate());
        Assert.NotNull((valid with { Name = new string('x', 121) }).Validate());
        Assert.NotNull((valid with { Description = new string('x', 501) }).Validate());
        Assert.NotNull((valid with { Accent = "blue" }).Validate());
        Assert.NotNull((valid with { FooterText = new string('x', 301) }).Validate());
        Assert.NotNull((valid with { Language = "en us" }).Validate());
        Assert.NotNull((valid with { Name = "bad\nname" }).Validate());
        Assert.NotNull((valid with { Navigation = [.. Enumerable.Range(0, 21).Select(i => new SiteNavLink("l" + i, "/a/"))] }).Validate());
        Assert.NotNull((valid with { Navigation = [new SiteNavLink("Home", "home")] }).Validate());
        Assert.NotNull((valid with { Navigation = [new SiteNavLink(string.Empty, "/home/")] }).Validate());
        Assert.Null((valid with { Navigation = [new SiteNavLink("Home", "/")] }).Validate());
        Assert.NotNull((valid with { Author = new string('x', 121) }).Validate());
        Assert.NotNull((valid with { Author = "bad\nauthor" }).Validate());
        Assert.Null((valid with { Author = "Ada Writer", Noindex = true }).Validate());
    }

    [Fact]
    public void A_new_site_is_indexable_and_names_no_author()
    {
        var settings = SiteSettings.Default("Docs");

        Assert.False(settings.Noindex);
        Assert.Null(settings.Author);
    }

    [Fact]
    public void Noindex_and_author_survive_the_checker_and_a_stored_document_without_them_reads_as_off()
    {
        var checkedSettings = SiteViews.CheckSettings(new SiteSettingsDto(
            "Docs", "d", "#2f5fd0", [], "f", true, "en", Noindex: true, Author: "  Ada Writer  "));
        Assert.True(checkedSettings.IsSuccess);
        Assert.True(checkedSettings.Value.Noindex);
        Assert.Equal("Ada Writer", checkedSettings.Value.Author);

        var blank = SiteViews.CheckSettings(new SiteSettingsDto("Docs", "d", "#2f5fd0", [], "f", true, "en", Author: " "));
        Assert.Null(blank.Value.Author);

        var stored = System.Text.Json.JsonSerializer.Deserialize<SiteSettingsDto>(
            """{"name":"Docs","description":"","accent":"#2f5fd0","navigation":[],"footerText":"","builtWithNix":true,"language":"en"}""",
            WebJson);
        Assert.False(stored!.Noindex);
        Assert.Null(stored.Author);
        Assert.Equal("square", stored.HeadingMark);
        Assert.Equal("rounded", stored.Typeface);
        Assert.Equal("comfortable", stored.Spacing);
    }

    [Fact]
    public void Style_choices_are_kept_and_unknown_ones_refused()
    {
        var chosen = SiteViews.CheckSettings(new SiteSettingsDto(
            "Docs", "d", "#2f5fd0", [], "f", true, "en", HeadingMark: "diamond", Typeface: "serif", Spacing: "airy"));
        Assert.True(chosen.IsSuccess);
        Assert.Equal(("diamond", "serif", "airy"), (chosen.Value.HeadingMark, chosen.Value.Typeface, chosen.Value.Spacing));

        Assert.True(SiteViews.CheckSettings(new SiteSettingsDto("Docs", "d", "#2f5fd0", [], "f", true, "en", HeadingMark: "star")).IsFailure);
        Assert.True(SiteViews.CheckSettings(new SiteSettingsDto("Docs", "d", "#2f5fd0", [], "f", true, "en", Typeface: "comic")).IsFailure);
        Assert.True(SiteViews.CheckSettings(new SiteSettingsDto("Docs", "d", "#2f5fd0", [], "f", true, "en", Spacing: "huge")).IsFailure);
    }

    [Fact]
    public void A_custom_layout_needs_a_theme_page_and_other_layouts_ignore_it()
    {
        var theme = Guid.NewGuid();
        Assert.True(SiteRules.IsLayout("custom"));
        Assert.NotNull(SiteRules.ThemeRefusal("custom", null));
        Assert.Null(SiteRules.ThemeRefusal("custom", theme));
        Assert.Null(SiteRules.ThemeRefusal("docs", null));
        Assert.Null(SiteRules.ThemeRefusal("blog", theme));

        var kept = SiteViews.CheckSettings(new SiteSettingsDto("Docs", "d", "#2f5fd0", [], "f", true, "en", ThemeItemId: theme));
        Assert.Equal(theme, kept.Value.ThemeItemId);
        Assert.True(SiteViews.CheckSettings(new SiteSettingsDto("Docs", "d", "#2f5fd0", [], "f", true, "en", ThemeItemId: Guid.Empty)).IsFailure);
    }

    [Fact]
    public void Settings_are_normalized_by_the_checker_the_endpoints_use()
    {
        var checkedSettings = SiteViews.CheckSettings(new SiteSettingsDto(
            "  Docs  ", "d", "#2f5fd0", [new SiteNavLinkDto("Guide", "/guide/")], "f", BuiltWithNix: false, "en"));

        Assert.True(checkedSettings.IsSuccess);
        Assert.Equal("Docs", checkedSettings.Value.Name);
        Assert.False(checkedSettings.Value.BuiltWithNix);
        Assert.True(SiteViews.CheckSettings(null).IsFailure);
        Assert.Equal(
            SiteErrors.InvalidCode,
            SiteViews.CheckSettings(new SiteSettingsDto("n", "d", "nope", [], "f", true, "en")).Error.Code);
    }

    [Theory]
    [InlineData(SiteErrors.NotFoundCode, 404)]
    [InlineData(SiteErrors.ItemNotFoundCode, 404)]
    [InlineData(SiteErrors.ManagerRequiredCode, 403)]
    [InlineData(SiteErrors.NotConfiguredCode, 503)]
    [InlineData(SiteErrors.InvalidCode, 422)]
    [InlineData(SiteErrors.DisclosureRequiredCode, 422)]
    [InlineData(SiteErrors.TooManyPagesCode, 422)]
    [InlineData(SiteErrors.RootLockedCode, 409)]
    [InlineData(SiteErrors.SlugTakenCode, 409)]
    [InlineData(SiteErrors.BuildInProgressCode, 409)]
    [InlineData(SiteErrors.PathTakenCode, 409)]
    public void Each_failure_code_is_published_with_its_status(string code, int status)
    {
        Assert.Equal(status, SiteErrors.StatusFor(code));
    }
}
