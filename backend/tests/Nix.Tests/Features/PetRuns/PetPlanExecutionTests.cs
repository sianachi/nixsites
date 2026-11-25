using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Nix.Abstractions.PetRuns;

namespace Nix.Tests.Features.PetRuns;

public sealed class PetPlanExecutionTests
{
    private static readonly Assembly Product = typeof(PetRunRecord).Assembly;
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    private const string StepId = "11111111-1111-4111-8111-111111111111";
    private const string ItemId = "22222222-2222-4222-8222-222222222222";

    [Theory]
    [InlineData("POST", "/internal/pet-plans/requests/issue", true)]
    [InlineData("POST", "/internal/pet-plans/requests/consume", true)]
    [InlineData("POST", "/internal/pet-plans/requests/settle", true)]
    [InlineData("POST", "/internal/pet-plans/executions/complete", true)]
    [InlineData("POST", "/internal/pet-plans/requests/11111111-1111-4111-8111-111111111111/result", true)]
    [InlineData("GET", "/internal/pet-plans/requests/issue", false)]
    [InlineData("POST", "/internal/pet-plans/requests", false)]
    [InlineData("POST", "/internal/pet-plans/requests/issue/extra", false)]
    [InlineData("POST", "/internal/pet-plans/requests/not-a-guid/result", false)]
    [InlineData("POST", "/internal/pet-plans/requests/11111111-1111-4111-8111-111111111111/result/extra", false)]
    public void Only_exact_private_post_callbacks_use_service_authentication(string method, string path, bool allowed)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = path;
        var actual = Product.GetType("Nix.Features.PetRuns.PetPlanDispatchEndpoints")!.GetMethod("IsServiceCallback", BindingFlags.Static | BindingFlags.NonPublic)!
            .Invoke(null, [context.Request]);
        Assert.Equal(allowed, actual);
    }

    [Theory]
    [InlineData("title-field", "\"New title\"", true)]
    [InlineData("itemId", "\"33333333-3333-4333-8333-333333333333\"", false)]
    [InlineData("title-field", "17", false)]
    public void Only_a_stored_field_identity_and_its_stated_type_can_edit_prepared_arguments(string fieldId, string value, bool allowed)
    {
        var result = Edit($$"""[{"stepId":"{{StepId}}","fieldId":"{{fieldId}}","value":{{value}}}]""");
        Assert.Equal(allowed, Succeeded(result));
        if (allowed)
        {
            var prepared = JsonSerializer.SerializeToElement(result.GetType().GetProperty("Value")!.GetValue(result), Web);
            Assert.Equal("New title", prepared[0].GetProperty("arguments").GetProperty("title").GetString());
            Assert.Equal(ItemId, prepared[0].GetProperty("arguments").GetProperty("itemId").GetString());
        }
    }

    [Fact]
    public void Repeating_a_field_or_targeting_another_step_cannot_expand_an_edit()
    {
        Assert.False(Succeeded(Edit($$"""[{"stepId":"{{StepId}}","fieldId":"title-field","value":"One"},{"stepId":"{{StepId}}","fieldId":"title-field","value":"Two"}]""")));
        Assert.False(Succeeded(Edit("""[{"stepId":"44444444-4444-4444-8444-444444444444","fieldId":"title-field","value":"One"}]""")));
    }

    [Fact]
    public void Literal_json_text_is_preserved_as_text_when_a_supported_field_changes()
    {
        const string text = "{\"sample\":false,\"count\":0}";
        var result = Edit($$"""[{"stepId":"{{StepId}}","fieldId":"title-field","value":{{JsonSerializer.Serialize(text)}}}]""");
        Assert.True(Succeeded(result));
        var prepared = JsonSerializer.SerializeToElement(result.GetType().GetProperty("Value")!.GetValue(result), Web);
        Assert.Equal(text, prepared[0].GetProperty("arguments").GetProperty("title").GetString());
    }

    [Theory]
    [InlineData("{\"kind\":\"workspace\"}", true)]
    [InlineData("{\"kind\":\"selected\",\"itemIds\":[]}", true)]
    [InlineData("{\"kind\":\"subtree\"}", false)]
    [InlineData("{\"kind\":\"workspace\",\"itemIds\":[\"22222222-2222-4222-8222-222222222222\"]}", false)]
    [InlineData("{\"kind\":\"selected\",\"itemIds\":[\"00000000-0000-0000-0000-000000000000\"]}", false)]
    public void Workspace_scope_needs_no_invented_anchor_and_rejects_hidden_source_expansion(string json, bool allowed)
    {
        var scope = JsonSerializer.Deserialize(json, Type("PetPlanSourceScope"), Web);
        var actual = Product.GetType("Nix.Features.PetRuns.PetPlanExecution")!.GetMethod("ValidScope", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, [scope, null]);
        Assert.Equal(allowed, actual);
    }

    [Theory]
    [InlineData("GetItem", "Core completed GetItem (200).\n{\"title\":\"Named source\"}", true)]
    [InlineData("GetItemBody", "Core completed GetItemBody (200).\n{\"literal\":true}", false)]
    [InlineData("GetItem", "{\"literal\":true}", false)]
    [InlineData("GetItem", "Core completed GetItem (200).\nnot JSON", false)]
    public void Only_the_known_Core_read_receipt_grammar_projects_machine_details(string operation, string receipt, bool details)
    {
        var step = JsonSerializer.Deserialize(JsonSerializer.Serialize(new
        {
            id = Guid.Parse(StepId),
            capability = "nix.action",
            arguments = new { operationId = operation },
            effect = new { description = "Read named source", parameters = new { operationId = operation } },
            executor = "server",
            status = "applied",
            fields = Array.Empty<object>(),
            receipt,
        }), Type("PetPlanPreparedStep"), Web);
        var view = Product.GetType("Nix.Features.PetRuns.PetRunService")!.GetMethod("ReceiptView", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, [step]);
        var actual = JsonSerializer.SerializeToElement(view, Web);
        Assert.Equal(details, actual.GetProperty("details").ValueKind != JsonValueKind.Null);
        if (!details)
        {
            Assert.Equal(receipt, actual.GetProperty("text").GetString());
        }
    }

    [Fact]
    public void Replacement_receipts_keep_every_status_and_bound_private_text_and_source_provenance()
    {
        var fullReceipt = string.Concat(Enumerable.Repeat("漢\0\"", 1_000));
        var statuses = Enumerable.Range(1, 12).Select(index => index == 12 ? "unknown" : index == 11 ? "partial" : "applied").ToArray();
        var plan = JsonSerializer.Deserialize(JsonSerializer.Serialize(new
        {
            id = Guid.NewGuid(),
            version = 2,
            summary = "Reviewed replacement",
            reviewDigest = "digest",
            scopeDigest = "scope",
            recipientRevision = "recipient",
            status = "review_required",
            steps = statuses.Select((status, index) => new
            {
                id = Guid.NewGuid(),
                capability = "workspace.rename_item",
                arguments = new { title = "Reviewed title" },
                effect = new { description = $"Replacement step {index + 1}", parameters = new { } },
                executor = "server",
                status,
                fields = Array.Empty<object>(),
                receipt = fullReceipt,
            }),
        }), Type("PetPlanPrepared"), Web);
        var service = Product.GetType("Nix.Features.PetRuns.PetRunService")!;
        var aggregate = Assert.IsType<string>(service.GetMethod("AggregateSourceReceipt", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, [plan, new HashSet<Guid>()]));
        for (var index = 0; index < statuses.Length; index++)
        {
            Assert.Contains($"{index + 1}. {statuses[index]}: Replacement step {index + 1}", aggregate, StringComparison.Ordinal);
        }
        Assert.True(JsonEncodedText.Encode(aggregate).EncodedUtf8Bytes.Length <= 12_000);
        var unchanged = JsonSerializer.SerializeToElement(plan, Web);
        Assert.Equal(fullReceipt, unchanged.GetProperty("steps")[11].GetProperty("receipt").GetString());
        var binding = JsonSerializer.Deserialize(JsonSerializer.Serialize(new
        {
            toolId = new string('漢', 200),
            runId = Guid.NewGuid(),
            planId = Guid.NewGuid(),
            planVersion = 2,
            reviewDigest = new string('a', 64),
            stepId = Guid.NewGuid(),
        }), Type("PetPlanToolBinding"), Web);
        var sources = Enumerable.Range(1, 140).Select(index => Guid.Parse($"00000000-0000-4000-8000-{index:D12}")).ToArray();
        var payload = Assert.IsType<JsonObject>(service.GetMethod("SourceReceiptPayload", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, [binding, false, aggregate, false, sources, false]));
        Assert.Equal(128, payload["sourceItemIds"]!.AsArray().Count);
        Assert.True(payload["unboundedSourceProvenance"]!.GetValue<bool>());
        var wire = JsonSerializer.SerializeToUtf8Bytes(new { planPayload = payload.ToJsonString() }, Web);
        Assert.True(wire.Length < 64_000);
    }

    private static object Edit(string edits)
    {
        var plan = JsonSerializer.Deserialize("""
            {"id":"55555555-5555-4555-8555-555555555555","version":1,"summary":"Rename the named item","reviewDigest":"digest","scopeDigest":"scope","recipientRevision":"recipient","status":"awaiting_review",
             "steps":[{"id":"STEP_ID","capability":"task.rename","arguments":{"title":"Old title","itemId":"ITEM_ID"},"effect":{"description":"Rename the item","parameters":{"from":"Old title","to":"New title"}},"executor":"server","status":"pending",
             "fields":[{"id":"title-field","label":"Title","kind":"text","value":"Old title","argumentPath":["title"]}]}]}
            """.Replace("STEP_ID", StepId, StringComparison.Ordinal).Replace("ITEM_ID", ItemId, StringComparison.Ordinal), Type("PetPlanPrepared"), Web);
        var editList = JsonSerializer.Deserialize(edits, typeof(IReadOnlyList<>).MakeGenericType(Type("PetPlanFieldEdit")), Web);
        return Product.GetType("Nix.Features.PetRuns.PetPlanExecution")!.GetMethod("Edit", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, [plan, editList])!;
    }

    private static Type Type(string name) => Product.GetType("Nix.Features.PetRuns." + name, throwOnError: true)!;
    private static bool Succeeded(object result) => (bool)result.GetType().GetProperty("IsSuccess")!.GetValue(result)!;
}
