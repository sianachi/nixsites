using System.Text;
using System.Text.Json;
using Nix.Workers.Import;
using static Nix.Tests.Workers.ImportFixtures;

namespace Nix.Tests.Workers;

/// <summary>The Go importplan template, schema and catalog tests, against the .NET port.</summary>
public sealed class TemplatePlanTests
{
    private static CancellationToken Token => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Template_plan_preserves_profile_tree_sequences_and_archive_bodies()
    {
        var source = TemplateArchive(TemplateProfile(true, true), includeChild: true, includeRootBody: true);

        var plan = await TemplatePlanner.ParseAsync(source, Limits, Token);

        Assert.Equal(1, plan.Version);
        Assert.Equal(source.Sha256, plan.SourceSha256);
        Assert.Equal("note", plan.RootItemType);
        Assert.Equal((2, 2, 1), (plan.ItemCount, plan.BodyCount, plan.ViewCount));
        Assert.Equal("team.project", plan.Profile.Key);
        Assert.True(plan.Profile.IncludeBody && plan.Profile.IncludeChildren);
        Assert.Equal("-9223372036854775808", plan.Items[0].Seq);
        Assert.Equal("9223372036854775807", plan.Items[1].Seq);
        Assert.Equal(Root, plan.Items[1].ParentSourceId);
        Assert.Contains("\"inherit\":false", plan.Items[0].Schema!.Value.GetRawText(), StringComparison.Ordinal);
        Assert.Contains("\"prosemirror\"", plan.Items[0].Body!.Value.GetRawText(), StringComparison.Ordinal);
        Assert.Contains("\"canvas\"", plan.Items[1].Body!.Value.GetRawText(), StringComparison.Ordinal);

        var (first, digest) = TemplatePlanner.Encode(plan, Limits.MaxPlanBytes);
        var (second, secondDigest) = TemplatePlanner.Encode(plan, Limits.MaxPlanBytes);
        Assert.Equal(first, second);
        Assert.Equal(digest, secondDigest);
        var decoded = TemplatePlanner.Decode(first, digest.ToUpperInvariant(), Limits);
        Assert.Equal(plan.Items[1].Seq, decoded.Items[1].Seq);
        Assert.Equal(plan.Items[1].Body!.Value.GetRawText(), decoded.Items[1].Body!.Value.GetRawText());
    }

    [Fact]
    public async Task Template_archive_ignores_exported_comments()
    {
        var comments = Element("""[{"id":"t1","quote":null,"resolved":false,"comments":[{"author":"Ada","body":"hi","createdAt":"2026-09-01T12:00:00Z"}]}]""");
        var source = TemplateArchive(TemplateProfile(true, true), true, true, rootExtra: new Dictionary<string, object?> { ["comments"] = comments });

        var plan = await TemplatePlanner.ParseAsync(source, Limits, Token);

        var (encoded, _) = TemplatePlanner.Encode(plan, Limits.MaxPlanBytes);
        Assert.DoesNotContain("Ada", Encoding.UTF8.GetString(encoded), StringComparison.Ordinal);
    }

    public static TheoryData<string, string?> InvalidProfiles() => new()
    {
        { "missing", null },
        { "wrong kind", """{"kind":"workspace","version":1,"key":"team.project","name":"Project","description":"","includeBody":true,"includeChildren":false}""" },
        { "wrong version", """{"kind":"template","version":2,"key":"team.project","name":"Project","description":"","includeBody":true,"includeChildren":false}""" },
        { "uppercase key", """{"kind":"template","version":1,"key":"Team.Project","name":"Project","description":"","includeBody":true,"includeChildren":false}""" },
        { "trailing newline key", """{"kind":"template","version":1,"key":"team.project\n","name":"Project","description":"","includeBody":true,"includeChildren":false}""" },
        { "long key", """{"kind":"template","version":1,"key":"a""" + new string('b', 160) + "\"" + ""","name":"Project","description":"","includeBody":true,"includeChildren":false}""" },
        { "blank name", """{"kind":"template","version":1,"key":"team.project","name":"   ","description":"","includeBody":true,"includeChildren":false}""" },
        { "long name", """{"kind":"template","version":1,"key":"team.project","name":""" + "\"" + new string('n', 201) + "\"" + ""","description":"","includeBody":true,"includeChildren":false}""" },
        { "long description", """{"kind":"template","version":1,"key":"team.project","name":"Project","description":""" + "\"" + new string('d', 1001) + "\"" + ""","includeBody":true,"includeChildren":false}""" },
        { "missing description", """{"kind":"template","version":1,"key":"team.project","name":"Project","includeBody":true,"includeChildren":false}""" },
        { "missing body selection", """{"kind":"template","version":1,"key":"team.project","name":"Project","description":"","includeChildren":false}""" },
        { "missing child selection", """{"kind":"template","version":1,"key":"team.project","name":"Project","description":"","includeBody":true}""" },
        { "unknown member", """{"kind":"template","version":1,"key":"team.project","name":"Project","description":"","includeBody":true,"includeChildren":false,"unexpected":true}""" },
    };

