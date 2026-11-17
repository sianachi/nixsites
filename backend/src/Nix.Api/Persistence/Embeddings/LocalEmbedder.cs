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

    /// <summary>How long the model stays loaded after its last use.</summary>
    public static readonly TimeSpan DefaultIdleRelease = TimeSpan.FromMinutes(10);

    private readonly string _directory;
    private readonly ILogger _log;
    private readonly TimeSpan _idleRelease;
    private readonly Lock _gate = new();
    private readonly Timer _idleTimer;
    private (InferenceSession Session, BertTokenizer Tokenizer)? _loaded;
    private bool _failed;
    private int _inUse;
    private long _lastUsed;
    private bool _disposed;

    /// <summary>
    /// Reads <c>model.onnx</c> and <c>vocab.txt</c> from <paramref name="directory"/> on first use, and
    /// lets them go again after <paramref name="idleRelease"/> without one: the model is about 100 MB
    /// that an install nobody is searching or editing in has no reason to hold.
    /// </summary>
    public LocalEmbedder(string directory, ILogger<LocalEmbedder>? logger = null, TimeSpan? idleRelease = null)
    {
        _directory = directory;
        _log = logger ?? NullLogger<LocalEmbedder>.Instance;
        _idleRelease = idleRelease ?? DefaultIdleRelease;
        _idleTimer = new Timer(_ => ReleaseIfIdle(), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
    }

    /// <summary>The default location: <c>models/bge-small-en-v1.5</c> beside the application.</summary>
    public static string DefaultDirectory => Path.Combine(AppContext.BaseDirectory, "models", "bge-small-en-v1.5");

    /// <summary>Whether the model's files are present. Does not load them.</summary>
    public bool Installed =>
        File.Exists(Path.Combine(_directory, "model.onnx")) && File.Exists(Path.Combine(_directory, "vocab.txt"));

    /// <summary>Whether the model is in memory right now.</summary>
    public bool Loaded
    {
        get
        {
            lock (_gate)
            {
                return _loaded is not null;
            }
        }
    }

    /// <summary>Whether the model loads (loading it if need be); false means retrieval is full-text only.</summary>
    public bool Available
    {
        get
        {
            if (Acquire() is null)
            {
                return false;
            }
            Release();
            return true;
        }
    }

    /// <summary>Embeds a search query, or returns null when the model is unavailable.</summary>
    public float[]? EmbedQuery(string query) => Embed([QueryInstruction + query])?[0];

    /// <summary>Embeds passages in one batch, or returns null when the model is unavailable.</summary>
    public float[][]? Embed(IReadOnlyList<string> texts)
    {
        ArgumentNullException.ThrowIfNull(texts);
        if (texts.Count == 0 || Acquire() is not { } model)
        {
            return null;
        }
        try
        {
            return Run(model.Session, model.Tokenizer, texts);
        }
        finally
        {
            Release();
        }
    }

    /// <summary>The loaded model, counted as in use until <see cref="Release"/>; null when it cannot load.</summary>
    private (InferenceSession Session, BertTokenizer Tokenizer)? Acquire()
    {
        lock (_gate)
        {
            if (_disposed || _failed)
            {
                return null;
            }
            // A load that fails is not tried again: the reason is in the log once, not once per request.
            _loaded ??= Load(_directory, _log);
            if (_loaded is null)
            {
                _failed = true;
                return null;
            }
            _inUse++;
            return _loaded;
        }
    }

    private void Release()
    {
        lock (_gate)
        {
            _inUse--;
            _lastUsed = Environment.TickCount64;
            if (!_disposed)
            {
                _idleTimer.Change(_idleRelease, Timeout.InfiniteTimeSpan);
            }
        }
    }

    private void ReleaseIfIdle()
    {
        lock (_gate)
        {
            if (_disposed || _loaded is not { } model || _inUse > 0)
            {
                return;
            }
            var idle = TimeSpan.FromMilliseconds(Environment.TickCount64 - _lastUsed);
            if (idle < _idleRelease)
            {
                _idleTimer.Change(_idleRelease - idle, Timeout.InfiniteTimeSpan);
                return;
            }
            model.Session.Dispose();
            _loaded = null;
        }
        // An idle process allocates nothing, so nothing would collect the tokenizer and the buffers
        // the model left behind; this hands their pages back to the system while nobody is waiting.
        GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
        TrimNativeHeap();
    }

    /// <summary>Asks glibc to return the model's freed native memory; it keeps freed arenas otherwise.</summary>
    private static void TrimNativeHeap()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        try
        {
            _ = malloc_trim(0);
        }
        catch (EntryPointNotFoundException)
        {
            // Not glibc (musl has no malloc_trim): nothing to return.
        }
    }

    [System.Runtime.InteropServices.DllImport("libc")]
    [System.Runtime.InteropServices.DefaultDllImportSearchPaths(System.Runtime.InteropServices.DllImportSearchPath.System32)]
    private static extern int malloc_trim(nuint pad);

    private static float[][] Run(InferenceSession session, BertTokenizer tokenizer, IReadOnlyList<string> texts)
    {
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
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            _loaded?.Session.Dispose();
            _loaded = null;
        }
        _idleTimer.Dispose();
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
