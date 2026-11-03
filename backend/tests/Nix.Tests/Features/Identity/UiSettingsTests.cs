using System.Text.Json;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Settings;
using Nix.Domain.Tenancy;
using Nix.Features.CurrentUser;
using Nix.Persistence;

namespace Nix.Tests.Features.Identity;

public sealed class UiSettingsTests
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static Dictionary<string, JsonElement> Patch(string json) =>
        JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;

    [Fact]
    public void Every_allow_listed_key_accepts_its_type_and_null()
    {
        Assert.Null(UiSettingsValidation.Check(Patch("""
            {"editor.keyboardMode":"vim","editor.textWidth":"full","editor.pageGuides":false,
             "editor.phraseSuggestions":true,"editor.unlinkedMentionUnderline":true,
             "editor.viewSuggestions":"off","editor.choiceOrder":"on","dailyNotes.openTodayOnStart":true,
             "sites.publishingEnabled":false,"graph.openMode":"beside","shell.statusBar":false}
            """)));
        Assert.Null(UiSettingsValidation.Check(Patch("""{"editor.keyboardMode":null,"editor.pageGuides":null,"graph.openMode":null}""")));
        Assert.Null(UiSettingsValidation.Check(Patch("{}")));
    }

    [Fact]
    public void An_unknown_key_is_refused()
    {
        var refused = UiSettingsValidation.Check(Patch("""{"editor.pageGuides":true,"theme.accent":"red"}"""));
        Assert.Equal(UiSettingsValidation.InvalidCode, refused?.Code);
        Assert.Equal(UiSettingsValidation.InvalidCode, UiSettingsValidation.Check(null)?.Code);
    }

    [Theory]
    [InlineData("""{"editor.pageGuides":"true"}""")]
    [InlineData("""{"editor.pageGuides":1}""")]
    [InlineData("""{"editor.keyboardMode":true}""")]
    [InlineData("""{"editor.keyboardMode":"nano"}""")]
    [InlineData("""{"editor.textWidth":"Full"}""")]
    [InlineData("""{"graph.openMode":["tab"]}""")]
    [InlineData("""{"graph.openMode":{}}""")]
    public void A_value_of_the_wrong_type_or_an_unknown_option_is_refused(string json) =>
        Assert.Equal(UiSettingsValidation.InvalidCode, UiSettingsValidation.Check(Patch(json))?.Code);

    [Fact]
    public void A_patch_over_sixteen_kibibytes_is_refused_as_too_large()
    {
        var big = new Dictionary<string, JsonElement>
        {
            ["editor.keyboardMode"] = JsonSerializer.SerializeToElement(new string('x', UiSettingsValidation.MaximumBytes)),
        };
        Assert.Equal(UiSettingsValidation.TooLargeCode, UiSettingsValidation.Check(big)?.Code);
    }

    [Fact]
    public void A_retired_key_can_be_deleted_with_null_but_not_set_and_a_malformed_name_is_refused()
    {
        Assert.Null(UiSettingsValidation.Check(Patch("""{"editor.retiredSetting":null,"editor.pageGuides":true}""")));
        Assert.Equal(UiSettingsValidation.InvalidCode, UiSettingsValidation.Check(Patch("""{"editor.retiredSetting":true}"""))?.Code);
        Assert.Equal(UiSettingsValidation.InvalidCode, UiSettingsValidation.Check(Patch("""{"not a key!":null}"""))?.Code);
        Assert.Equal(UiSettingsValidation.InvalidCode, UiSettingsValidation.Check(Patch("""{"nodot":null}"""))?.Code);
        Assert.Equal(UiSettingsValidation.TooLargeCode, UiSettingsValidation.Check(new Dictionary<string, JsonElement>
        {
            ["editor.retiredSetting"] = JsonSerializer.SerializeToElement(new string('x', UiSettingsValidation.MaximumBytes)),
        })?.Code);
    }

    [Fact]
    public async Task Reading_returns_only_stored_keys_that_pass_the_current_rules_and_a_null_patch_repairs_the_rest()
    {
        var context = new NixSessionContext(TenantId.Create(), null, PrincipalId.Create());
        var session = new ScopedNixSessionContextAccessor();
        session.Set(context);
        var store = new MemoryStore();
        store.Seed(context, """{"editor.keyboardMode":"nano","editor.retiredSetting":true,"editor.pageGuides":false,"graph.openMode":"tab"}""");

        var read = await new GetUiSettingsHandler(store, session).HandleAsync(new(), Cancellation);
        Assert.Equal(["editor.pageGuides", "graph.openMode"], read.Settings.Keys.Order());

        var repaired = await new PatchUiSettingsHandler(store, session).HandleAsync(new(Patch("""{"editor.keyboardMode":null,"editor.retiredSetting":null}""")), Cancellation);
        Assert.True(repaired.IsSuccess);
        Assert.Equal(["editor.pageGuides", "graph.openMode"], repaired.Value.Settings.Keys.Order());
        Assert.DoesNotContain("retiredSetting", store.RawJson, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_patch_sets_keys_and_null_deletes_them_while_other_keys_survive()
    {
        var session = new ScopedNixSessionContextAccessor();
        session.Set(new NixSessionContext(TenantId.Create(), null, PrincipalId.Create()));
        var store = new MemoryStore();
        var handler = new PatchUiSettingsHandler(store, session);

        var first = await handler.HandleAsync(new(Patch("""{"editor.keyboardMode":"vim","editor.pageGuides":false}""")), Cancellation);
        Assert.True(first.IsSuccess);
        Assert.Equal(1, first.Value.Revision);

        var second = await handler.HandleAsync(new(Patch("""{"editor.pageGuides":null,"graph.openMode":"tab"}""")), Cancellation);
        Assert.Equal(2, second.Value.Revision);
        Assert.Equal("vim", second.Value.Settings["editor.keyboardMode"].GetString());
        Assert.Equal("tab", second.Value.Settings["graph.openMode"].GetString());
        Assert.False(second.Value.Settings.ContainsKey("editor.pageGuides"));

        var read = await new GetUiSettingsHandler(store, session).HandleAsync(new(), Cancellation);
        Assert.Equal(2, read.Revision);
        Assert.Equal(2, read.Settings.Count);
    }

    [Fact]
    public async Task A_refused_patch_writes_nothing_and_a_never_written_read_is_empty_at_revision_zero()
    {
        var session = new ScopedNixSessionContextAccessor();
        session.Set(new NixSessionContext(TenantId.Create(), null, PrincipalId.Create()));
        var store = new MemoryStore();

        var refused = await new PatchUiSettingsHandler(store, session).HandleAsync(new(Patch("""{"nope":true}""")), Cancellation);
        Assert.True(refused.IsFailure);
        Assert.Equal(0, store.Writes);

        var read = await new GetUiSettingsHandler(store, session).HandleAsync(new(), Cancellation);
        Assert.Empty(read.Settings);
        Assert.Equal(0, read.Revision);
    }

    // Applies the same merge the SQL does: `||` for set keys, then `-` for removed ones.
    private sealed class MemoryStore : IPrincipalUiSettingsStore
    {
        private PrincipalUiSettings? _saved;

        public int Writes { get; private set; }

        public string? RawJson => _saved?.SettingsJson;

        public void Seed(NixSessionContext context, string json) =>
            _saved = new PrincipalUiSettings { TenantId = context.TenantId, PrincipalId = context.PrincipalId, SettingsJson = json, Revision = 1 };

        public ValueTask<PrincipalUiSettings?> FindAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_saved is { } row && row.TenantId == tenantId && row.PrincipalId == principalId ? row : null);

        public Task<PrincipalUiSettings> MergeAsync(TenantId tenantId, PrincipalId principalId, string setJson, IReadOnlyList<string> removeKeys, CancellationToken cancellationToken)
        {
            var merged = _saved is null ? [] : Patch(_saved.SettingsJson);
            foreach (var (key, value) in Patch(setJson))
            {
                merged[key] = value;
            }

            foreach (var key in removeKeys)
            {
                merged.Remove(key);
            }

            Writes++;
            _saved = new PrincipalUiSettings
            {
                TenantId = tenantId,
                PrincipalId = principalId,
                SettingsJson = JsonSerializer.Serialize(merged),
                Revision = (_saved?.Revision ?? 0) + 1,
            };
            return Task.FromResult(_saved);
        }
    }
}
