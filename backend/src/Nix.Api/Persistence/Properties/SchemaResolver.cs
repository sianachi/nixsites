using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Properties;

/// <summary>
/// Resolves an effective schema by walking the closure chain and merging what it finds.
/// </summary>
/// <remarks>
/// <para>
/// The rules are ADR-0007: nearest ancestor wins per key, <c>inherit: false</c> stops the walk
/// above the item that sets it, and the answer is computed rather than materialised.
/// </para>
/// <para>
/// <b>Answers are deliberately not memoised, and that is not an oversight.</b> The obvious
/// optimisation - cache per unit of work, since a scope is one request against rows only this
/// transaction could be changing - is wrong, because this transaction is exactly what changes
/// them. Declaring a schema and then reading it back, or moving an item and then validating its
/// properties, both happen inside one request; a cache populated before the write answers the read
/// with the state that no longer holds. The cascade property test caught precisely that, and the
/// consequence was not a stale display but validation against the wrong rules.
/// </para>
/// <para>
/// The cost is one indexed query per resolution, and resolutions are per container rather than per
/// item: a listing resolves once for the parent, not once per child. If a profile ever shows that
/// is not enough, ADR-0007 §3 names the escape hatch - a materialised resolution behind this same
/// port - which is a design that has to answer the invalidation question properly rather than
/// assume it away.
/// </para>
/// </remarks>
public sealed class SchemaResolver(
    NixSqlExecutor sql,
    INixSessionContextAccessor session)
    : ISchemaResolver
{
    private readonly INixSessionContextAccessor _session = session;

    private NixSessionContext Session => _session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. Schema resolution "
            + "walks tenant-scoped rows and there is no unscoped path.");

    /// <inheritdoc />
    public async ValueTask<PropertySchema> ResolveForItemAsync(
        ItemId itemId,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var declarations = sql.QueryAsync<string, SchemaRowMapper>(
            SchemaSql.AncestorSchemas,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("item_id", itemId.Value),
            ],
            cancellationToken);

        // Nearest first, so the merge runs outwards and the inherit stop is simply where the loop
        // ends. Merge takes farther-then-nearer, so each step puts what we have so far on the
        // nearer side of the one we just read.
        var effective = PropertySchema.Empty;
        var any = false;

        await foreach (var json in declarations.ConfigureAwait(false))
        {
            var declared = PropertySchemaJson.Read(json);

            effective = any ? PropertySchema.Merge(declared, effective) : declared;
            any = true;

            if (!declared.Inherit)
            {
                // This declaration refuses to inherit, so nothing above it contributes. Stopping
                // here is what makes a scratch item under a heavily-schema'd workspace possible.
                break;
            }
        }

        return effective;
    }

    /// <inheritdoc />
    public async ValueTask<PropertySchema> ResolveForChildrenAsync(
        ItemId? parentId,
        CancellationToken cancellationToken)
    {
        // A workspace root has no ancestors, so its children inherit nothing. Resolving from a
        // parent that does exist is the same question as resolving at that parent: a schema
        // declared on a container applies to the container and to everything under it.
        return parentId is { } parent
            ? await ResolveForItemAsync(parent, cancellationToken).ConfigureAwait(false)
            : PropertySchema.Empty;
    }

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    /// <summary>Reads the declared schema out of an ancestor row.</summary>
    /// <remarks>
    /// A struct so the query loop devirtualises. The depth column is selected for the plan's sake
    /// and for anybody reading the statement; the order it produces is the only thing the caller
    /// needs from it.
    /// </remarks>
    private readonly struct SchemaRowMapper : INixRowMapper<string>
    {
        /// <inheritdoc />
        public string Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);
            return reader.GetString(0);
        }
    }
}
