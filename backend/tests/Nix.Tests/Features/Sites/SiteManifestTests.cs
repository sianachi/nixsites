using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Nix.Domain.Items;
using Nix.Domain.Sites;
using Nix.Domain.Tenancy;
using Nix.Features.Sites;

namespace Nix.Tests.Features.Sites;

public sealed class SiteManifestTests
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    private static readonly Guid SiteId = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid BuildId = Guid.Parse("22222222-2222-4222-8222-222222222222");
    private static readonly DateTimeOffset Now = new(2026, 10, 11, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void The_build_manifest_has_the_shape_the_worker_reads()
    {
        var manifest = new SiteBuildManifest(
            1,
            SiteId,
            BuildId,
            Guid.NewGuid(),
            Guid.NewGuid(),
            "blog",
            new SiteSettingsDto("Name", "Desc", "#2f5fd0", [new SiteNavLinkDto("Home", "/")], "foot", true, "en"),
            "https://demo.sites.example.net",
            Now,
            3,
            [new SiteDatedCollectionDto(Guid.NewGuid(), "date", "tags", null, null)],
            [new SiteManifestRedirect("/old/", Guid.NewGuid())]);

        using var document = JsonDocument.Parse(JsonSerializer.Serialize(manifest, Web));
        var root = document.RootElement;

        Assert.Equal(
            ["formatVersion", "siteId", "buildId", "workspaceId", "rootItemId", "layout", "settings", "canonicalOrigin", "builtAt", "pageCount", "datedCollections", "redirects"],
            root.EnumerateObject().Select(property => property.Name).ToArray());
        Assert.Equal(
            ["name", "description", "accent", "navigation", "footerText", "builtWithNix", "language", "noindex", "author", "headingMark", "typeface", "spacing", "themeItemId"],
            root.GetProperty("settings").EnumerateObject().Select(property => property.Name).ToArray());
        Assert.Equal(
            ["itemId", "dateProperty", "tagsProperty", "coverProperty", "summaryProperty"],
            root.GetProperty("datedCollections")[0].EnumerateObject().Select(property => property.Name).ToArray());
        Assert.Equal(["from", "toItemId"], root.GetProperty("redirects")[0].EnumerateObject().Select(property => property.Name).ToArray());
        Assert.Equal(1, root.GetProperty("formatVersion").GetInt32());
    }

    [Fact]
    public void A_manifest_page_carries_its_content_position_and_nullable_snapshots()
    {
        var page = new SiteWorkerPage(
            0,
            Guid.NewGuid(),
            null,
            "/",
            "Home",
            "note",
            "42",
            Now,
            Now,
            JsonDocument.Parse("""{"title":"Home"}""").RootElement.Clone(),
            null,
            null,
            null,
            new SiteContentPosition(Guid.NewGuid(), 7),
            null,
            null,
            []);

        using var document = JsonDocument.Parse(JsonSerializer.Serialize(page, Web));
        var root = document.RootElement;

        Assert.Equal("42", root.GetProperty("seq").GetString());
        Assert.Equal(7, root.GetProperty("content").GetProperty("seq").GetInt64());
        Assert.Equal(JsonValueKind.Null, root.GetProperty("chart").ValueKind);
        Assert.Equal("Home", root.GetProperty("properties").GetProperty("title").GetString());
    }

    [Fact]
    public void A_host_manifest_binds_the_hostname_to_the_build_with_the_exact_digest()
    {
        var site = NewSite();
        var hostnames = new[]
        {
            Host("demo.sites.example.net", SiteRules.DefaultHost, verified: true),
            Host("docs.example.org", SiteRules.CustomHost, verified: true),
            Host("pending.example.org", SiteRules.CustomHost, verified: false),
        };

        site.PrimaryHostname = "docs.example.org";
        var ops = SiteHostManifests.Puts(site, BuildId, hostnames, generation: 3, Now);

        Assert.Equal(["demo.sites.example.net", "docs.example.org"], ops.Select(op => op.Hostname).ToArray());
        Assert.All(ops, op =>
        {
            Assert.Equal("put", op.Op);
            Assert.Equal($"sites/_hosts/{op.Hostname}.json", op.Key);
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(op.Body!))), op.Sha256);
            Assert.Equal(Encoding.UTF8.GetByteCount(op.Body!), op.ByteLength);
        });
        using var document = JsonDocument.Parse(ops[0].Body!);
        var root = document.RootElement;
        Assert.Equal(
            ["version", "siteId", "buildId", "generation", "buildPrefix", "assetsPrefix", "canonicalHost", "activatedAt", "redirectTo"],
            root.EnumerateObject().Select(property => property.Name).ToArray());
        Assert.Equal(BuildId, root.GetProperty("buildId").GetGuid());
        Assert.Equal(3, root.GetProperty("generation").GetInt32());
        Assert.Equal($"sites/{SiteId:D}/builds/{BuildId:D}/", root.GetProperty("buildPrefix").GetString());
        Assert.Equal($"sites/{SiteId:D}/assets/", root.GetProperty("assetsPrefix").GetString());
        Assert.Equal("docs.example.org", root.GetProperty("canonicalHost").GetString());
    }

    [Fact]
    public void Without_a_verified_custom_hostname_the_default_is_canonical_and_unpublish_deletes_each_served_host()
    {
        var site = NewSite();
        var hostnames = new[] { Host("demo.sites.example.net", SiteRules.DefaultHost, verified: true), Host("pending.example.org", SiteRules.CustomHost, verified: false) };

        var puts = SiteHostManifests.Puts(site, BuildId, hostnames, 1, Now);
        var deletes = SiteHostManifests.Deletes(hostnames);

        using var document = JsonDocument.Parse(puts.Single().Body!);
        Assert.Equal("demo.sites.example.net", document.RootElement.GetProperty("canonicalHost").GetString());
        var delete = Assert.Single(deletes);
        Assert.Equal("delete", delete.Op);
        Assert.Equal("sites/_hosts/demo.sites.example.net.json", delete.Key);
        Assert.Null(delete.Body);
    }

    [Fact]
    public void Property_images_are_found_in_strings_and_string_lists_only_once_each()
    {
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        var properties = $$"""
            {"cover":"nix-file:{{first}}","gallery":["nix-file:{{second}}","nix-file:{{first}}","https://example.test/x.png"],
             "bad":"nix-file:not-a-guid","nested":{"inner":"nix-file:{{Guid.NewGuid()}}"},"n":5}
            """;

        var found = Nix.Features.Sites.PublishSiteHandler.FileReferences(properties).ToArray();

        Assert.Equal([ItemId.From(first), ItemId.From(second)], found);
        Assert.Empty(Nix.Features.Sites.PublishSiteHandler.FileReferences("not json"));
        Assert.Empty(Nix.Features.Sites.PublishSiteHandler.FileReferences("[1,2]"));
    }

    private static Site NewSite() => new()
    {
        TenantId = TenantId.From(Guid.NewGuid()),
        Id = SiteId,
        WorkspaceId = WorkspaceId.From(Guid.NewGuid()),
        RootItemId = ItemId.From(Guid.NewGuid()),
        Slug = "demo",
        CreatedBy = Nix.Domain.Identity.PrincipalId.From(Guid.NewGuid()),
        CreatedAt = Now,
        UpdatedAt = Now,
    };

    private static SiteHostname Host(string hostname, string kind, bool verified) => new()
    {
        TenantId = TenantId.From(Guid.NewGuid()),
        Hostname = hostname,
        SiteId = SiteId,
        Kind = kind,
        VerifiedAt = verified ? Now : null,
        CreatedAt = Now,
    };
}