    [Theory]
    [MemberData(nameof(InvalidProfiles))]
    public async Task Template_profile_requires_supported_bounded_metadata(string name, string? profile)
    {
        Assert.NotNull(name);
        var source = TemplateArchive(profile is null ? null : Element(profile), includeChild: false, includeRootBody: true);
        await Assert.ThrowsAsync<ImportPlanException>(() => TemplatePlanner.ParseAsync(source, Limits, Token));
    }

    [Theory]
    [InlineData("children excluded but present")]
    [InlineData("root body excluded but present")]
    [InlineData("omission present")]
    [InlineData("loss present")]
    public async Task Template_archive_requires_complete_profile_selections(string scenario)
    {
        var source = scenario switch
        {
            "children excluded but present" => TemplateArchive(TemplateProfile(true, false), true, true),
            "root body excluded but present" => TemplateArchive(TemplateProfile(false, false), false, true),
            "omission present" => TemplateArchive(TemplateProfile(true, false), false, true, omitted: [new Dictionary<string, object?> { ["id"] = null, ["parentId"] = Root, ["reason"] = "limit-reached", ["detail"] = "truncated" }]),
            _ => TemplateArchive(TemplateProfile(true, false), false, true, loss: [new { itemId = Root, kind = "body", detail = "changed" }]),
        };
        await Assert.ThrowsAsync<ImportPlanException>(() => TemplatePlanner.ParseAsync(source, Limits, Token));
    }

    [Fact]
    public async Task Template_profile_may_select_an_uninitialized_root_body()
    {
        var plan = await TemplatePlanner.ParseAsync(TemplateArchive(TemplateProfile(true, false), false, false), Limits, Token);

        Assert.Equal(0, plan.BodyCount);
        Assert.True(plan.Profile.IncludeBody);
    }

    [Fact]
    public async Task Template_parsing_honors_cancellation_and_plan_checksum()
    {
        var source = TemplateArchive(TemplateProfile(true, false), false, true);
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => TemplatePlanner.ParseAsync(source, Limits, cancelled.Token));

