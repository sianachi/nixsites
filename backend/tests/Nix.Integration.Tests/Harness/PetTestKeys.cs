using Microsoft.AspNetCore.DataProtection;
using Nix.Features.Pets;

namespace Nix.Integration.Tests.Harness;

/// <summary>One key ring for tests that store a pet provider key and have a separate host read it back.</summary>
internal static class PetTestKeys
{
    public static PetProviderKeyProtector Protector { get; } = new(new EphemeralDataProtectionProvider());

    public static byte[] ProtectedKey => Protector.Protect("fixture-api-key-abcdefghijklmnopqrstuvwxyz");
}
