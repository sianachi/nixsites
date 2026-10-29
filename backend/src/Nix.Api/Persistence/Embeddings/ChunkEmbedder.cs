using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Embeddings;

/// <summary>
/// Fills in embeddings for note chunks the collaboration service wrote without one.
/// </summary>
/// <remarks>
/// Every tenant at once, so work is found and written only through the two security-definer
/// functions of the <c>ItemChunks</c> migration. Neither can read beyond a chunk's text or change
/// anything but its embedding, and the write is dropped when the text changed in the meantime.
/// Batches of four on one thread: a 200-page note embeds in well under a minute without
/// competing with requests.
/// </remarks>
public sealed class ChunkEmbedder(
    NpgsqlDataSource dataSource,
    LocalEmbedder embedder,
    TimeProvider clock,
    ILogger<ChunkEmbedder>? logger = null) : BackgroundService
{
    // Small, because attention memory grows with batch × tokens²; four 1,500-character chunks stay
    // well inside the API container's memory limit.
    // shortcut: nix_find_unembedded_chunks orders by tenant, so one tenant with a large backlog delays
    // every later tenant's embeddings (search falls back to full text meanwhile); order by age or
    // round-robin tenants in a new migration once an install hosts many tenants.
    private const int BatchSize = 4;
    private static readonly TimeSpan EmptyDelay = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan FailureDelay = TimeSpan.FromSeconds(30);
    private readonly ILogger<ChunkEmbedder> logger = logger ?? NullLogger<ChunkEmbedder>.Instance;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Off the startup path: loading the model takes a moment and must not delay readiness.
        await Task.Yield();
        if (!embedder.Available)
        {
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (await EmbedOnceAsync(stoppingToken).ConfigureAwait(false) == 0)
                {
                    await Task.Delay(EmptyDelay, clock, stoppingToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
#pragma warning disable CA1031 // Justification: embeddings are derived and retried; a transient failure must not end the loop.
            catch (Exception exception)
            {
                ChunkEmbedderLog.Failed(logger, exception);
                await Task.Delay(FailureDelay, clock, stoppingToken).ConfigureAwait(false);
            }
#pragma warning restore CA1031
        }
    }

    /// <summary>Embeds one batch and returns how many chunks it took; exposed for tests.</summary>
    public async Task<int> EmbedOnceAsync(CancellationToken cancellationToken)
    {
        var pending = new List<(Guid Tenant, Guid Item, int Ord, string Hash, string Text)>(BatchSize);
        var find = dataSource.CreateCommand("SELECT * FROM nix_find_unembedded_chunks(@limit)");
        await using (find.ConfigureAwait(false))
        {
            find.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = BatchSize });
            var reader = await find.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            await using (reader.ConfigureAwait(false))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    var heading = reader.GetString(4);
                    var body = reader.GetString(5);
                    pending.Add((reader.GetGuid(0), reader.GetGuid(1), reader.GetInt32(2), reader.GetString(3),
                        heading.Length == 0 ? body : heading + "\n" + body));
                }
            }
        }
        if (pending.Count == 0)
        {
            return 0;
        }

        var vectors = embedder.Embed([.. pending.Select(chunk => chunk.Text)]);
        if (vectors is null)
        {
            return 0;
        }

        var batch = dataSource.CreateBatch();
        await using (batch.ConfigureAwait(false))
        {
            for (var index = 0; index < pending.Count; index++)
            {
                var chunk = pending[index];
                var command = new NpgsqlBatchCommand("SELECT nix_set_chunk_embedding(@tenant, @item, @ord, @hash, @embedding::vector)");
                command.Parameters.Add(new NpgsqlParameter<Guid>("tenant", NpgsqlDbType.Uuid) { TypedValue = chunk.Tenant });
                command.Parameters.Add(new NpgsqlParameter<Guid>("item", NpgsqlDbType.Uuid) { TypedValue = chunk.Item });
                command.Parameters.Add(new NpgsqlParameter<int>("ord", NpgsqlDbType.Integer) { TypedValue = chunk.Ord });
                command.Parameters.Add(new NpgsqlParameter<string>("hash", NpgsqlDbType.Text) { TypedValue = chunk.Hash });
                command.Parameters.Add(new NpgsqlParameter<string>("embedding", NpgsqlDbType.Text) { TypedValue = LocalEmbedder.ToLiteral(vectors[index]) });
                batch.BatchCommands.Add(command);
            }
            await batch.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }
        return pending.Count;
    }
}

internal static partial class ChunkEmbedderLog
{
    [LoggerMessage(Level = LogLevel.Warning, Message = "Embedding note chunks failed; retrying shortly.")]
    internal static partial void Failed(ILogger logger, Exception exception);
}
