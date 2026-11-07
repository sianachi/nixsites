using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Record keys, lookup, upsert, batch and strict mode through the real HTTP pipeline on Postgres.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class RecordKeyHttpTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static readonly string Workspace = TestTenants.AlphaWorkspace.ToString("D");

    private static readonly string[] Followers = ["updated", "unchanged"];

    private ConfiguredApplicationFactory _factory = null!;
    private HttpClient _client = null!;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await using (var connection = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(connection, null, "DELETE FROM tenant_role");
        }

        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        _factory = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = fixture.ApplicationConnectionString,
            ["Nix:Scheduling:Enabled"] = "false",
            ["Nix:RateLimits:BulkWritesPerMinute"] = "1000",
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.records.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "records-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey.ExportECPrivateKeyPem(),
        });
        _client = _factory.CreateClient();
        string secret;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var token = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
                new CreateAccessToken("Records", [AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin], 1), Cancellation);
            Assert.True(token.IsSuccess);
            secret = token.Value.Secret;
            await work.CommitAsync(Cancellation);
        }

        using var exchange = await _client.PostAsJsonAsync("/public/v1/auth/token", new { token = secret }, Cancellation);
        exchange.EnsureSuccessStatusCode();
        var credential = await exchange.Content.ReadFromJsonAsync<JsonObject>(Cancellation);
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", credential!["accessToken"]!.GetValue<string>());
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task Exact_url_lookup_matches_the_canonical_form_reports_trash_and_never_rewrites_me()
    {
        var collection = await CollectionAsync();
        var record = await UpsertAsync(collection, "url", "HTTPS://Example.COM:443/Jobs/1?x=Y#frag");
        var id = record["item"]!["id"]!.GetValue<Guid>();
        Assert.Equal("https://example.com/Jobs/1?x=Y", record["item"]!["properties"]!["url"]!.GetValue<string>());

        Assert.Equal(id, (await LookupAsync(collection, "url", "https://example.com/Jobs/1?x=Y"))[0]!["item"]!["id"]!.GetValue<Guid>());
        Assert.Single(await LookupAsync(collection, "url", "https://EXAMPLE.com/Jobs/1?x=Y#other"));
        Assert.Empty(await LookupAsync(collection, "url", "https://example.com/Jobs/2?x=Y"));
        Assert.Empty(await LookupAsync(collection, "url", "https://example.com/Jobs/1/?x=Y"));

        // Without a parent the lookup runs over the workspace, exact value only.
        Assert.Single(await LookupAsync(null, "url", "https://example.com/Jobs/1?x=Y"));

        using (var trashed = await _client.DeleteAsync(new Uri($"/api/v1/items/{id}", UriKind.Relative), Cancellation))
        {
            Assert.True(trashed.IsSuccessStatusCode);
        }

        var after = await LookupAsync(collection, "url", "https://example.com/Jobs/1?x=Y");
        Assert.True(after[0]!["trashed"]!.GetValue<bool>());

        // 'me' is a literal here, not the caller.
        await SchemaAsync(collection, Declare("owner", "text", false));
        using (var response = await _client.PostAsJsonAsync($"/api/v1/workspaces/{Workspace}/records/batch", new
        {
            rows = new[] { new { parentId = collection, title = "Mine", idempotencyKey = "me-1", properties = new { owner = "me" } } },
        }, Cancellation))
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }

        Assert.Single(await LookupAsync(collection, "owner", "me"));
    }

    [Fact]
    public async Task Twenty_concurrent_upserts_of_one_url_make_one_item()
    {
        var collection = await CollectionAsync();
        var outcomes = await Task.WhenAll(Enumerable.Range(0, 20).Select(async _ =>
        {
            using var response = await _client.PostAsJsonAsync(
                $"/api/v1/items/{collection}/records/upsert",
                new { keyField = "url", keyValue = "https://example.com/race" }, Cancellation);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return (await response.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!["outcome"]!.GetValue<string>();
        }));
        Assert.Equal(1, outcomes.Count(outcome => outcome == "created"));
        Assert.All(outcomes.Where(outcome => outcome != "created"), outcome => Assert.Contains(outcome, Followers));
        Assert.Equal(1, await CountChildrenAsync(collection));
    }

    [Fact]
    public async Task A_plain_create_of_a_held_value_is_a_409_with_the_existing_id()
    {
        var collection = await CollectionAsync();
        var existing = (await UpsertAsync(collection, "url", "https://example.com/held"))["item"]!["id"]!.GetValue<Guid>();
        using var response = await _client.PostAsJsonAsync($"/api/v1/workspaces/{Workspace}/items", new
        {
            type = "note",
            title = "Duplicate",
            parentId = collection,
            properties = new { url = "https://EXAMPLE.com/held" },
        }, Cancellation);
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = (await response.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!;
        Assert.Equal("records.key_conflict", problem["code"]!.GetValue<string>());
        Assert.Equal(existing, problem["existingItemId"]!.GetValue<Guid>());
        Assert.Equal(1, await CountChildrenAsync(collection));

        // A PATCH onto a held value is refused the same way.
        var other = await CreateAsync(collection, "Other");
        using var patch = await _client.PatchAsJsonAsync($"/api/v1/items/{other}/properties", new { properties = new { url = "https://example.com/held" } }, Cancellation);
        Assert.Equal(HttpStatusCode.Conflict, patch.StatusCode);
    }

    [Fact]
    public async Task A_plain_create_racing_an_upsert_of_one_url_never_makes_a_second_item()
    {
        var collection = await CollectionAsync();
        for (var round = 0; round < 8; round++)
        {
            var url = $"https://example.com/race-{round}";
            var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var create = Task.Run(async () =>
            {
                await gate.Task;
                return await _client.PostAsJsonAsync($"/api/v1/workspaces/{Workspace}/items", new
                {
                    type = "note",
                    title = "Racer",
                    parentId = collection,
                    properties = new { url },
                }, Cancellation);
            }, Cancellation);
            var upsert = Task.Run(async () =>
            {
                await gate.Task;
                return await _client.PostAsJsonAsync(
                    $"/api/v1/items/{collection}/records/upsert", new { keyField = "url", keyValue = url }, Cancellation);
            }, Cancellation);
            gate.SetResult();
            using var createResponse = await create.WaitAsync(TimeSpan.FromSeconds(60), Cancellation);
            using var upsertResponse = await upsert.WaitAsync(TimeSpan.FromSeconds(60), Cancellation);

            Assert.Equal(HttpStatusCode.OK, upsertResponse.StatusCode);
            var outcome = (await upsertResponse.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!;
            var upsertId = outcome["item"]!["id"]!.GetValue<Guid>();
            if (createResponse.StatusCode == HttpStatusCode.Conflict)
            {
                // The upsert won; the create reports the item it lost to.
                Assert.Equal("created", outcome["outcome"]!.GetValue<string>());
                var problem = (await createResponse.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!;
                Assert.Equal(upsertId, problem["existingItemId"]!.GetValue<Guid>());
            }
            else
            {
                Assert.True(createResponse.IsSuccessStatusCode, createResponse.StatusCode.ToString());
                Assert.Contains(outcome["outcome"]!.GetValue<string>(), Followers);
            }

            Assert.Equal(round + 1, await CountChildrenAsync(collection));
        }
    }

    [Fact]
    public async Task Repeated_upserts_replay_refuse_a_changed_body_and_never_overwrite_a_newer_write()
    {
        var collection = await CollectionAsync();
        await SchemaAsync(collection, Declare("note", "text", false));
        var first = await PostUpsertAsync(collection, new { keyField = "url", keyValue = "https://example.com/r", properties = new { note = "one" }, idempotencyKey = "k1" });
        Assert.Equal("created", first["outcome"]!.GetValue<string>());
        var id = first["item"]!["id"]!.GetValue<Guid>();

        using (var newer = await _client.PatchAsJsonAsync($"/api/v1/items/{id}/properties", new { properties = new { note = "newer" } }, Cancellation))
        {
            Assert.True(newer.IsSuccessStatusCode);
        }

        var replay = await PostUpsertAsync(collection, new { keyField = "url", keyValue = "https://example.com/r", properties = new { note = "one" }, idempotencyKey = "k1" });
        Assert.Equal("created", replay["outcome"]!.GetValue<string>());
        Assert.Equal("newer", replay["item"]!["properties"]!["note"]!.GetValue<string>());

        using (var changed = await _client.PostAsJsonAsync($"/api/v1/items/{collection}/records/upsert",
            new { keyField = "url", keyValue = "https://example.com/r", properties = new { note = "two" }, idempotencyKey = "k1" }, Cancellation))
        {
            Assert.Equal(HttpStatusCode.Conflict, changed.StatusCode);
            Assert.Equal("records.idempotency_conflict", (await changed.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!["code"]!.GetValue<string>());
        }

        // Without a key a repeat of identical values writes nothing.
        var again = await PostUpsertAsync(collection, new { keyField = "url", keyValue = "https://example.com/r", properties = new { note = "newer" } });
        Assert.Equal("unchanged", again["outcome"]!.GetValue<string>());
        Assert.Equal(1, await CountChildrenAsync(collection));
    }

    [Fact]
    public async Task Strict_writes_refuse_undeclared_keys_per_field_and_write_nothing()
    {
        var collection = await CollectionAsync();
        await SchemaAsync(collection, Declare("stage", "select", true, ["open", "closed"]));

        using var undeclared = await _client.PostAsJsonAsync($"/api/v1/items/{collection}/records/upsert", new
        {
            keyField = "url",
            keyValue = "https://example.com/strict",
            properties = new { stage = "open", surprise = "x" },
        }, Cancellation);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, undeclared.StatusCode);
        var problem = (await undeclared.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!;
        Assert.Equal("properties.invalid", problem["code"]!.GetValue<string>());
        Assert.Equal("surprise", problem["violations"]![0]!["key"]!.GetValue<string>());
        Assert.Equal(0, await CountChildrenAsync(collection));

        using var missing = await _client.PostAsJsonAsync($"/api/v1/items/{collection}/records/upsert", new
        {
            keyField = "url",
            keyValue = "https://example.com/strict",
            properties = new { },
        }, Cancellation);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, missing.StatusCode);
        Assert.Equal("stage", (await missing.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!["violations"]![0]!["key"]!.GetValue<string>());

        using var bad = await _client.PostAsJsonAsync($"/api/v1/items/{collection}/records/upsert", new
        {
            keyField = "url",
            keyValue = "https://example.com/strict",
            properties = new { stage = "nope" },
        }, Cancellation);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, bad.StatusCode);
        Assert.Equal(0, await CountChildrenAsync(collection));

        var ok = await PostUpsertAsync(collection, new { keyField = "url", keyValue = "https://example.com/strict", properties = new { stage = "open" } });
        var id = ok["item"]!["id"]!.GetValue<Guid>();
        using var read = await _client.GetAsync(new Uri($"/api/v1/items/{id}", UriKind.Relative), Cancellation);
        var fresh = (await read.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!;
        Assert.True(JsonNode.DeepEquals(ok["item"]!["properties"], fresh["properties"]), "the upsert response must equal a fresh read");
        Assert.Equal(ok["item"]!["title"]!.GetValue<string>(), fresh["title"]!.GetValue<string>());

        // No schema anywhere: every non-built-in key is refused, saying to declare fields.
        var bare = await CreateAsync(null, "Bare");
        using var strictCreate = await _client.PostAsJsonAsync($"/api/v1/workspaces/{Workspace}/items", new
        {
            type = "note",
            title = "x",
            parentId = bare,
            properties = new { anything = "x", due_date = "2030-01-01" },
            strict = true,
        }, Cancellation);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, strictCreate.StatusCode);
        var bareProblem = (await strictCreate.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!;
        Assert.Single(bareProblem["violations"]!.AsArray());
        Assert.Contains("Declare fields", bareProblem["violations"]![0]!["reason"]!.GetValue<string>(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_batch_keeps_good_rows_reports_bad_ones_by_index_and_is_safe_to_retry()
    {
        var collection = await CollectionAsync();
        await SchemaAsync(collection, Declare("stage", "select", false, ["open", "closed"]));
        var rows = Enumerable.Range(0, 100).Select(i => (object)(i % 10 == 3
            ? new { parentId = collection, keyField = "url", keyValue = $"https://example.com/b/{i}", properties = new { stage = "nope" } }
            : i % 2 == 0
                ? new { parentId = collection, keyField = "url", keyValue = $"https://example.com/b/{i}", properties = new { stage = "open" } }
                : new { parentId = collection, keyField = "url", keyValue = $"https://example.com/b/{i}", properties = new { stage = "closed" } })).ToArray();

        var first = await PostBatchAsync(new { rows });
        Assert.Equal(10, first["failed"]!.GetValue<int>());
        Assert.Equal(90, first["created"]!.GetValue<int>());
        for (var i = 0; i < 100; i++)
        {
            var row = first["rows"]![i]!;
            Assert.Equal(i, row["index"]!.GetValue<int>());
            Assert.Equal(i % 10 == 3 ? "error" : "created", row["status"]!.GetValue<string>());
        }

        Assert.Equal("stage", first["rows"]![3]!["error"]!["violations"]![0]!["key"]!.GetValue<string>());
        Assert.Equal(90, await CountChildrenAsync(collection));

        var retry = await PostBatchAsync(new { rows });
        Assert.Equal(0, retry["created"]!.GetValue<int>());
        Assert.Equal(90, retry["unchanged"]!.GetValue<int>());
        Assert.Equal(90, await CountChildrenAsync(collection));

        // Creates without a key refuse the whole request before any write; so does going over 100.
        using var noKey = await _client.PostAsJsonAsync($"/api/v1/workspaces/{Workspace}/records/batch", new
        {
            rows = new object[]
            {
                new { parentId = collection, keyField = "url", keyValue = "https://example.com/never" },
                new { parentId = collection, title = "no key" },
            },
        }, Cancellation);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, noKey.StatusCode);
        Assert.Empty(await LookupAsync(collection, "url", "https://example.com/never"));

        using var tooMany = await _client.PostAsJsonAsync($"/api/v1/workspaces/{Workspace}/records/batch", new
        {
            rows = Enumerable.Range(0, 101).Select(i => new { parentId = collection, keyField = "url", keyValue = $"https://example.com/m/{i}" }).ToArray(),
        }, Cancellation);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, tooMany.StatusCode);
        Assert.Equal(90, await CountChildrenAsync(collection));

        // A keyed create repeats safely.
        var creates = new { rows = new[] { new { parentId = collection, title = "Keyed", idempotencyKey = "once" } } };
        await PostBatchAsync(creates);
        var replayed = await PostBatchAsync(creates);
        Assert.Equal(0, replayed["updated"]!.GetValue<int>());
        Assert.Equal(91, await CountChildrenAsync(collection));
    }

    [Fact]
    public async Task Turning_unique_on_refuses_duplicates_and_a_move_into_a_scope_conflicts()
    {
        var collection = await CollectionAsync(unique: false);
        await CreateAsync(collection, "A", new { url = "https://example.com/dup" });
        await CreateAsync(collection, "B", new { url = "https://EXAMPLE.com/dup" });
        using (var refused = await PutSchemaAsync(collection, Declare("url", "url", false, unique: true)))
        {
            Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
            var problem = (await refused.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!;
            Assert.Equal("schema.unique_duplicates", problem["code"]!.GetValue<string>());
            Assert.NotEmpty(problem["violations"]!.AsArray());
        }

        var clean = await CollectionAsync();
        var held = (await UpsertAsync(clean, "url", "https://example.com/held"))["item"]!["id"]!.GetValue<Guid>();
        var stray = await CreateAsync(collection, "Stray", new { url = "https://example.com/held" });
        using var move = await _client.PostAsJsonAsync($"/api/v1/items/{stray}/move", new { parentId = clean }, Cancellation);
        Assert.Equal(HttpStatusCode.Conflict, move.StatusCode);
        Assert.Equal(held, (await move.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!["existingItemId"]!.GetValue<Guid>());
    }

    [Fact]
    public async Task A_property_write_waits_out_a_field_turning_unique_so_the_backfill_cannot_miss_it()
    {
        var collection = await CollectionAsync(unique: false);
        var item = await CreateAsync(collection, "A");

        // Holds what SetItemSchema holds across its backfill.
        await using var holder = await fixture.OpenMigratorConnectionAsync();
        await using var transaction = await holder.BeginTransactionAsync(Cancellation);
        await RawSql.ExecuteAsync(
            holder,
            transaction,
            $"SELECT pg_advisory_xact_lock(hashtextextended('record-scope:{TestTenants.Alpha:D}:{collection:D}', 0))");

        var write = _client.PatchAsJsonAsync($"/api/v1/items/{item}/properties", new { properties = new { url = "https://example.com/late" } }, Cancellation);
        await Task.Delay(TimeSpan.FromSeconds(1), Cancellation);
        Assert.False(write.IsCompleted, "The write must wait for the backfill to finish.");

        await transaction.CommitAsync(Cancellation);
        using var response = await write;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task A_lookup_past_the_cap_says_it_was_truncated()
    {
        var collection = await CollectionAsync(unique: false);
        await SchemaAsync(collection, Declare("ref", "text", false));
        for (var page = 0; page < 6; page++)
        {
            var size = page == 5 ? 1 : 100;
            var batch = await PostBatchAsync(new
            {
                rows = Enumerable.Range(0, size).Select(index => new
                {
                    parentId = collection,
                    title = $"Row {page}-{index}",
                    idempotencyKey = $"cap-{page}-{index}",
                    properties = new { @ref = "same" },
                }).ToArray(),
            });
            Assert.Equal(0, batch["failed"]!.GetValue<int>());
        }

        using var response = await _client.PostAsJsonAsync($"/api/v1/workspaces/{Workspace}/lookup", new { key = "ref", value = "same", parentId = collection }, Cancellation);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!;
        Assert.Equal(500, body["matches"]!.AsArray().Count);
        Assert.True(body["truncated"]!.GetValue<bool>());

        var one = await CreateAsync(collection, "Unique value", new { @ref = "only" });
        using var single = await _client.PostAsJsonAsync($"/api/v1/workspaces/{Workspace}/lookup", new { key = "ref", value = "only", parentId = collection }, Cancellation);
        var singleBody = (await single.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!;
        Assert.False(singleBody["truncated"]!.GetValue<bool>());
        Assert.Equal(one, singleBody["matches"]![0]!["item"]!["id"]!.GetValue<Guid>());
    }

    [Fact]
    public async Task Recording_sent_changes_no_file_version_and_queues_no_job_and_not_equals_matches_records_missing_the_field()
    {
        var collection = await CollectionAsync();
        await SchemaAsync(collection, Declare("status", "select", false, ["draft", "sent"]));
        var sent = (await PostUpsertAsync(collection, new { keyField = "url", keyValue = "https://example.com/s1", properties = new { status = "draft" } }))["item"]!["id"]!.GetValue<Guid>();
        await PostUpsertAsync(collection, new { keyField = "url", keyValue = "https://example.com/s2" });

        var versions = await ScalarAsync("SELECT count(*)::text || ':' || coalesce(string_agg(state, ','), '') FROM file_version");
        var jobs = await ScalarAsync("SELECT count(*)::text FROM worker_job");
        using (var set = await _client.PatchAsJsonAsync($"/api/v1/items/{sent}/properties", new { properties = new { status = "sent" } }, Cancellation))
        {
            Assert.True(set.IsSuccessStatusCode);
        }

        Assert.Equal(versions, await ScalarAsync("SELECT count(*)::text || ':' || coalesce(string_agg(state, ','), '') FROM file_version"));
        Assert.Equal(jobs, await ScalarAsync("SELECT count(*)::text FROM worker_job"));

        // Records without the field count as "not sent": not-equals keeps them.
        using var query = await _client.PostAsJsonAsync($"/api/v1/workspaces/{Workspace}/query", new
        {
            scope = new { parentId = collection },
            filters = new[] { new { property = "status", @operator = "not-equals", value = "sent" } },
        }, Cancellation);
        Assert.Equal(HttpStatusCode.OK, query.StatusCode);
        Assert.Single((await query.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!["results"]!.AsArray());
    }

    [Fact]
    public async Task Record_keys_are_invisible_to_another_tenant()
    {
        var collection = await CollectionAsync();
        await UpsertAsync(collection, "url", "https://example.com/rls");
        await using var beta = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        var connection = (NpgsqlConnection)beta.DbContext.Database.GetDbConnection();
        var transaction = (NpgsqlTransaction)beta.Transaction.GetDbTransaction();
        Assert.Equal("0", await RawSql.TextAsync(connection, transaction, "SELECT count(*)::text FROM record_key WHERE value = 'https://example.com/rls'"));
    }

    private async Task<string> ScalarAsync(string sql)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        return await RawSql.TextAsync(
            (NpgsqlConnection)work.DbContext.Database.GetDbConnection(),
            (NpgsqlTransaction)work.Transaction.GetDbTransaction(),
            sql) ?? string.Empty;
    }

    private async Task<long> CountChildrenAsync(Guid collection) =>
        long.Parse(await ScalarAsync($"SELECT count(*)::text FROM item WHERE parent_id = '{collection}'"), System.Globalization.CultureInfo.InvariantCulture);

    private static object Declare(string key, string type, bool required, string[]? options = null, bool unique = false) =>
        new { key, label = key, type, options, required, unique };

    private async Task<HttpResponseMessage> PutSchemaAsync(Guid item, params object[] properties) =>
        await _client.PutAsJsonAsync($"/api/v1/items/{item}/schema", new { inherit = true, properties }, Cancellation);

    /// <summary>Sets the schema, always keeping the unique url field.</summary>
    private async Task SchemaAsync(Guid collection, params object[] extra)
    {
        using var response = await PutSchemaAsync(collection, [Declare("url", "url", false, unique: true), .. extra]);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    private async Task<Guid> CollectionAsync(bool unique = true)
    {
        var id = await CreateAsync(null, "Applications");
        if (unique)
        {
            await SchemaAsync(id);
        }

        return id;
    }

    private async Task<Guid> CreateAsync(Guid? parent, string title, object? properties = null)
    {
        using var response = await _client.PostAsJsonAsync($"/api/v1/workspaces/{Workspace}/items", new { type = "note", title, parentId = parent, properties }, Cancellation);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!["id"]!.GetValue<Guid>();
    }

    private async Task<JsonObject> UpsertAsync(Guid collection, string field, string value) =>
        await PostUpsertAsync(collection, new { keyField = field, keyValue = value });

    private async Task<JsonObject> PostUpsertAsync(Guid collection, object body)
    {
        using var response = await _client.PostAsJsonAsync($"/api/v1/items/{collection}/records/upsert", body, Cancellation);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!;
    }

    private async Task<JsonObject> PostBatchAsync(object body)
    {
        using var response = await _client.PostAsJsonAsync($"/api/v1/workspaces/{Workspace}/records/batch", body, Cancellation);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!;
    }

    private async Task<JsonArray> LookupAsync(Guid? parent, string key, string value)
    {
        using var response = await _client.PostAsJsonAsync($"/api/v1/workspaces/{Workspace}/lookup", new { key, value, parentId = parent }, Cancellation);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!["matches"]!.AsArray();
    }
}
