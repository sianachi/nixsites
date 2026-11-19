using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Features.PetPeers;

internal sealed record PetPeerTicket(NixSessionContext Session, Guid PetId, Guid PeerId, Guid? WorkId = null, Guid? LeaseId = null)
{
    internal bool IsExecution => WorkId.HasValue;
}

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class PetPeerCredential(IDataProtectionProvider protection)
{
    internal const string Prefix = "nixpeer_";
    private readonly IDataProtector protector = protection.CreateProtector("Nix.PetMcp.Credential.v1");

    internal string Issue(PetPeerTicket ticket) => Prefix + protector.Protect(
        $"{ticket.Session.TenantId.Value:D}:{ticket.Session.PrincipalId.Value:D}:{ticket.Session.WorkspaceId?.Value:D}:{ticket.PetId:D}:{ticket.PeerId:D}:{ticket.WorkId:D}:{ticket.LeaseId:D}");

    internal PetPeerTicket? Read(string? value)
    {
        if (value is null || value.Length > 2048 || !value.StartsWith(Prefix, StringComparison.Ordinal))
        {
            return null;
        }

        string[] parts;
        try
        {
            parts = protector.Unprotect(value[Prefix.Length..]).Split(':');
        }
        catch (Exception error) when (error is CryptographicException or FormatException)
        {
            return null;
        }

        if (parts.Length != 7 || !TryId(parts[0], out var tenant) || !TryId(parts[1], out var actor)
            || !TryId(parts[2], out var workspace) || !TryId(parts[3], out var pet) || !TryId(parts[4], out var peer))
        {
            return null;
        }
        var session = new NixSessionContext(TenantId.From(tenant), WorkspaceId.From(workspace), PrincipalId.From(actor));
        if (parts[5].Length == 0 && parts[6].Length == 0)
        {
            return new PetPeerTicket(session, pet, peer);
        }
        return TryId(parts[5], out var work) && TryId(parts[6], out var lease)
            ? new PetPeerTicket(session, pet, peer, work, lease)
            : null;
    }

    private static bool TryId(string value, out Guid id) =>
        Guid.TryParseExact(value, "D", out id) && id != Guid.Empty;
}
