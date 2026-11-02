using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Features.Recurrence;
using Nix.Features.Views;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.ViewCompute;

/// <summary>
/// The golden fixtures of <c>packages/view-compute/fixtures/&lt;slice&gt;/*.json</c>, replayed through
/// Core's own handlers so the offline TypeScript port and Core cannot drift. The format is described
/// in <c>packages/view-compute/src/fixture.test-helper.ts</c>: items named by <c>key</c>, ids written
/// <c>{key}</c>, the workspace <c>{workspace}</c> (the seeded Alpha workspace here).
/// </summary>
/// <remarks>
/// <para>
/// <b>Recording.</b> Expected answers are never written by hand: run a replay with the environment
/// variable <c>NIX_FIXTURE_RECORD=1</c> and call <see cref="Verify"/>, which then writes Core's
/// answer into the fixture file instead of asserting it.
/// </para>
/// <para>
/// <b>Clock.</b> Pass the host's <see cref="NixPersistenceHost.Clock"/> to <see cref="SeedAsync"/>:
/// each item is created (and its schema, views and recurrence set) with the clock pinned to the
/// item's <c>createdAt</c>, else the fixture's <c>now</c>, so <c>created_at</c> and
/// <c>last_modified_at</c> equal what the TypeScript mirror carries. Reads that take Core's day take
/// it from the request (<c>today</c>), so they need no pin; a lane whose handler reads
/// <see cref="TimeProvider"/> for "now" pins <c>fixture.Now</c> around its call.
/// </para>
/// <para>
/// <b>Stored bags.</b> Core merges <c>title</c> into every item's property bag and stamps
/// <c>$due_set_by</c> / <c>$reminder_set_by</c> when a due date or reminder is written. Fixtures
/// therefore write <c>title</c> into <c>properties</c> themselves (the TypeScript mirror reads the
/// bag, not the title field), and <see cref="ToKeys"/> drops the two stamps from answers.
/// </para>
/// </remarks>
internal static partial class ViewComputeFixtures
{
    private const string RecordVariable = "NIX_FIXTURE_RECORD";

