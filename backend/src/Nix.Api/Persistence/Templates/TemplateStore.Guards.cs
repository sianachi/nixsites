using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Templates;
using Nix.Domain.Audit;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Npgsql;

namespace Nix.Persistence.Templates;

public sealed partial class TemplateStore
{
    private void AddAudit(string action, Guid subjectId, WorkspaceId workspaceId, DateTimeOffset at) =>
        _database.AuditEvents.Add(new AuditEvent
        {
            Id = AuditEventId.Create(),
            TenantId = Context.TenantId,
            WorkspaceId = workspaceId,
            ActorId = Context.PrincipalId,
            Action = action,
            SubjectId = subjectId,
            SubjectType = "template",
            OccurredAt = at,
        });

    private static bool InvalidKey(string value) => string.IsNullOrWhiteSpace(value) || value.Length > 160;

    private static bool SameSet(IEnumerable<ItemId> expected, IEnumerable<ItemId> actual) =>
        expected.ToHashSet().SetEquals(actual);

    private static string OriginText(TemplateOrigin origin) => origin switch
    {
        TemplateOrigin.Seed => "seeded",
        TemplateOrigin.User => "user-authored",
        TemplateOrigin.Managed => "managed",
        _ => throw new ArgumentOutOfRangeException(nameof(origin), origin, "Unknown template origin."),
    };
}
