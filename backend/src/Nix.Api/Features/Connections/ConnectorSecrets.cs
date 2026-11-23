using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace Nix.Features.Connections;

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class ConnectorSecrets(IDataProtectionProvider protection)
{
    private readonly IDataProtector _secrets = protection.CreateProtector("Nix.PetConnectors.Credential.v1");

    internal string Protect(ConnectorCredential token) =>
        _secrets.Protect(JsonSerializer.Serialize(token, ConnectorJsonContext.Default.ConnectorCredential));

    internal ConnectorCredential? Unprotect(string token)
    {
        try
        {
            return JsonSerializer.Deserialize(_secrets.Unprotect(token), ConnectorJsonContext.Default.ConnectorCredential);
        }
        catch (Exception error) when (error is CryptographicException or JsonException)
        {
            return null;
        }
    }
}
