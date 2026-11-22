using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Sql;

/// <summary>Typed parameter factories for hand-written SQL; a null value binds as SQL NULL.</summary>
internal static class NixParameter
{
    internal static NpgsqlParameter Uuid(string name, Guid? value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value is { } actual ? actual : DBNull.Value };

    internal static NpgsqlParameter Text(string name, string? value) =>
        new(name, NpgsqlDbType.Text) { Value = value is null ? DBNull.Value : value };

    internal static NpgsqlParameter Integer(string name, int value) =>
        new(name, NpgsqlDbType.Integer) { Value = value };

    internal static NpgsqlParameter Boolean(string name, bool value) =>
        new(name, NpgsqlDbType.Boolean) { Value = value };

    internal static NpgsqlParameter Timestamp(string name, DateTimeOffset? value) =>
        new(name, NpgsqlDbType.TimestampTz) { Value = value is { } actual ? actual : DBNull.Value };

    internal static NpgsqlParameter Date(string name, DateOnly value) =>
        new(name, NpgsqlDbType.Date) { Value = value };

    internal static NpgsqlParameter Json(string name, string? value) =>
        new(name, NpgsqlDbType.Jsonb) { Value = value is null ? DBNull.Value : value };

    internal static NpgsqlParameter UuidArray(string name, Guid[] values) =>
        new(name, NpgsqlDbType.Uuid | NpgsqlDbType.Array) { Value = values };

    internal static NpgsqlParameter TextArray(string name, string[] values) =>
        new(name, NpgsqlDbType.Text | NpgsqlDbType.Array) { Value = values };
}
