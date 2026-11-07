using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using Nix.Abstractions.Files;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// [SEC] File download links over the real pipeline: a revoked version never gets a new link by
/// default, a workspace Owner may ask for one explicitly (audited, restricted by credential), and
/// the link names exactly the version, expiry and metadata the response claims. URLs are parsed in
/// place and never printed or stored.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class FileDownloadRevocationTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private const int CapabilitySeconds = 120;
    private const string RevokedAction = "file_version.revoked_download_authorized";

    private SiteHttpHost _host = null!;
    private string _ownerSession = null!;
    private string _ownerAdmin = null!;
    private string _ownerWrite = null!;
    private string _editor = null!;
    private string _viewer = null!;
    private string _outsider = null!;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await SiteScenario.SeedPeopleAsync(fixture);
        _host = SiteHttpHost.Create(fixture, new Dictionary<string, string?> { ["Nix:ObjectStorage:CapabilitySeconds"] = CapabilitySeconds.ToString(System.Globalization.CultureInfo.InvariantCulture) });
        _ownerSession = await _host.InteractiveTokenAsync(SiteScenario.Manager);
        _ownerAdmin = await _host.TokenAsync(SiteScenario.Manager, admin: true);
        _ownerWrite = await _host.TokenAsync(SiteScenario.Manager, admin: false);
        // The editor's token holds the admin scope on purpose: the role, not the scope, is what refuses.
        _editor = await _host.TokenAsync(SiteScenario.EditorContext, admin: true);
        _viewer = await _host.TokenAsync(SiteScenario.ViewerContext, admin: false);
        _outsider = await _host.TokenAsync(SiteScenario.OutsiderContext, admin: false);
    }

    public async ValueTask DisposeAsync() => await _host.DisposeAsync();

    [Fact]
    public async Task A_viewer_downloads_an_approved_version_and_a_non_member_gets_404()
    {
        var file = await UploadAsync("viewer", 1);
        await SetStateAsync(file.Versions[0], "approved");

        using (var ok = await DownloadAsync(file, _viewer))
        {
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            using var body = await SiteHttpHost.JsonAsync(ok);
            Assert.Equal(file.Versions[0], body.RootElement.GetProperty("versionId").GetGuid());
        }

        using var hidden = await DownloadAsync(file, _outsider);
        Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
        Assert.Equal("files.not_found", await ProblemCodeAsync(hidden));
    }

    [Fact]
    public async Task Naming_a_revoked_version_is_410_for_an_editor_and_includeRevoked_is_403_for_them()
    {
        var file = await UploadAsync("editor", 2);
        await SetStateAsync(file.Versions[0], "revoked");
        await SetStateAsync(file.Versions[1], "approved");

        using (var gone = await DownloadAsync(file, _editor, file.Versions[0]))
        {
            Assert.Equal(HttpStatusCode.Gone, gone.StatusCode);
            Assert.Equal("files.version_revoked", await ProblemCodeAsync(gone));
            Assert.Contains("revoked", await gone.Content.ReadAsStringAsync(Cancellation), StringComparison.Ordinal);
        }

        using (var forbidden = await DownloadAsync(file, _editor, file.Versions[0], includeRevoked: true))
        {
            Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
            Assert.Equal("files.revoked_download_forbidden", await ProblemCodeAsync(forbidden));
        }

        Assert.Equal(0, await AuditCountAsync(file.Versions[0]));
    }

    [Fact]
    public async Task A_revoked_version_has_no_thumbnail_link_either()
    {
        var file = await UploadAsync("thumbnail", 2);
        await MigratorAsync($"UPDATE file_version SET thumbnail_width = 40, thumbnail_height = 60, thumbnail_bytes = 100 WHERE item_id = '{file.ItemId}'");
        await SetStateAsync(file.Versions[0], "revoked");
        await SetStateAsync(file.Versions[1], "approved");

        using (var gone = await _host.SendAsync(HttpMethod.Get, $"/api/v1/items/{file.ItemId:D}/file/thumbnail?versionId={file.Versions[0]:D}", _viewer))
        {
            Assert.Equal(HttpStatusCode.Gone, gone.StatusCode);
            Assert.Equal("files.version_revoked", await ProblemCodeAsync(gone));
        }

        using var live = await _host.SendAsync(HttpMethod.Get, $"/api/v1/items/{file.ItemId:D}/file/thumbnail?versionId={file.Versions[1]:D}", _viewer);
        Assert.Equal(HttpStatusCode.OK, live.StatusCode);
    }

    [Fact]
    public async Task An_owner_on_a_browser_session_gets_the_revoked_link_marked_and_audited_once_without_the_url()
    {
        var file = await UploadAsync("owner-session", 2);
        await SetStateAsync(file.Versions[0], "revoked");
        await SetStateAsync(file.Versions[1], "approved");

        using (var ok = await DownloadAsync(file, _ownerSession, file.Versions[0], includeRevoked: true))
        {
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            using var body = await SiteHttpHost.JsonAsync(ok);
            Assert.True(body.RootElement.GetProperty("revoked").GetBoolean());
            Assert.Equal(file.Versions[0], body.RootElement.GetProperty("versionId").GetGuid());
            Assert.EndsWith("/" + await ObjectKeyAsync(file.Versions[0]), Uri.UnescapeDataString(new Uri(body.RootElement.GetProperty("url").GetString()!).AbsolutePath), StringComparison.Ordinal);
        }

        Assert.Equal(1, await AuditCountAsync(file.Versions[0]));
        var after = await AuditAfterAsync(file.Versions[0]);
        using (var json = JsonDocument.Parse(after))
        {
            Assert.Equal("browser_session", json.RootElement.GetProperty("credential").GetString());
        }

        // The event is the whole record: no URL, host, signature or key anywhere in the audit table.
        Assert.DoesNotContain("X-Amz", after, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("http", after, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(0, await MigratorCountAsync("SELECT count(*) FROM audit_event WHERE before::text ILIKE '%X-Amz%' OR after::text ILIKE '%X-Amz%' OR before::text ILIKE '%127.0.0.1%' OR after::text ILIKE '%127.0.0.1%'"));

        // Without the flag the same version is still gone, and an approved one flagged is neither marked nor audited.
        using (var gone = await DownloadAsync(file, _ownerSession, file.Versions[0]))
        {
            Assert.Equal(HttpStatusCode.Gone, gone.StatusCode);
        }

        using (var approved = await DownloadAsync(file, _ownerSession, file.Versions[1], includeRevoked: true))
        {
            Assert.Equal(HttpStatusCode.OK, approved.StatusCode);
            using var body = await SiteHttpHost.JsonAsync(approved);
            Assert.False(body.RootElement.TryGetProperty("revoked", out var marker) && marker.ValueKind == JsonValueKind.True);
        }

        Assert.Equal(1, await MigratorCountAsync($"SELECT count(*) FROM audit_event WHERE action = '{RevokedAction}'"));
    }

    [Fact]
    public async Task An_owner_with_an_admin_scope_token_gets_the_same_and_a_write_scope_token_gets_403()
    {
        var file = await UploadAsync("owner-token", 2);
        await SetStateAsync(file.Versions[0], "revoked");
        await SetStateAsync(file.Versions[1], "approved");

        using (var forbidden = await DownloadAsync(file, _ownerWrite, file.Versions[0], includeRevoked: true))
        {
            Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
            Assert.Equal("files.revoked_download_forbidden", await ProblemCodeAsync(forbidden));
        }

        Assert.Equal(0, await AuditCountAsync(file.Versions[0]));

        using (var ok = await DownloadAsync(file, _ownerAdmin, file.Versions[0], includeRevoked: true))
        {
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            using var body = await SiteHttpHost.JsonAsync(ok);
            Assert.True(body.RootElement.GetProperty("revoked").GetBoolean());
        }

        Assert.Equal(1, await AuditCountAsync(file.Versions[0]));
        using var json = JsonDocument.Parse(await AuditAfterAsync(file.Versions[0]));
        Assert.Equal("access_token", json.RootElement.GetProperty("credential").GetString());
    }

    [Fact]
    public async Task A_default_download_skips_a_revoked_current_version_and_with_every_version_revoked_it_is_404()
    {
        var file = await UploadAsync("default", 3);
        await SetStateAsync(file.Versions[2], "revoked");

        using (var skipped = await DownloadAsync(file, _viewer))
        {
            Assert.Equal(HttpStatusCode.OK, skipped.StatusCode);
            using var body = await SiteHttpHost.JsonAsync(skipped);
            Assert.Equal(file.Versions[1], body.RootElement.GetProperty("versionId").GetGuid());
        }

        await SetStateAsync(file.Versions[0], "revoked");
        await SetStateAsync(file.Versions[1], "revoked");
        using var none = await DownloadAsync(file, _viewer);
        Assert.Equal(HttpStatusCode.NotFound, none.StatusCode);
        Assert.Equal("files.no_servable_version", await ProblemCodeAsync(none));

        // A caller who cannot read the file is not told that it exists.
        using var hidden = await DownloadAsync(file, _outsider);
        Assert.Equal("files.not_found", await ProblemCodeAsync(hidden));

        // The default path never honours the diagnostic flag either: nothing is shown to name.
        using var owner = await DownloadAsync(file, _ownerSession, includeRevoked: true);
        Assert.Equal(HttpStatusCode.NotFound, owner.StatusCode);
    }

    [Fact]
    public async Task The_link_expires_within_the_configured_capability_seconds()
    {
        var file = await UploadAsync("expiry", 1);
        await SetStateAsync(file.Versions[0], "approved");

        using var response = await DownloadAsync(file, _viewer);
        using var body = await SiteHttpHost.JsonAsync(response);
        var expiresAt = body.RootElement.GetProperty("expiresAt").GetDateTimeOffset();
        Assert.InRange((expiresAt - DateTimeOffset.UtcNow).TotalSeconds, 0, CapabilitySeconds);
        var query = QueryHelpers.ParseQuery(new Uri(body.RootElement.GetProperty("url").GetString()!).Query);
        Assert.Equal(CapabilitySeconds.ToString(System.Globalization.CultureInfo.InvariantCulture), query["X-Amz-Expires"].ToString());
    }

    [Fact]
    public async Task Naming_an_older_version_signs_that_versions_object_and_reports_its_checksum_and_length()
    {
        var file = await UploadAsync("exact", 2);
        await SetStateAsync(file.Versions[0], "approved");
        await SetStateAsync(file.Versions[1], "approved");

        using var response = await DownloadAsync(file, _viewer, file.Versions[0]);
        using var body = await SiteHttpHost.JsonAsync(response);
        Assert.Equal(file.Versions[0], body.RootElement.GetProperty("versionId").GetGuid());
        var path = Uri.UnescapeDataString(new Uri(body.RootElement.GetProperty("url").GetString()!).AbsolutePath);
        Assert.EndsWith("/" + await ObjectKeyAsync(file.Versions[0]), path, StringComparison.Ordinal);
        Assert.DoesNotContain(await ObjectKeyAsync(file.Versions[1]), path, StringComparison.Ordinal);

        // The response carries the named version's stored values, not the latest's.
        Assert.Equal(Sha(0), body.RootElement.GetProperty("sha256").GetString());
        Assert.Equal(Length(0), body.RootElement.GetProperty("byteLength").GetInt64());
        Assert.Equal(Sha(0), await MigratorTextAsync($"SELECT sha256 FROM file_version WHERE file_version_id = '{file.Versions[0]}'"));
        Assert.Equal(Length(0), await MigratorCountAsync($"SELECT byte_length FROM file_version WHERE file_version_id = '{file.Versions[0]}'"));
    }

    [Fact]
    public async Task A_pdf_is_served_as_octet_stream_for_download_and_as_itself_for_preview()
    {
        var file = await UploadAsync("metadata", 1);
        await SetStateAsync(file.Versions[0], "approved");

        using (var download = await DownloadAsync(file, _viewer))
        {
            using var body = await SiteHttpHost.JsonAsync(download);
            Assert.Equal("application/octet-stream", body.RootElement.GetProperty("mediaType").GetString());
            Assert.Equal("application/pdf", body.RootElement.GetProperty("storedMediaType").GetString());
            Assert.True(body.RootElement.GetProperty("unscanned").GetBoolean());
            Assert.False(body.RootElement.GetProperty("inline").GetBoolean());
        }

        using var preview = await _host.SendAsync(HttpMethod.Get, $"/api/v1/items/{file.ItemId:D}/file/download?preview=true", _viewer);
        using var previewBody = await SiteHttpHost.JsonAsync(preview);
        Assert.Equal("application/pdf", previewBody.RootElement.GetProperty("mediaType").GetString());
        Assert.Equal("application/pdf", previewBody.RootElement.GetProperty("storedMediaType").GetString());
    }

    private static string Sha(int index) => new((char)('a' + index), 64);

    private static long Length(int index) => 100 + index;

    private sealed record Uploaded(Guid ItemId, Guid[] Versions);

    private Task<HttpResponseMessage> DownloadAsync(Uploaded file, string bearer, Guid? versionId = null, bool includeRevoked = false) =>
        _host.SendAsync(
            HttpMethod.Get,
            $"/api/v1/items/{file.ItemId:D}/file/download" + (versionId is { } id ? $"?preview=false&versionId={id:D}" : "?preview=false") + (includeRevoked ? "&includeRevoked=true" : string.Empty),
            bearer);

    private static async Task<string?> ProblemCodeAsync(HttpResponseMessage response)
    {
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.TryGetProperty("code", out var code) ? code.GetString() : null;
    }

    private async Task<Uploaded> UploadAsync(string key, int versions)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var files = work.Resolve<IFileStore>();
        Guid? itemId = null;
        var ids = new List<Guid>();
        for (var index = 0; index < versions; index++)
        {
            var begun = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
                new BeginFileUpload(
                    WorkspaceId.From(TestTenants.AlphaWorkspace),
                    null,
                    itemId is { } target ? ItemId.From(target) : null,
                    "doc.pdf",
                    "application/pdf",
                    Length(index),
                    $"download-revocation-{key}-{index}"),
                Cancellation));
            Assert.NotNull(await files.QueueInspectionAsync(FileUploadId.From(begun.Id), Cancellation));
            var published = Assert.IsType<FileRecord>(await files.CompleteAsync(
                new CompleteFileUpload(FileUploadId.From(begun.Id), "application/pdf", Length(index), Sha(index), Previewable: true, PixelWidth: null, PixelHeight: null),
                Cancellation));
            itemId = published.ItemId;
            ids.Add(published.Current.Id);
        }

        await work.CommitAsync(Cancellation);
        return new Uploaded(itemId!.Value, [.. ids]);
    }

    private Task SetStateAsync(Guid versionId, string state) =>
        MigratorAsync($"UPDATE file_version SET state = '{state}', state_changed_at = now() WHERE file_version_id = '{versionId}'");

    private Task<long> AuditCountAsync(Guid versionId) =>
        MigratorCountAsync($"SELECT count(*) FROM audit_event WHERE action = '{RevokedAction}' AND subject_id = '{versionId}'");

    private Task<string> AuditAfterAsync(Guid versionId) =>
        MigratorTextAsync($"SELECT after::text FROM audit_event WHERE action = '{RevokedAction}' AND subject_id = '{versionId}'");

    private Task<string> ObjectKeyAsync(Guid versionId) =>
        MigratorTextAsync($"SELECT object_key FROM file_version WHERE file_version_id = '{versionId}'");

    private async Task<long> MigratorCountAsync(string sql)
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
#pragma warning disable CA2100 // Static test text with test-owned ids.
        await using var command = new NpgsqlCommand(sql, connection);
#pragma warning restore CA2100
        return Convert.ToInt64(await command.ExecuteScalarAsync(Cancellation), System.Globalization.CultureInfo.InvariantCulture);
    }

    private async Task<string> MigratorTextAsync(string sql)
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
#pragma warning disable CA2100 // Static test text with test-owned ids.
        await using var command = new NpgsqlCommand(sql, connection);
#pragma warning restore CA2100
        return (string)(await command.ExecuteScalarAsync(Cancellation))!;
    }

    private async Task MigratorAsync(string sql)
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
#pragma warning disable CA2100 // Static test text with test-owned ids.
        await using var command = new NpgsqlCommand(sql, connection);
#pragma warning restore CA2100
        await command.ExecuteNonQueryAsync(Cancellation);
    }
}
