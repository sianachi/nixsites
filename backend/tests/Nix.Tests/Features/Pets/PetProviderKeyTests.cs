using Microsoft.AspNetCore.DataProtection;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Pets;
using Nix.Domain.Tenancy;
using Nix.Features.Pets;
using Nix.Persistence;

namespace Nix.Tests.Features.Pets;

public sealed class PetProviderKeyTests
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public void Only_keyed_providers_take_keys_and_a_key_must_look_like_one()
    {
        Assert.True(PetProviders.IsValid("chatgpt"));
        Assert.True(PetProviders.NeedsKey("anthropic"));
        Assert.True(PetProviders.NeedsKey("openrouter"));
        Assert.True(PetProviders.NeedsKey("openai"));
        Assert.True(PetProviders.IsValid("openai"));
        Assert.False(PetProviders.NeedsKey("chatgpt"));
        Assert.False(PetProviders.IsValid("gemini"));
        Assert.True(PetProviders.IsPlausibleKey("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"));
        Assert.False(PetProviders.IsPlausibleKey("short"));
        Assert.False(PetProviders.IsPlausibleKey("has a space in it which is never a key"));
        Assert.False(PetProviders.IsPlausibleKey(new string('k', 513)));
    }

    [Fact]
    public async Task A_saved_key_is_stored_protected_listed_by_hint_only_and_forgotten_on_remove()
    {
        var session = new ScopedNixSessionContextAccessor();
        var context = new NixSessionContext(TenantId.Create(), null, PrincipalId.Create());
        session.Set(context);
        var store = new MemoryStore();
        var protector = new PetProviderKeyProtector(new EphemeralDataProtectionProvider());

        var saved = await new SavePetProviderKeyHandler(store, protector, session)
            .HandleAsync(new("anthropic", " sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789-WXYZ "), Cancellation);
        Assert.True(saved.IsSuccess);
        Assert.Equal("WXYZ", saved.Value.KeyHint);

        var row = Assert.Single(store.Rows);
        Assert.DoesNotContain("abcdefghijklmnop", System.Text.Encoding.UTF8.GetString(row.ProtectedKey.ToArray()), StringComparison.Ordinal);
        Assert.Equal("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789-WXYZ", protector.Unprotect(row.ProtectedKey));

        var listed = await new ListPetProviderKeysHandler(store, session).HandleAsync(new(), Cancellation);
        Assert.Equal("anthropic", Assert.Single(listed.Keys).Provider);
        Assert.DoesNotContain("sk-ant", System.Text.Json.JsonSerializer.Serialize(listed), StringComparison.Ordinal);

        var unknown = await new SavePetProviderKeyHandler(store, protector, session).HandleAsync(new("chatgpt", "sk-xxxxxxxxxxxxxxxxxxxxxxxx"), Cancellation);
        Assert.True(unknown.IsFailure);
        Assert.Equal("pets.unknown_provider", unknown.Error.Code);
        var bad = await new SavePetProviderKeyHandler(store, protector, session).HandleAsync(new("openrouter", "nope"), Cancellation);
        Assert.Equal("pets.invalid_key", bad.Error.Code);

        var removed = await new RemovePetProviderKeyHandler(store, session).HandleAsync(new("anthropic"), Cancellation);
        Assert.True(removed.IsSuccess && removed.Value);
        Assert.Empty(store.Rows);
        var again = await new RemovePetProviderKeyHandler(store, session).HandleAsync(new("anthropic"), Cancellation);
        Assert.True(again.IsSuccess);
        Assert.False(again.Value);
    }

    private sealed class MemoryStore : IPetProviderCredentialStore
    {
        public List<PetProviderCredential> Rows { get; } = [];

        public ValueTask<PetProviderCredential?> FindAsync(TenantId tenantId, PrincipalId principalId, string provider, CancellationToken cancellationToken) =>
            ValueTask.FromResult(Rows.FirstOrDefault(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Provider == provider));

        public ValueTask<IReadOnlyList<PetProviderCredential>> ListAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
            ValueTask.FromResult<IReadOnlyList<PetProviderCredential>>(Rows.Where(row => row.TenantId == tenantId && row.PrincipalId == principalId).ToList());

        public Task SaveAsync(PetProviderCredential credential, CancellationToken cancellationToken)
        {
            Rows.RemoveAll(row => row.TenantId == credential.TenantId && row.PrincipalId == credential.PrincipalId && row.Provider == credential.Provider);
            Rows.Add(credential);
            return Task.CompletedTask;
        }

        public Task<bool> RemoveAsync(TenantId tenantId, PrincipalId principalId, string provider, CancellationToken cancellationToken) =>
            Task.FromResult(Rows.RemoveAll(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Provider == provider) == 1);
    }
}