    private static readonly JsonSerializerOptions Pretty = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>
    /// Resets the database, seeds both tenants and removes Alpha's seeded item, so the workspace
    /// holds exactly the fixture's items. Call it from <c>InitializeAsync</c>.
    /// </summary>
    /// <param name="fixture">The database fixture.</param>
    public static async Task PrepareAsync(NixPostgresFixture fixture)
    {
        ArgumentNullException.ThrowIfNull(fixture);

        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        var connection = await fixture.OpenSuperuserConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // Foreign keys off for this session only: the seed's dependents are orphaned, which no
            // view read looks at, and the item itself is gone from every list.
            await RawSql.ExecuteAsync(connection, transaction: null, "SET session_replication_role = replica");
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"DELETE FROM item WHERE tenant_id = '{TestTenants.Alpha}'");
        }
    }

    /// <summary>Every fixture of one slice, sorted by file name.</summary>
    public static IReadOnlyList<ViewComputeFixture> Load(string slice)
    {
        var folder = Path.Combine(RepositoryRoot(), "packages", "view-compute", "fixtures", slice);
        var fixtures = new List<ViewComputeFixture>();
        foreach (var path in Directory.GetFiles(folder, "*.json").Order(StringComparer.Ordinal))
        {
            var root = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
            fixtures.Add(new ViewComputeFixture(
                root["name"]!.GetValue<string>(),
                DateTimeOffset.Parse(root["now"]!.GetValue<string>(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal),
                root["items"]!.AsArray().DeepCloneArray(),
                root["request"]!.AsObject().DeepClone().AsObject(),
                root["expected"]?.AsObject().DeepClone().AsObject() ?? [])
            {
                Path = path,
            });
        }

        return fixtures;
    }

    /// <summary>
    /// Creates the fixture's items in order (type, title, parent, properties, then schema, views and
    /// recurrence where given) under the given workspace, and returns the minted ids by key.
    /// </summary>
    /// <param name="dispatcher">The unit of work's dispatcher.</param>
    /// <param name="workspace">The workspace to seed.</param>
    /// <param name="fixture">The fixture.</param>
    /// <param name="cancellationToken">Cancels the seeding.</param>
    /// <param name="clock">The host's clock, pinned per item; null leaves the system clock.</param>
    public static async Task<FixtureIds> SeedAsync(
        NixDispatcher dispatcher,
        WorkspaceId workspace,
        ViewComputeFixture fixture,
        CancellationToken cancellationToken,
        PinnableTimeProvider? clock = null)
    {
        ArgumentNullException.ThrowIfNull(dispatcher);
        ArgumentNullException.ThrowIfNull(fixture);

        var ids = new Dictionary<string, ItemId>(StringComparer.Ordinal);
        try
        {
            foreach (var node in fixture.Items)
            {
                var item = node!.AsObject();
                var key = item["key"]!.GetValue<string>();
                var createdAt = item["createdAt"] is { } stamp
                    ? DateTimeOffset.Parse(stamp.GetValue<string>(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal)
                    : fixture.Now;
                clock?.Pin(createdAt);

                ItemId? parent = item["parent"] is { } parentKey ? ids[parentKey.GetValue<string>()] : null;
                // {key} / {workspace} inside properties name items created earlier in the fixture.
                var properties = item["properties"] is { } bag
                    ? JsonNode.Parse(ToIds(bag.ToJsonString(), new FixtureIds(workspace, ids)))!.AsObject()
                    : null;
                var create = new CreateItem(
                    workspace,
                    item["type"]!.GetValue<string>(),
                    item["title"]!.GetValue<string>(),
                    parent,
                    properties);
                AllowReservedKeys(create, properties);

                var created = await dispatcher.SendAsync<CreateItem, Item>(create, cancellationToken).ConfigureAwait(false);
                var id = Succeeded(created, $"create '{key}'").Id;
                ids[key] = id;

                if (item["schema"] is JsonObject schema)
                {
                    Succeeded(
                        await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                            new SetItemSchema(id, PropertySchemaJson.Read(schema.ToJsonString())), cancellationToken).ConfigureAwait(false),
                        $"schema of '{key}'");
                }

                if (item["views"] is JsonObject views)
                {
                    var stored = ViewDefinitionsJson.Read(views.ToJsonString());
                    Succeeded(
                        await dispatcher.SendAsync<SetContainerViews, System.Collections.Immutable.ImmutableArray<ViewDefinition>>(
                            new SetContainerViews(id, stored.Views, stored.Default, stored.HideDocument), cancellationToken).ConfigureAwait(false),
                        $"views of '{key}'");
                }

                if (item["recurrence"] is JsonObject recurrence)
                {
                    var request = JsonSerializer.Deserialize<SetRecurrenceRequest>(recurrence.ToJsonString(), JsonSerializerOptions.Web);
                    Succeeded(
                        await dispatcher.SendAsync<SetItemRecurrence, Item>(new SetItemRecurrence(id, request), cancellationToken).ConfigureAwait(false),
                        $"recurrence of '{key}'");
                }
            }
        }
        finally
        {
            clock?.Unpin();
        }

        return new FixtureIds(workspace, ids);
    }

    /// <summary>Replaces <c>{key}</c> and <c>{workspace}</c> with the seeded ids (request paths and bodies).</summary>
    public static string ToIds(string text, FixtureIds ids)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentNullException.ThrowIfNull(ids);

        return Placeholder().Replace(text, match =>
        {
            var name = match.Groups[1].Value;
            if (name == "workspace")
            {
                return ids.Workspace.Value.ToString("D", CultureInfo.InvariantCulture);
            }

            return ids.ByKey.TryGetValue(name, out var id) ? id.Value.ToString("D", CultureInfo.InvariantCulture) : match.Value;
        });
    }

    /// <summary>Writes seeded ids back as <c>{key}</c>, for comparison with <see cref="ViewComputeFixture.Expected"/>.</summary>
    public static JsonNode? ToKeys(JsonNode? answer, FixtureIds ids)
    {
        ArgumentNullException.ThrowIfNull(ids);

        var names = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [ids.Workspace.Value.ToString("D", CultureInfo.InvariantCulture)] = "{workspace}",
        };
        foreach (var (key, id) in ids.ByKey)
        {
            names[id.Value.ToString("D", CultureInfo.InvariantCulture)] = "{" + key + "}";
        }

        return Walk(answer);

        JsonNode? Walk(JsonNode? node)
        {
            switch (node)
            {
                case JsonObject obj:
                    var copy = new JsonObject();
                    foreach (var (name, value) in obj)
                    {
                        // Core stamps these when a due date or reminder is written; the mirror has none.
                        if (name is "$due_set_by" or "$reminder_set_by")
                        {
                            continue;
                        }

                        copy[Rewrite(name)] = Walk(value);
                    }

                    return copy;
                case JsonArray array:
                    var items = new JsonArray();
                    foreach (var value in array)
                    {
                        items.Add(Walk(value));
                    }

                    return items;
                case JsonValue value when value.TryGetValue<string>(out var text):
                    return JsonValue.Create(Rewrite(text));
                default:
                    return node?.DeepClone();
            }
        }

        string Rewrite(string text)
        {
            foreach (var (id, name) in names)
            {
                text = text.Replace(id, name, StringComparison.Ordinal);
            }

            return text;
        }
    }

    /// <summary>
    /// Asserts Core's answer equals the fixture's expected one; in record mode
    /// (<c>NIX_FIXTURE_RECORD=1</c>) writes the answer into the fixture file instead.
    /// </summary>
    /// <param name="fixture">The fixture replayed.</param>
    /// <param name="answer">Core's answer, already passed through <see cref="ToKeys"/>.</param>
    public static void Verify(ViewComputeFixture fixture, JsonNode? answer)
    {
        ArgumentNullException.ThrowIfNull(fixture);

        if (Environment.GetEnvironmentVariable(RecordVariable) == "1" && fixture.Path is { } path)
        {
            var root = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
            root["expected"] = answer?.DeepClone();
            File.WriteAllText(path, root.ToJsonString(Pretty) + "\n");
            return;
        }

        Assert.True(
            JsonNode.DeepEquals(fixture.Expected, answer),
            $"{fixture.Name}: Core answered\n{answer?.ToJsonString(Pretty)}\nbut the fixture expects\n{fixture.Expected.ToJsonString(Pretty)}");
    }

    // CreateItem's reserved-key capabilities are internal to Core (the tests do not see them), so a
    // fixture that carries habit or finance content sets them the way the feature code does.
    private static void AllowReservedKeys(CreateItem create, JsonObject? properties)
    {
        if (properties is null)
        {
            return;
        }

        Set("HabitWrite", "$habit_");
        Set("FinanceWrite", "$fin_");
        Set("CalendarWrite", "$cal_");

        void Set(string capability, string prefix)
        {
            if (properties.Any(pair => pair.Key.StartsWith(prefix, StringComparison.Ordinal)))
            {
                typeof(CreateItem)
                    .GetProperty(capability, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                    .SetValue(create, true);
            }
        }
    }

    private static T Succeeded<T>(Nix.Domain.Primitives.Result<T> result, string step) =>
        result.IsSuccess
            ? result.Value
            : throw new InvalidOperationException($"Seeding failed at {step}: {result.Error.Code}: {result.Error.Message}");

    private static JsonArray DeepCloneArray(this JsonArray array) => (JsonArray)array.DeepClone();

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "packages", "view-compute", "fixtures")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName ?? throw new DirectoryNotFoundException("packages/view-compute/fixtures was not found above the test assembly.");
    }

    [GeneratedRegex(@"\{([A-Za-z0-9_.-]+)\}")]
    private static partial Regex Placeholder();
}

/// <param name="Expected">Core's answer: <c>{ "status": 200, "body": … }</c> or <c>{ "status", "code", "detail" }</c>.</param>
internal sealed record ViewComputeFixture(
    string Name,
    DateTimeOffset Now,
    JsonArray Items,
    JsonObject Request,
    JsonObject Expected)
{
    /// <summary>The file the fixture was loaded from, for record mode.</summary>
    public string? Path { get; init; }
}

/// <summary>The ids Core minted for one seeded fixture.</summary>
internal sealed record FixtureIds(WorkspaceId Workspace, IReadOnlyDictionary<string, ItemId> ByKey);