        var plan = await TemplatePlanner.ParseAsync(source, Limits, Token);
        var (body, digest) = TemplatePlanner.Encode(plan, Limits.MaxPlanBytes);
        body[^2] ^= 1;
        var error = Assert.Throws<ImportPlanException>(() => TemplatePlanner.Decode(body, digest, Limits));
        Assert.Contains("checksum", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Template_plan_rejects_deeply_nested_json()
    {
        var plan = await TemplatePlanner.ParseAsync(TemplateArchive(TemplateProfile(true, false), false, true), Limits, Token);
        var depth = Limits.MaxDepth + 1;
        plan.Items[0].Body = Element(string.Concat(Enumerable.Repeat("{\"nested\":", depth)) + "null" + new string('}', depth));
        var (body, digest) = TemplatePlanner.Encode(plan, Limits.MaxPlanBytes);

        var error = Assert.Throws<ImportPlanException>(() => TemplatePlanner.Decode(body, digest, Limits));
        Assert.Contains("depth", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Template_v2_preserves_file_history_and_the_shared_initialization_fixture()
    {
        var source = NixV2TemplateArchive(out var descriptor);

        var plan = await TemplatePlanner.ParseAsync(source, Limits, Token);

        Assert.Equal(descriptor, Assert.Single(plan.Files!));
        Assert.Single(plan.Profile.Initialization!.Inputs!);
        var (body, digest) = TemplatePlanner.Encode(plan, Limits.MaxPlanBytes);
        var decoded = TemplatePlanner.Decode(body, digest, Limits);
        Assert.Single(decoded.Files!);
        Assert.Equal("project_name", decoded.Profile.Initialization!.Inputs![0].Key);

        var fixture = TemplatePlanner.ReadInitialization(await File.ReadAllBytesAsync(Path.Combine(RepoRoot(), "fixtures", "template-initialization-v1.json"), Token));
        Assert.Null(TemplatePlanner.ValidateInitialization(fixture));
    }

    [Theory]
    [InlineData("""{"version":1,"inputs":[{"key":"project_name","label":"Project","type":"text"}],"rules":[],"references":[]}""")]
    [InlineData("""{"version":1,"inputs":[{"key":"project_name","label":"Project","type":"text","required":false}],"rules":[{"sourceId":"11111111-1111-4111-8111-111111111111","propertyKey":"name","kind":"clear","inputKey":"project_name"}],"references":[]}""")]
    [InlineData("""{"version":1,"inputs":[{"key":"ProjectName","label":"Project","type":"text","required":false}],"rules":[],"references":[]}""")]
    [InlineData("""{"version":1,"inputs":[],"rules":[{"sourceId":"11111111-1111-4111-8111-111111111111","propertyKey":"recurrence.until","kind":"set","value":"2026-02-30"}],"references":[]}""")]
    [InlineData("""{"version":1,"inputs":[],"rules":[],"references":[{"sourceItemId":"11111111-1111-4111-8111-111111111111","policy":"replace"}]}""")]
    [InlineData("""{"version":1,"inputs":[],"rules":[],"references":[],"extra":1}""")]
    public void Template_initialization_rejects_missing_required_and_irrelevant_fields(string body)
    {
        string? error;
        try
        {
            error = TemplatePlanner.ValidateInitialization(TemplatePlanner.ReadInitialization(Encoding.UTF8.GetBytes(body)));
        }
        catch (ImportPlanException exception)
        {
            error = exception.Message;
        }
        Assert.NotNull(error);
    }

    [Fact]
    public void Template_initialization_keeps_an_explicit_null_value_through_encode()
    {
        var initialization = TemplatePlanner.ReadInitialization("""{"version":1,"inputs":[],"rules":[{"sourceId":"11111111-1111-4111-8111-111111111111","propertyKey":"name","kind":"keep","value":null}],"references":[]}"""u8);
        Assert.Null(TemplatePlanner.ValidateInitialization(initialization));
        Assert.Equal(JsonValueKind.Null, initialization.Rules![0].Value!.Value.ValueKind);
    }

    [Fact]
    public async Task Built_in_template_catalog_parses()
    {
        var directory = Path.Combine(RepoRoot(), "packages", "template-catalog", "templates");
        var names = Directory.GetFiles(directory, "*.nix").Order(StringComparer.Ordinal).ToList();
        Assert.Equal(22, names.Count);
        var validator = new Nix.Domain.Templates.TemplateDefinitionValidator();
        foreach (var path in names)
        {
            var name = Path.GetFileName(path);
            var plan = await TemplatePlanner.ParseAsync(FileSource(path, "nix", name, name, "application/x-nix-template"), Limits, Token);
            Assert.Equal(Path.GetFileNameWithoutExtension(name), plan.Profile.Key);
            Assert.True(plan.ItemCount >= 5 && plan.BodyCount > 0 && plan.ViewCount > 0, name);

            // The work templates keep their tasks under a container; the personal ones are a
            // collection at the root, which is what the library card previews.
            if (plan.Items.Any(item => item.Title == "Action items"))
            {
                Assert.Contains(plan.Items, item => item.Schema is { ValueKind: JsonValueKind.Object } schema && schema.GetRawText().Contains("\"type\":\"assignee\"", StringComparison.Ordinal));
            }
            else
            {
                Assert.True(plan.Items[0].Views is { ValueKind: JsonValueKind.Object }, name);
            }

            // Core's strict import rules: every view must be readable and point at declared
            // properties of the right type, and habit settings must parse.
            foreach (var item in plan.Items)
            {
                var properties = Raw(item.Properties);
                Assert.Null(Nix.Domain.Items.ReservedPropertyContent.Refuse(properties));
                if (Raw(item.Schema) is { } schema)
                {
                    var refusal = validator.ValidateEnvelope(properties, schema, Raw(item.Views));
                    Assert.True(refusal is null, $"{name}/{item.Title}: {refusal}");
                }
            }
        }

        static string? Raw(JsonElement? value) =>
            value is { ValueKind: not (JsonValueKind.Null or JsonValueKind.Undefined) } element ? element.GetRawText() : null;
    }

    private static readonly string[] NativeTypes =
    [
        "text", "number", "select", "multi_select", "date", "checkbox", "url", "timestamp", "image",
        "due_date", "start_date", "completion", "priority", "estimate", "assignee", "formula", "rollup", "datetime", "reminder", "long_text",
    ];

    private static string NativeDefinitions() => "[" + string.Join(',', NativeTypes.Select(NativeDefinition)) + "]";

    private static string NativeDefinition(string type)
    {
        var options = type is "select" or "multi_select" ? "[\"Open\",\"Done\"]" : "[]";
        var expression = type == "formula" ? "\"[number] * 2\"" : "null";
        var (aggregate, source) = type == "rollup" ? ("\"sum\"", "\"number\"") : ("null", "null");
        return $$"""{"key":"{{type}}","label":"{{type}}","type":"{{type}}","required":false,"options":{{options}},"expression":{{expression}},"aggregate":{{aggregate}},"source":{{source}}}""";
    }

    /// <summary>A one-note archive whose root effective schema carries the given definitions in one position.</summary>
    private static ImportSource SchemaArchive(string properties, string declared)
    {
        var schema = Element($$"""{"properties":{{properties}},"declared":{{declared}},"inherit":true}""");
        return Zip(
            "schema.nix",
            "nix",
            ("manifest.json", Json(Manifest(1, [ManifestItem(Root, null, "1", "Root", "note")], rootEffectiveSchema: schema))),
            ("items/" + Root + ".json", Json(Bundle(Root, null, "1", "Root", "note", null))));
    }

    [Fact]
    public async Task Nix_schema_accepts_every_native_property_type()
    {
        foreach (var type in NativeTypes)
        {
            var definition = "[" + NativeDefinition(type) + "]";
            await ImportPlanner.ParseAsync(SchemaArchive(definition, definition), Limits, Token);
        }
    }

    public static TheoryData<string> MalformedComputed() =>
    [
        """{"key":"assignee","type":"principal"}""",
        """{"key":"total","type":"formula"}""",
        """{"key":"total","type":"formula","expression":null}""",
        """{"key":"total","type":"formula","expression":"  "}""",
        """{"key":"total","type":"formula","expression":42}""",
        """{"key":"total","type":"formula","expression":""" + "\"" + new string('a', 1025) + "\"}",
        """{"key":"total","type":"formula","expression":""" + "\"" + string.Concat(Enumerable.Repeat("\U00010000", 513)) + "\"}",
        """{"key":"total","type":"formula","expression":"1","required":true}""",
        """{"key":"total","type":"formula","expression":"1","options":["One"]}""",
        """{"key":"total","type":"formula","expression":"1","aggregate":"count"}""",
        """{"key":"total","type":"rollup"}""",
        """{"key":"total","type":"rollup","aggregate":null}""",
        """{"key":"total","type":"rollup","aggregate":"median","source":"number"}""",
        """{"key":"total","type":"rollup","aggregate":42}""",
        """{"key":"total","type":"rollup","aggregate":"sum"}""",
        """{"key":"total","type":"rollup","aggregate":"sum","source":null}""",
        """{"key":"total","type":"rollup","aggregate":"count","source":" "}""",
        """{"key":"total","type":"rollup","aggregate":"sum","source":42}""",
        """{"key":"total","type":"rollup","aggregate":"sum","source":"total"}""",
        """{"key":"total","type":"rollup","aggregate":"count","required":true}""",
        """{"key":"total","type":"rollup","aggregate":"count","options":["One"]}""",
        """{"key":"total","type":"rollup","aggregate":"count","expression":"1"}""",
        """{"key":"text","type":"text","expression":"1"}""",
        """{"key":"text","type":"text","aggregate":"count"}""",
        """{"key":"text","type":"text","source":"number"}""",
    ];

    [Theory]
    [MemberData(nameof(MalformedComputed))]
    public async Task Nix_schema_rejects_malformed_computed_declarations(string definition)
    {
        var encoded = "[" + definition + "]";
        await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(SchemaArchive(encoded, "[]"), Limits, Token));
        await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(SchemaArchive("[]", encoded), Limits, Token));
    }

    [Theory]
    [InlineData("""{"key":"text","type":"text","expression":null,"aggregate":null,"source":null}""")]
    [InlineData("""{"key":"total","type":"formula","expression":"1","aggregate":null,"source":null}""")]
    [InlineData("""{"key":"total","type":"rollup","aggregate":"count","expression":null,"source":null}""")]
    [InlineData("""{"key":"total","type":"rollup","aggregate":"count"}""")]
    [InlineData("""{"key":"total","type":"rollup","aggregate":"sum","source":"number"}""")]
    [InlineData("""{"key":"total","type":"rollup","aggregate":"min","source":"number"}""")]
    [InlineData("""{"key":"total","type":"rollup","aggregate":"max","source":"number"}""")]
    [InlineData("""{"key":"total","type":"rollup","aggregate":"average","source":"number"}""")]
    [InlineData("""{"key":"total","type":"rollup","aggregate":"any","source":"checkbox"}""")]
    [InlineData("""{"key":"total","type":"rollup","aggregate":"all","source":"checkbox"}""")]
    public async Task Nix_schema_accepts_nullable_metadata_and_all_rollup_aggregates(string definition)
    {
        var encoded = "[" + definition + "]";
        await ImportPlanner.ParseAsync(SchemaArchive(encoded, encoded), Limits, Token);
    }

    [Fact]
    public async Task Nix_schema_counts_formula_length_in_utf16_units()
    {
        var astral = string.Concat(Enumerable.Repeat("\U00010000", 512));
        var encoded = """[{"key":"total","type":"formula","expression":""" + "\"" + astral + "\"}]";
        await ImportPlanner.ParseAsync(SchemaArchive(encoded, encoded), Limits, Token);
    }

    [Fact]
    public async Task Computed_schemas_survive_ordinary_and_template_preview_and_commit()
    {
        var rootDefinitions = NativeDefinitions();
        const string childDefinitions = """[{"key":"child_total","label":"Child total","type":"formula","expression":"IF([number] > 0, [number] * 2, 0)","options":[],"required":false,"aggregate":null,"source":null},{"key":"child_count","label":"Children","type":"rollup","aggregate":"count","source":null,"expression":null,"options":[],"required":false}]""";
        var childEffective = rootDefinitions[..^1] + "," + childDefinitions[1..];
        var rootSchema = Element($$"""{"properties":{{rootDefinitions}},"declared":[],"inherit":true}""");
        var childSchema = Element($$"""{"properties":{{childEffective}},"declared":{{childDefinitions}},"inherit":true}""");
        var profile = Element("""{"kind":"template","version":1,"key":"computed.properties","name":"Computed properties","description":"","includeBody":false,"includeChildren":true}""");
        var source = Zip(
            "computed.nix",
            "nix",
            ("manifest.json", Json(Manifest(1, [ManifestItem(Root, null, "1", "Root", "note"), ManifestItem(Child, Root, "2", "Child", "note")], rootEffectiveSchema: rootSchema, profile: profile, schemaVersion: 7))),
            ("items/" + Root + ".json", Json(Bundle(Root, null, "1", "Root", "note", null, schema: rootSchema))),
            ("items/" + Child + ".json", Json(Bundle(Child, Root, "2", "Child", "note", null, schema: childSchema))));

        void AssertSchemas(JsonElement? root, JsonElement? child)
        {
            Assert.True(JsonElement.DeepEquals(Element(rootDefinitions), root!.Value.GetProperty("properties")));
            Assert.False(root.Value.GetProperty("inherit").GetBoolean());
            Assert.True(JsonElement.DeepEquals(Element(childDefinitions), child!.Value.GetProperty("properties")));
            Assert.True(child.Value.GetProperty("inherit").GetBoolean());
        }

        var plan = await ImportPlanner.ParseAsync(source, Limits, Token);
        AssertSchemas(plan.Items[0].Schema, plan.Items[1].Schema);
        var (encoded, digest) = ImportPlanner.Encode(plan, Limits.MaxPlanBytes);
        var committed = ImportPlanner.Decode(encoded, digest, Limits);
        AssertSchemas(committed.Items[0].Schema, committed.Items[1].Schema);

        var template = await TemplatePlanner.ParseAsync(source, Limits, Token);
        AssertSchemas(template.Items[0].Schema, template.Items[1].Schema);
        var (templateBody, templateDigest) = TemplatePlanner.Encode(template, Limits.MaxPlanBytes);
        var templateCommitted = TemplatePlanner.Decode(templateBody, templateDigest, Limits);
        AssertSchemas(templateCommitted.Items[0].Schema, templateCommitted.Items[1].Schema);
    }
}
