using System.Reflection;
using System.Text.Json;
using Nix.Features.Pets;

namespace Nix.Tests.Features.Pets;

public sealed class PetPlanProtocolTests
{
    [Fact]
    public void Two_concrete_effects_are_one_plan_result()
    {
        var result = Parse("""
            {"kind":"plan","summary":"Rename the brief and add a checklist.","steps":[
              {"capability":"workspace.rename_item","arguments":{"itemId":"brief","title":"Release brief"}},
              {"capability":"comment.add","arguments":{"text":"Ready to review"}}
            ]}
            """);

        Assert.NotNull(result);
        Assert.Equal("plan", Property(result, "Kind"));
        Assert.Equal("Rename the brief and add a checklist.", Property(result, "Text"));
    }

    [Theory]
    [InlineData("{\"kind\":\"plan\",\"summary\":\"Rename\",\"steps\":[]}")]
    [InlineData("{\"kind\":\"plan\",\"summary\":\"Rename\",\"steps\":[{\"capability\":\"not.offered\",\"arguments\":{}}]}")]
    [InlineData("{\"kind\":\"plan\",\"summary\":\"Rename\",\"steps\":[{\"capability\":\"comment.add\",\"arguments\":{},\"approve\":true}]}")]
    [InlineData("{\"kind\":\"plan\",\"summary\":\"Rename\",\"steps\":[{\"capability\":\"comment.add\",\"arguments\":[]} ]}")]
    [InlineData("{\"kind\":\"plan\",\"summary\":\"Rename\",\"steps\":[{\"capability\":\"comment.add\",\"arguments\":{}}],\"approve\":true}")]
    [InlineData("{\"kind\":\"plan\",\"kind\":\"plan\",\"summary\":\"Rename\",\"steps\":[{\"capability\":\"comment.add\",\"arguments\":{}}]}")]
    public void Invalid_or_authority_shaped_plan_results_are_refused(string output) => Assert.Null(Parse(output));

    [Fact]
    public void A_plan_cannot_exceed_twelve_effects()
    {
        var steps = Enumerable.Repeat("{\"capability\":\"comment.add\",\"arguments\":{}}", 13);
        Assert.Null(Parse("{\"kind\":\"plan\",\"summary\":\"Comments\",\"steps\":[" + string.Join(',', steps) + "]}"));
    }

    [Fact]
    public void Legacy_mode_does_not_accept_a_whole_plan()
    {
        Assert.Null(Parse("{\"kind\":\"plan\",\"summary\":\"A comment\",\"steps\":[{\"capability\":\"comment.add\",\"arguments\":{}}]}", planMode: false));
    }

    [Theory]
    [InlineData("{\"kind\":\"action\",\"capability\":\"comment.add\",\"arguments\":{}}", "action")]
    [InlineData("{\"kind\":\"question\",\"text\":\"Which brief?\"}", "question")]
    [InlineData("{\"kind\":\"complete\",\"text\":\"Ready\"}", "complete")]
    public void Legacy_results_retain_their_meaning(string output, string kind) => Assert.Equal(kind, Property(Parse(output), "Kind"));

    [Fact]
    public void Plan_scope_questions_cannot_expand_access_but_legacy_scope_requests_remain()
    {
        const string output = "{\"kind\":\"scope\",\"scope\":\"ability\",\"text\":\"Use a canvas\",\"ability\":\"canvas.plan\"}";
        Assert.Null(Parse(output, planMode: true));
        Assert.Equal("scope", Property(Parse(output, planMode: false), "Kind"));
    }

    private static object? Property(object? value, string name) => value?.GetType().GetProperty(name)?.GetValue(value);

    private static object? Parse(string output, bool planMode = true)
    {
        var method = typeof(PetWorkerClient).GetMethod("ParseTaskStep", BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(method);
        var assembly = typeof(PetWorkerClient).Assembly;
        var requestType = assembly.GetType("Nix.Features.Pets.PetInlineWorkerRequest");
        var preparedType = assembly.GetType("Nix.Features.Pets.PreparedPetTaskStep");
        Assert.NotNull(requestType);
        Assert.NotNull(preparedType);
        var requestArguments = requestType.GetConstructors().Single().GetParameters()
            .Select(parameter => parameter.HasDefaultValue ? parameter.DefaultValue : parameter.ParameterType == typeof(string) ? "" : null)
            .ToArray();
        var request = Activator.CreateInstance(requestType, requestArguments);
        Assert.NotNull(request);
        var prepared = Activator.CreateInstance(preparedType,
            [request, new HashSet<string>(["workspace.rename_item", "comment.add"], StringComparer.Ordinal), new HashSet<string>(["canvas.plan"], StringComparer.Ordinal), planMode]);
        Assert.NotNull(prepared);
        try
        {
            return method.Invoke(null, [output, prepared]);
        }
        catch (TargetInvocationException error) when (error.InnerException is JsonException)
        {
            return null;
        }
    }
}
