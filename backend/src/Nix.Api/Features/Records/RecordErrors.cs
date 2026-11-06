using Nix.Domain.Primitives;
using Nix.Domain.Properties;

namespace Nix.Features.Records;

/// <summary>The stable codes of the record features, and the status each implies.</summary>
public static class RecordErrors
{
    /// <summary>A unique field's value already belongs to another item.</summary>
    public const string KeyConflictCode = "records.key_conflict";

    /// <summary>The record the key names is in Trash.</summary>
    public const string TrashedCode = "record.trashed";

    /// <summary>A value cannot be a key (too long, not an address).</summary>
    public const string KeyInvalidCode = "records.key_invalid";

    /// <summary>The upsert's key field is not declared unique on the parent.</summary>
    public const string NotUniqueCode = "records.not_unique_field";

    /// <summary>An idempotency key was reused with a different request.</summary>
    public const string IdempotencyConflictCode = "records.idempotency_conflict";

    /// <summary>Turning unique on found duplicates.</summary>
    public const string DuplicateValuesCode = "schema.unique_duplicates";

    /// <summary>A batch is over 100 rows or a create row has no idempotency key.</summary>
    public const string BatchInvalidCode = "records.batch_invalid";

    /// <summary>The status a record code implies, or null for a code this feature does not own.</summary>
    /// <param name="code">The error code.</param>
    /// <returns>The HTTP status, or null.</returns>
    internal static int? StatusOf(string code) => code switch
    {
        KeyConflictCode or TrashedCode or IdempotencyConflictCode or DuplicateValuesCode => StatusCodes.Status409Conflict,
        KeyInvalidCode or NotUniqueCode or BatchInvalidCode => StatusCodes.Status422UnprocessableEntity,
        _ => null,
    };

    /// <summary>Another item holds the value.</summary>
    /// <param name="field">The unique field.</param>
    /// <param name="existing">The holder, or null when the caller may not be told which.</param>
    /// <returns>The error.</returns>
    public static NixError KeyConflict(string field, Guid? existing) =>
        new(KeyConflictCode, $"Another record already has this value for the unique field '{field}'.") { ExistingItemId = existing };

    /// <summary>The holder is in Trash.</summary>
    /// <param name="field">The unique field.</param>
    /// <param name="existing">The trashed item.</param>
    /// <returns>The error.</returns>
    public static NixError Trashed(string field, Guid? existing) =>
        new(TrashedCode, $"The record with this '{field}' is in Trash. Restore it instead of creating a duplicate.") { ExistingItemId = existing };

    /// <summary>A value cannot be a key.</summary>
    /// <param name="field">The unique field.</param>
    /// <param name="reason">Why.</param>
    /// <returns>The error.</returns>
    public static NixError KeyInvalid(string field, string reason) =>
        new(KeyInvalidCode, $"'{field}' {reason}") { Violations = [new PropertyViolation(field, reason)] };
}
