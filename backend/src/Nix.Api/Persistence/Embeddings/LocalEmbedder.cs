using System.Globalization;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;
using Microsoft.ML.Tokenizers;

namespace Nix.Persistence.Embeddings;

/// <summary>
/// Turns text into 384-dimension vectors with bge-small-en-v1.5 (int8-quantized), run in this process on the CPU: about 100 MB loaded, a few tens
/// of milliseconds per passage.
/// </summary>
/// <remarks>
/// <para>
/// Local rather than a provider API: chunks belong to a workspace, not to one member's key, and a
/// small model costs nothing per edit and behaves the same on every install. One intra-op thread,
/// so the embedder can never take more than a core from the API.
/// </para>
/// <para>
/// The model is optional. A checkout or image without it, or one where it fails to load, reports
/// <see cref="Available"/> false once in the log, and retrieval falls back to full-text ranking.
/// </para>
/// </remarks>
public sealed class LocalEmbedder : IDisposable
{
    /// <summary>The vector length this model produces, and the <c>item_chunk.embedding</c> column's.</summary>
    public const int Dimensions = 384;

    /// <summary>The query prefix bge-v1.5 was trained with for retrieval; passages take none.</summary>
    private const string QueryInstruction = "Represent this sentence for searching relevant passages: ";

    private const int MaxTokens = 510;

    private readonly Lazy<(InferenceSession Session, BertTokenizer Tokenizer)?> _model;

    /// <summary>Loads lazily from <paramref name="directory"/>, the folder holding <c>model.onnx</c> and <c>vocab.txt</c>.</summary>
    public LocalEmbedder(string directory, ILogger<LocalEmbedder>? logger = null)
    {
        var log = logger ?? NullLogger<LocalEmbedder>.Instance;
        _model = new(() => Load(directory, log), LazyThreadSafetyMode.ExecutionAndPublication);
    }

    /// <summary>The default location: <c>models/bge-small-en-v1.5</c> beside the application.</summary>
    public static string DefaultDirectory => Path.Combine(AppContext.BaseDirectory, "models", "bge-small-en-v1.5");

    /// <summary>Whether the model loaded; false means retrieval is full-text only.</summary>
    public bool Available => _model.Value is not null;

    /// <summary>Embeds a search query, or returns null when the model is unavailable.</summary>
    public float[]? EmbedQuery(string query) => Embed([QueryInstruction + query])?[0];

    /// <summary>Embeds passages in one batch, or returns null when the model is unavailable.</summary>
    public float[][]? Embed(IReadOnlyList<string> texts)
    {
        ArgumentNullException.ThrowIfNull(texts);
        if (_model.Value is not { } model || texts.Count == 0)
        {
            return null;
        }
        var (session, tokenizer) = model;

        var encoded = texts.Select(text => tokenizer.EncodeToIds(text, MaxTokens, true, out _, out _)).ToArray();
        var length = encoded.Max(ids => ids.Count);
        var ids = new DenseTensor<long>([texts.Count, length]);
        var mask = new DenseTensor<long>([texts.Count, length]);
        var types = new DenseTensor<long>([texts.Count, length]);
        for (var row = 0; row < encoded.Length; row++)
        {
            for (var column = 0; column < encoded[row].Count; column++)
            {
                ids[row, column] = encoded[row][column];
                mask[row, column] = 1;
            }
        }

        using var outputs = session.Run(
        [
            NamedOnnxValue.CreateFromTensor("input_ids", ids),
            NamedOnnxValue.CreateFromTensor("attention_mask", mask),
            NamedOnnxValue.CreateFromTensor("token_type_ids", types),
        ]);
        var hidden = outputs[0].AsTensor<float>();

        // bge pools on the [CLS] token, then normalises, so cosine distance is a dot product.
        var vectors = new float[texts.Count][];
        for (var row = 0; row < texts.Count; row++)
        {
            var vector = new float[Dimensions];
            var norm = 0.0;
            for (var index = 0; index < Dimensions; index++)
            {
                vector[index] = hidden[row, 0, index];
                norm += vector[index] * vector[index];
            }
            var scale = (float)(1 / Math.Sqrt(Math.Max(norm, 1e-12)));
            for (var index = 0; index < Dimensions; index++)
            {
                vector[index] *= scale;
            }
            vectors[row] = vector;
        }
        return vectors;
    }

    /// <summary>The pgvector text form, <c>[0.1,0.2,...]</c>, bound as text and cast in SQL.</summary>
    public static string ToLiteral(float[] vector)
    {
        ArgumentNullException.ThrowIfNull(vector);
        var builder = new StringBuilder(vector.Length * 12).Append('[');
        for (var index = 0; index < vector.Length; index++)
        {
            if (index > 0)
            {
                builder.Append(',');
            }
            builder.Append(vector[index].ToString("R", CultureInfo.InvariantCulture));
        }
        return builder.Append(']').ToString();
    }

    /// <inheritdoc />
    public void Dispose()
    {
        if (_model.IsValueCreated && _model.Value is { } model)
        {
            model.Session.Dispose();
        }
    }

    private static (InferenceSession, BertTokenizer)? Load(string directory, ILogger log)
    {
        var modelPath = Path.Combine(directory, "model.onnx");
        var vocabPath = Path.Combine(directory, "vocab.txt");
        if (!File.Exists(modelPath) || !File.Exists(vocabPath))
        {
            LocalEmbedderLog.Missing(log, directory);
            return null;
        }
        try
        {
            using var options = new Microsoft.ML.OnnxRuntime.SessionOptions
            {
                IntraOpNumThreads = 1,
                InterOpNumThreads = 1,
                // Return activation memory after each run instead of holding the peak for the process's life.
                EnableCpuMemArena = false,
            };
            return (new InferenceSession(modelPath, options), BertTokenizer.Create(vocabPath));
        }
#pragma warning disable CA1031 // Justification: a model that cannot load downgrades retrieval to full text; it must not stop Core.
        catch (Exception exception)
        {
            LocalEmbedderLog.Failed(log, exception, directory);
            return null;
        }
#pragma warning restore CA1031
    }
}

internal static partial class LocalEmbedderLog
{
    [LoggerMessage(Level = LogLevel.Warning, Message = "No embedding model in {Directory}; pet retrieval is full-text only. Run scripts/fetch-embedding-model.sh.")]
    internal static partial void Missing(ILogger logger, string directory);

    [LoggerMessage(Level = LogLevel.Error, Message = "The embedding model in {Directory} failed to load; pet retrieval is full-text only.")]
    internal static partial void Failed(ILogger logger, Exception exception, string directory);
}
