using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Web;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Features.Items;
using Nix.Features.PublicLinks;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// [SEC] Public file links through the real pipeline against Postgres: the fixed version rule, every
/// way a link dies, the token gate and the Viewer-only service principal.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class PublicLinkTests : IAsyncLifetime
{
    private static readonly M0TenantRows Alpha = M0SchemaSeed.Alpha;
    private static readonly M0TenantRows Beta = M0SchemaSeed.Beta;
    private readonly NixPostgresFixture _fixture;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;
    private string _admin = null!;

    public PublicLinkTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        (_factory, _client) = Build(enabled: true);
        _admin = await AdminTokenAsync(_client);
        await Sql($"UPDATE workspace SET agents_may_create_public_links = true WHERE workspace_id = '{Alpha.WorkspaceId}'");
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task A_file_link_stays_on_its_version_after_a_new_upload_and_a_new_approval()
    {
        var file = await NewFileAsync();
        var approved = await AddVersionAsync(file, 1, "approved");
        var link = await PutAsync(file);
        Assert.Equal(approved, link.VersionId);
        Assert.Equal("approved", link.VersionState);

        await AddVersionAsync(file, 2, "draft");
        await AddVersionAsync(file, 3, "approved");

        using var read = await _client.GetAsync(new Uri($"/public/v1/links/{link.Token}", UriKind.Relative), Cancellation);
        Assert.Equal(HttpStatusCode.OK, read.StatusCode);
        var body = await ReadJsonAsync(read);
        Assert.Equal("file", body.GetProperty("kind").GetString());
        Assert.Contains($"{file}/1", body.GetProperty("url").GetString(), StringComparison.Ordinal);
        Assert.DoesNotContain($"{file}/3", body.GetProperty("url").GetString(), StringComparison.Ordinal);

        using var stateAgain = await Send(HttpMethod.Get, $"/api/v1/items/{file}/public-link");
        Assert.Equal(approved, (await ReadJsonAsync(stateAgain)).GetProperty("versionId").GetGuid());
    }

    [Fact]
    public async Task A_file_with_no_approved_version_is_refused_unless_a_version_is_named_and_a_draft_reports_its_state()
    {
        var file = await NewFileAsync();
        var draft = await AddVersionAsync(file, 1, "draft");

        using (var refused = await Send(HttpMethod.Put, $"/api/v1/items/{file}/public-link", new { }))
        {
            Assert.Equal(HttpStatusCode.UnprocessableEntity, refused.StatusCode);
            Assert.Equal("public_links.no_approved_version", await ProblemCodeAsync(refused));
        }

        var link = await PutAsync(file, new { versionId = draft });
        Assert.Equal(draft, link.VersionId);
        Assert.Equal("draft", link.VersionState);
    }

    [Fact]
    public async Task A_version_of_another_file_cannot_be_named()
    {
        var file = await NewFileAsync();
        await AddVersionAsync(file, 1, "approved");
        var other = await NewFileAsync();
        var foreign = await AddVersionAsync(other, 1, "approved");

        using var refused = await Send(HttpMethod.Put, $"/api/v1/items/{file}/public-link", new { versionId = foreign });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, refused.StatusCode);
    }

    [Fact]
    public async Task Putting_again_replaces_the_link_and_the_old_url_dies()
    {
        var file = await NewFileAsync();
        await AddVersionAsync(file, 1, "approved");
        var first = await PutAsync(file);
        var second = await PutAsync(file);

        Assert.NotEqual(first.Token, second.Token);
        Assert.Equal(HttpStatusCode.NotFound, await ReadStatusAsync(first.Token));
        Assert.Equal(HttpStatusCode.OK, await ReadStatusAsync(second.Token));
        Assert.Equal("1", await Scalar($"SELECT count(*) FROM public_link WHERE item_id = '{file}' AND revoked_at IS NULL"));
        Assert.Equal("1", await Scalar($"SELECT count(DISTINCT service_principal_id) FROM public_link WHERE item_id = '{file}'"));
    }

    [Fact]
    public async Task Revoking_stops_the_link_at_once_and_writes_audit_events()
    {
        var file = await NewFileAsync();
        await AddVersionAsync(file, 1, "approved");
        var link = await PutAsync(file);

        using (var revoked = await Send(HttpMethod.Delete, $"/api/v1/items/{file}/public-link"))
        {
            Assert.Equal(HttpStatusCode.NoContent, revoked.StatusCode);
        }

        Assert.Equal(HttpStatusCode.NotFound, await ReadStatusAsync(link.Token));
        using (var gone = await Send(HttpMethod.Get, $"/api/v1/items/{file}/public-link"))
        {
            Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
        }

        Assert.Equal("1", await Scalar("SELECT count(*) FROM audit_event WHERE action = 'public_link.created'"));
        Assert.Equal("1", await Scalar("SELECT count(*) FROM audit_event WHERE action = 'public_link.revoked'"));
    }

    [Fact]
    public async Task A_lock_on_the_item_or_an_ancestor_stops_a_link_and_refuses_a_new_one()
    {
        var file = await NewFileAsync();
        await AddVersionAsync(file, 1, "approved");
        var link = await PutAsync(file);

        await Sql(LockSql(Alpha.ItemId));
        Assert.Equal(HttpStatusCode.NotFound, await ReadStatusAsync(link.Token));
        using (var refused = await Send(HttpMethod.Put, $"/api/v1/items/{file}/public-link", new { }))
        {
            Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        }

        await Sql($"DELETE FROM item_lock WHERE item_id = '{Alpha.ItemId}'");
        Assert.Equal(HttpStatusCode.OK, await ReadStatusAsync(link.Token));
    }

    [Fact]
    public async Task A_trashed_ancestor_stops_the_link()
    {
        var file = await NewFileAsync();
        await AddVersionAsync(file, 1, "approved");
        var link = await PutAsync(file);

        await Sql($"UPDATE item SET lifecycle_state = 'deleted', purge_after = now() + interval '30 days' WHERE id = '{Alpha.ItemId}'");

        Assert.Equal(HttpStatusCode.NotFound, await ReadStatusAsync(link.Token));
    }

    [Fact]
    public async Task A_revoked_version_or_an_unpublished_object_stops_the_link()
    {
        var file = await NewFileAsync();
        var version = await AddVersionAsync(file, 1, "approved");
        var link = await PutAsync(file);

        await Sql($"UPDATE file_version SET state = 'revoked' WHERE file_version_id = '{version}'");
        Assert.Equal(HttpStatusCode.NotFound, await ReadStatusAsync(link.Token));

        await Sql($"UPDATE file_version SET state = 'approved', object_ready = false WHERE file_version_id = '{version}'");
        Assert.Equal(HttpStatusCode.NotFound, await ReadStatusAsync(link.Token));
    }

    [Fact]
    public async Task Trashing_an_ancestor_ends_the_link_and_restoring_does_not_revive_it()
    {
        var file = await NewFileAsync();
        await AddVersionAsync(file, 1, "approved");
        var link = await PutAsync(file);

        await using (var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var deleted = await work.Resolve<NixDispatcher>().SendAsync<DeleteItem, ItemId>(new DeleteItem(ItemId.From(Alpha.ItemId)), Cancellation);
            Assert.True(deleted.IsSuccess);
            await work.CommitAsync(Cancellation);
        }

        await using (var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var restored = await work.Resolve<NixDispatcher>().SendAsync<RestoreItem, Item>(new RestoreItem(ItemId.From(Alpha.ItemId)), Cancellation);
            Assert.True(restored.IsSuccess);
            await work.CommitAsync(Cancellation);
        }

        Assert.Equal(HttpStatusCode.NotFound, await ReadStatusAsync(link.Token));
        Assert.Equal("1", await Scalar($"SELECT count(*) FROM public_link WHERE item_id = '{file}' AND revoked_at IS NOT NULL"));
    }

    [Fact]
    public async Task With_the_install_flag_off_every_route_refuses_and_a_live_link_stops()
    {
        var file = await NewFileAsync();
        await AddVersionAsync(file, 1, "approved");
        var link = await PutAsync(file);

        var (off, client) = Build(enabled: false);
        await using (off.ConfigureAwait(false))
        using (client)
        {
            var admin = await AdminTokenAsync(client);
            foreach (var method in new[] { HttpMethod.Get, HttpMethod.Put, HttpMethod.Delete })
            {
                using var request = new HttpRequestMessage(method, $"/api/v1/items/{file}/public-link");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", admin);
                if (method == HttpMethod.Put)
                {
                    request.Content = JsonContent.Create(new { });
                }

                using var response = await client.SendAsync(request, Cancellation);
                Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
                Assert.Equal("public_links.disabled", await ProblemCodeAsync(response));
            }

            using var read = await client.GetAsync(new Uri($"/public/v1/links/{link.Token}", UriKind.Relative), Cancellation);
            Assert.Equal(HttpStatusCode.NotFound, read.StatusCode);
        }
    }

    [Fact]
    public async Task Only_notes_and_files_can_have_a_link()
    {
        using var response = await Send(HttpMethod.Put, $"/api/v1/items/{Alpha.ItemId}/public-link", new { });

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        Assert.Equal("public_links.unsupported_type", await ProblemCodeAsync(response));
    }

    [Fact]
    public async Task A_token_session_needs_the_workspace_switch_on()
    {
        var file = await NewFileAsync();
        await AddVersionAsync(file, 1, "approved");

        await Sql($"UPDATE workspace SET agents_may_create_public_links = false WHERE workspace_id = '{Alpha.WorkspaceId}'");
        using (var denied = await Send(HttpMethod.Put, $"/api/v1/items/{file}/public-link", new { }))
        {
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        }

        await Sql($"UPDATE workspace SET agents_may_create_public_links = true WHERE workspace_id = '{Alpha.WorkspaceId}'");
        using var allowed = await Send(HttpMethod.Put, $"/api/v1/items/{file}/public-link", new { });
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
    }

    [Fact]
    public async Task The_service_principal_is_a_viewer_never_an_editor()
    {
        var file = await NewFileAsync();
        await AddVersionAsync(file, 1, "approved");
        await PutAsync(file);

        Assert.Equal(
            "viewer|service",
            await Scalar(
                $"""
                SELECT m.role || '|' || p.kind
                FROM public_link l
                JOIN workspace_member m ON m.subject_id = l.service_principal_id AND m.workspace_id = l.workspace_id
                JOIN principal p ON p.principal_id = l.service_principal_id
                WHERE l.item_id = '{file}'
                """));
    }

    [Fact]
    public async Task Every_dead_link_answers_the_same_and_the_live_one_carries_the_privacy_headers()
    {
        var file = await NewFileAsync();
        await AddVersionAsync(file, 1, "approved");
        var live = await PutAsync(file);
        var tampered = live.Token[..^2] + (live.Token[^2] == 'A' ? "B" : "A") + live.Token[^1];
        var payloadTampered = (live.Token[0] == 'A' ? "B" : "A") + live.Token[1..];
        var revoked = (await PutAsync(file)).Token;
        var current = (await PutAsync(file)).Token; // `revoked` is now the replaced one

        var answers = new List<(HttpStatusCode Status, string Body, string? Cache)>();
        foreach (var token in new[] { tampered, payloadTampered, revoked, live.Token, "garbage", "a.b" })
        {
            using var response = await _client.GetAsync(new Uri($"/public/v1/links/{token}", UriKind.Relative), Cancellation);
            // The shared problem-details body carries per-request traceId and instance; the rest must match.
            var problem = await ReadJsonAsync(response);
            var shape = string.Join(
                "|",
                problem.EnumerateObject()
                    .Where(property => property.Name is not ("traceId" or "instance"))
                    .Select(property => $"{property.Name}={property.Value}"));
            answers.Add((
                response.StatusCode,
                shape,
                response.Headers.CacheControl?.ToString()));
            Assert.Equal("noindex", response.Headers.GetValues("X-Robots-Tag").Single());
            Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
        }

        Assert.All(answers, answer => Assert.Equal(HttpStatusCode.NotFound, answer.Status));
        Assert.Single(answers.Select(answer => answer.Body).Distinct());
        Assert.All(answers, answer => Assert.Equal("no-store", answer.Cache));

        using var ok = await _client.GetAsync(new Uri($"/public/v1/links/{current}", UriKind.Relative), Cancellation);
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal("no-store", ok.Headers.CacheControl?.ToString());
        Assert.Equal("noindex", ok.Headers.GetValues("X-Robots-Tag").Single());
    }

    [Fact]
    public async Task A_form_token_never_verifies_as_a_link_token()
    {
        var forms = _factory.Services.GetRequiredService<Nix.Features.Views.PublicFormTokenService>();
        var file = await NewFileAsync();
        await AddVersionAsync(file, 1, "approved");
        var link = await PutAsync(file);
        var linkId = Guid.Parse(await Scalar($"SELECT id FROM public_link WHERE item_id = '{file}' AND revoked_at IS NULL") ?? string.Empty);
        var nonce = await Scalar($"SELECT nonce FROM public_link WHERE id = '{linkId}'");

        var formToken = forms.Create(
            Nix.Domain.Tenancy.TenantId.From(TestTenants.Alpha),
            linkId,
            PrincipalId.From(Guid.Parse(await Scalar($"SELECT service_principal_id FROM public_link WHERE id = '{linkId}'") ?? string.Empty)),
            nonce!);

        Assert.NotEqual(link.Token, formToken);
        Assert.Equal(HttpStatusCode.NotFound, await ReadStatusAsync(formToken));
    }

    [Fact]
    public async Task A_signed_url_lives_at_most_sixty_seconds_is_never_cached_and_svg_is_forced_to_download()
    {
        var pdf = await NewFileAsync();
        await AddVersionAsync(pdf, 1, "approved", "application/pdf");
        var svg = await NewFileAsync();
        await AddVersionAsync(svg, 1, "approved", "image/svg+xml");

        var pdfUrl = (await ReadJsonAsync(await GetPublicAsync((await PutAsync(pdf)).Token))).GetProperty("url").GetString()!;
        var svgBody = await ReadJsonAsync(await GetPublicAsync((await PutAsync(svg)).Token));
        var svgUrl = svgBody.GetProperty("url").GetString()!;

        var pdfQuery = HttpUtility.ParseQueryString(new Uri(pdfUrl).Query);
        Assert.True(int.Parse(pdfQuery["X-Amz-Expires"]!, System.Globalization.CultureInfo.InvariantCulture) <= 60);
        Assert.Equal("no-store", pdfQuery["response-cache-control"]);
        Assert.StartsWith("inline;", pdfQuery["response-content-disposition"], StringComparison.Ordinal);
        Assert.Equal("application/pdf", pdfQuery["response-content-type"]);

        var svgQuery = HttpUtility.ParseQueryString(new Uri(svgUrl).Query);
        Assert.StartsWith("attachment;", svgQuery["response-content-disposition"], StringComparison.Ordinal);
        Assert.Equal("application/octet-stream", svgQuery["response-content-type"]);
        Assert.Equal("application/octet-stream", svgBody.GetProperty("mediaType").GetString());
        Assert.True(svgBody.GetProperty("expiresAt").GetDateTimeOffset() <= DateTimeOffset.UtcNow.AddSeconds(61));
    }

    [Fact]
    public async Task A_token_for_one_tenant_cannot_reach_another_tenants_link()
    {
        var tokens = _factory.Services.GetRequiredService<PublicLinkTokenService>();
        var linkId = Guid.NewGuid();
        await Sql(
            $"""
            UPDATE public_link SET revoked_at = now() WHERE item_id = '{Beta.ItemId}';
            INSERT INTO principal (principal_id, tenant_id, external_issuer, external_subject, kind, display_name, email, email_normalized, email_verified, status, deprovisioned_at)
            VALUES (gen_random_uuid(), '{Beta.TenantId}', NULL, 'beta-service', 'service', 'beta service', NULL, NULL, false, 'active', NULL);
            INSERT INTO public_link (id, tenant_id, workspace_id, item_id, nonce, service_principal_id, created_by, created_at)
            VALUES ('{linkId}', '{Beta.TenantId}', '{Beta.WorkspaceId}', '{Beta.ItemId}', 'beta-nonce',
                    (SELECT principal_id FROM principal WHERE external_subject = 'beta-service'), '{Beta.PrincipalId}', now());
            """);

        var forged = tokens.Create(new PublicLinkTokenPayload(TestTenants.Alpha, linkId, TestTenants.AlphaPrincipal, "beta-nonce"));

        Assert.Equal("1", await Scalar($"SELECT count(*) FROM public_link WHERE id = '{linkId}'"));
        Assert.Equal(HttpStatusCode.NotFound, await ReadStatusAsync(forged));
    }

    private static string LockSql(Guid item) =>
        $"""
        INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
        VALUES ('{item}', '{TestTenants.Alpha}',
                'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                '{TestTenants.AlphaPrincipal}', now())
        """;

    private (WebApplicationFactory<Program> Factory, HttpClient Client) Build(bool enabled)
    {
        string signingKey;
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            signingKey = key.ExportECPrivateKeyPem();
        }

        var factory = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = _fixture.ApplicationConnectionString,
            [InternalBoundaryMiddleware.SecretConfigurationKey] = "public-link-internal-secret",
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.public-link.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "public-link-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
            ["Nix:Collaboration:BaseUrl"] = "http://127.0.0.1:8100",
            ["Nix:ObjectStorage:Endpoint"] = "http://127.0.0.1:7070",
            ["Nix:ObjectStorage:Region"] = "us-east-1",
            ["Nix:ObjectStorage:Bucket"] = "nix-objects",
            ["Nix:ObjectStorage:AccessKey"] = "link-access",
            ["Nix:ObjectStorage:SecretKey"] = "link-secret",
            ["Nix:PublicForms:SigningKey"] = "public-link-test-signing-key-0123456789",
            [PublicLinkSettings.EnabledKey] = enabled ? "true" : "false",
        });
        return (factory, factory.CreateClient());
    }

    private async Task<string> AdminTokenAsync(HttpClient client)
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken(
                $"public-link-{Guid.NewGuid():N}",
                [AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin],
                1),
            Cancellation);
        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
        await work.CommitAsync(Cancellation);
        using var exchange = await client.PostAsJsonAsync(
            new Uri("/public/v1/auth/token", UriKind.Relative),
            new { token = result.Value.Secret },
            Cancellation);
        exchange.EnsureSuccessStatusCode();
        return (await ReadJsonAsync(exchange)).GetProperty("accessToken").GetString()!;
    }

    private async Task<Guid> NewFileAsync()
    {
        var id = Guid.NewGuid();
        await Sql(
            $"""
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state, purge_after, created_by, last_modified_by, created_at, last_modified_at)
            VALUES ('{id}', '{Alpha.TenantId}', '{Alpha.WorkspaceId}', 'file', '{Alpha.ItemId}', 2000, NULL, 'active', NULL, '{Alpha.PrincipalId}', '{Alpha.PrincipalId}', now(), now());
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES ('{id}', '{id}', '{Alpha.TenantId}', '{Alpha.WorkspaceId}', 0), ('{id}', '{Alpha.ItemId}', '{Alpha.TenantId}', '{Alpha.WorkspaceId}', 1);
            """);
        return id;
    }

    private async Task<Guid> AddVersionAsync(Guid file, int number, string state, string mediaType = "application/pdf")
    {
        var id = Guid.NewGuid();
        await Sql(
            $"""
            INSERT INTO file_version (file_version_id, tenant_id, workspace_id, item_id, version, object_key, file_name, media_type, byte_length, sha256, pixel_width, pixel_height, previewable, created_by, created_at, state)
            VALUES ('{id}', '{Alpha.TenantId}', '{Alpha.WorkspaceId}', '{file}', {number}, 'files/pl/{file}/{number}', 'doc-{number}.bin', '{mediaType}', 4, repeat('c', 64), NULL, NULL, false, '{Alpha.PrincipalId}', now(), '{state}');
            INSERT INTO file_body (item_id, tenant_id, workspace_id, current_version_id)
            VALUES ('{file}', '{Alpha.TenantId}', '{Alpha.WorkspaceId}', '{id}')
            ON CONFLICT (item_id) DO UPDATE SET current_version_id = EXCLUDED.current_version_id;
            """);
        return id;
    }

    private async Task<LinkView> PutAsync(Guid item, object? body = null)
    {
        using var response = await Send(HttpMethod.Put, $"/api/v1/items/{item}/public-link", body ?? new { });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = await ReadJsonAsync(response);
        var url = json.GetProperty("url").GetString()!;
        return new LinkView(
            url[(url.LastIndexOf('/') + 1)..],
            json.GetProperty("versionId").ValueKind == JsonValueKind.Null ? null : json.GetProperty("versionId").GetGuid(),
            json.GetProperty("versionState").ValueKind == JsonValueKind.Null ? null : json.GetProperty("versionState").GetString());
    }

    private async Task<HttpStatusCode> ReadStatusAsync(string token)
    {
        using var response = await _client.GetAsync(new Uri($"/public/v1/links/{token}", UriKind.Relative), Cancellation);
        return response.StatusCode;
    }

    private async Task<HttpResponseMessage> GetPublicAsync(string token) =>
        await _client.GetAsync(new Uri($"/public/v1/links/{token}", UriKind.Relative), Cancellation);

    private async Task<HttpResponseMessage> Send(HttpMethod method, string path, object? body = null)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _admin);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return await _client.SendAsync(request, Cancellation);
    }

    private static async Task<JsonElement> ReadJsonAsync(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return document.RootElement.Clone();
    }

    private static async Task<string?> ProblemCodeAsync(HttpResponseMessage response) =>
        (await ReadJsonAsync(response)).GetProperty("code").GetString();

    private async Task Sql(string sql)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private async Task<string?> Scalar(string sql)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.TextAsync(connection, transaction: null, $"SELECT ({sql})::text");
        }
    }

    private sealed record LinkView(string Token, Guid? VersionId, string? VersionState);
}
