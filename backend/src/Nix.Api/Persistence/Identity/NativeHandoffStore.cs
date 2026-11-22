using Nix.Abstractions;
using Npgsql;

namespace Nix.Persistence.Identity;

/// <summary>Capability-only Postgres I/O for <see cref="INativeHandoffs"/>.</summary>
public sealed class NativeHandoffStore(NpgsqlDataSource dataSource) : INativeHandoffs
{
    private readonly LocalSignInDb _db = new(dataSource);

    /// <inheritdoc />
    public async ValueTask<bool> CreateAsync(string codeHash, Guid principalId, string challenge, string payload, DateTimeOffset expiresAt, CancellationToken cancellationToken) =>
        await _db.ScalarAsync<bool>(
            "SELECT nix_create_native_handoff(@hash, @principal, @challenge, @payload, @expires)",
            cancellationToken,
            LocalSignInDb.Text("hash", codeHash),
            LocalSignInDb.Uuid("principal", principalId),
            LocalSignInDb.Text("challenge", challenge),
            LocalSignInDb.Text("payload", payload),
            LocalSignInDb.Instant("expires", expiresAt)).ConfigureAwait(false) is true;

    /// <inheritdoc />
    public async ValueTask<NativeHandoffRecord?> ConsumeAsync(string codeHash, CancellationToken cancellationToken) =>
        (await _db.RowsAsync(
            "SELECT * FROM nix_consume_native_handoff(@hash)",
            static reader => new NativeHandoffRecord(reader.GetString(0), reader.GetString(1), reader.GetFieldValue<DateTimeOffset>(2)),
            cancellationToken,
            LocalSignInDb.Text("hash", codeHash)).ConfigureAwait(false)).FirstOrDefault();
}
