using System.Text.Json.Nodes;
using Nix.Domain.Automations;

namespace Nix.Tests.Domain.Automations;

/// <summary>
/// The action list (ADR-0051 section 6): one to five actions, all-or-nothing, strict shapes, and
/// never a write to a key the scheduler or the habit endpoints own.
/// </summary>
public sealed class AutomationActionJsonTests
{
    private static readonly Guid Target = Guid.Parse("0199a000-0000-7000-8000-000000000001");

    [Fact]
    public void Three_action_kinds_read_and_write_back()
    {
        var parsed = AutomationActionJson.ReadAll(JsonNode.Parse($$$"""
            [
              {"type":"set_property","target":"triggering_item","key":"status","value":"done"},
              {"type":"set_property","target":{"itemId":"{{{Target}}}"},"key":"count","value":3},
              {"type":"create_item","parent":"scope","itemType":"task","title":"Review {item.title}","properties":{"priority":"high"}},
              {"type":"notify","title":"Done on {date}","body":"All set"}
            ]
            """));

        Assert.True(parsed.IsValid, string.Join(", ", parsed.Violations));
        Assert.Equal(4, parsed.Value.Length);

        var first = Assert.IsType<SetPropertyAction>(parsed.Value[0]);
        Assert.Equal(AutomationItemReferenceKind.TriggeringItem, first.Target.Kind);
        Assert.Equal("done", first.Value!.GetValue<string>());

        var second = Assert.IsType<SetPropertyAction>(parsed.Value[1]);
        Assert.Equal(AutomationItemReferenceKind.Item, second.Target.Kind);
        Assert.Equal(Target, second.Target.ItemId);

        var create = Assert.IsType<CreateItemAction>(parsed.Value[2]);
        Assert.Equal(AutomationItemReferenceKind.Scope, create.Parent.Kind);
        Assert.Equal("task", create.ItemType);
        Assert.Equal("high", create.Properties!["priority"]!.GetValue<string>());

        var notify = Assert.IsType<NotifyAction>(parsed.Value[3]);
        Assert.Equal("All set", notify.Body);

        var written = AutomationActionJson.WriteAll(parsed.Value);
        var reread = AutomationActionJson.ReadAll(written);
        Assert.True(reread.IsValid);
        Assert.Equal(written.ToJsonString(), AutomationActionJson.WriteAll(reread.Value).ToJsonString());
    }

    [Fact]
    public void A_set_property_may_clear_a_value()
    {
        var parsed = AutomationActionJson.ReadAll(JsonNode.Parse(
            """[{"type":"set_property","target":"triggering_item","key":"status","value":null}]"""));

        var action = Assert.IsType<SetPropertyAction>(Assert.Single(parsed.Value));
        Assert.Null(action.Value);
    }

    [Theory]
    [InlineData("""[]""")]
    [InlineData("""{}""")]
    [InlineData("""[{"type":"set_property","target":"triggering_item","key":"$due_set_by","value":"x"}]""")]
    [InlineData("""[{"type":"set_property","target":"triggering_item","key":"$anything","value":"x"}]""")]
    [InlineData("""[{"type":"set_property","target":"scope","key":"status","value":"x"}]""")]
    [InlineData("""[{"type":"set_property","target":"triggering_item","key":"status"}]""")]
    [InlineData("""[{"type":"set_property","target":{"itemId":"nope"},"key":"status","value":1}]""")]
    [InlineData("""[{"type":"set_property","target":"triggering_item","key":"status","value":1,"extra":true}]""")]
    [InlineData("""[{"type":"create_item","parent":"scope","itemType":"task","title":""}]""")]
    [InlineData("""[{"type":"create_item","parent":"scope","itemType":"","title":"x"}]""")]
    [InlineData("""[{"type":"create_item","parent":"elsewhere","itemType":"task","title":"x"}]""")]
    [InlineData("""[{"type":"create_item","parent":"scope","itemType":"task","title":"x","properties":{"$reminder_set_by":"x"}}]""")]
    [InlineData("""[{"type":"create_item","parent":"scope","itemType":"task","title":"x","properties":[]}]""")]
    [InlineData("""[{"type":"notify","title":""}]""")]
    [InlineData("""[{"type":"send_email","to":"a@b.c"}]""")]
    public void A_malformed_action_list_is_refused(string json)
    {
        var parsed = AutomationActionJson.ReadAll(JsonNode.Parse(json));

        Assert.False(parsed.IsValid);
        Assert.DoesNotContain(parsed.Violations, violation => violation.Unavailable);
    }

    [Fact]
    public void More_than_five_actions_are_refused()
    {
        var actions = new JsonArray();
        for (var index = 0; index < 6; index++)
        {
            actions.Add(new JsonObject { ["type"] = "notify", ["title"] = "Hi" });
        }

        Assert.False(AutomationActionJson.ReadAll(actions).IsValid);
    }

    [Fact]
    public void Over_long_templates_and_bags_are_refused()
    {
        var longTitle = new JsonArray(new JsonObject { ["type"] = "notify", ["title"] = new string('t', 201) });
        var longBody = new JsonArray(new JsonObject { ["type"] = "notify", ["title"] = "t", ["body"] = new string('b', 1001) });
        var longItemTitle = new JsonArray(new JsonObject
        {
            ["type"] = "create_item",
            ["parent"] = "scope",
            ["itemType"] = "task",
            ["title"] = new string('t', 501),
        });
        var bigBag = new JsonArray(new JsonObject
        {
            ["type"] = "create_item",
            ["parent"] = "scope",
            ["itemType"] = "task",
            ["title"] = "t",
            ["properties"] = new JsonObject { ["notes"] = new string('n', 4200) },
        });

        Assert.False(AutomationActionJson.ReadAll(longTitle).IsValid);
        Assert.False(AutomationActionJson.ReadAll(longBody).IsValid);
        Assert.False(AutomationActionJson.ReadAll(longItemTitle).IsValid);
        Assert.False(AutomationActionJson.ReadAll(bigBag).IsValid);
    }

    [Fact]
    public void Create_from_template_is_recognised_but_unavailable_until_its_worker_lane()
    {
        var parsed = AutomationActionJson.ReadAll(JsonNode.Parse(
            """[{"type":"create_from_template","templateId":"0199a000-0000-7000-8000-000000000002"}]"""));

        Assert.False(parsed.IsValid);
        Assert.Contains(parsed.Violations, violation => violation.Unavailable);
    }
}
