using System.Text.Json;

namespace Nix.Workers.Archive;

/// <summary>Byte, line and record ceilings for a bundle stream or an export.</summary>
public sealed record StreamLimits(long MaxBytes, int MaxLine, int MaxRecords);

public sealed class StreamLimitException : Exception
{
    public StreamLimitException()
        : base("stream limit exceeded")
    {
    }

    public StreamLimitException(string message)
        : base(message)
    {
    }

    public StreamLimitException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>
/// Validates and yields one Collaboration bundle at a time from the NDJSON export stream. The
/// manifest is retained because it is the bounded index of the stream; item bodies are not.
/// </summary>
public sealed class BundleReader : IDisposable
{
    private readonly Stream _source;
    private readonly StreamLimits _limits;
    private readonly LineReader _lines;
    private long _seenBytes;
    private int _index;
    private bool _ended;

    private BundleReader(Stream source, StreamLimits limits, LineReader lines, Manifest manifest, long seenBytes)
    {
        this._source = source;
        this._limits = limits;
        this._lines = lines;
        Manifest = manifest;
        this._seenBytes = seenBytes;
    }

    public Manifest Manifest { get; }

    public static async Task<BundleReader> OpenAsync(Stream source, StreamLimits limits, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(limits);
        if (limits.MaxBytes <= 0 || limits.MaxLine <= 0 || limits.MaxRecords <= 0)
        {
            throw new ArgumentException("bundle stream limits must be positive", nameof(limits));
        }
        var lines = new LineReader(source, limits.MaxLine);
        var first = await lines.ReadLineAsync(cancellationToken).ConfigureAwait(false)
            ?? throw new ArchiveFormatException("bundle stream is empty");
        Manifest? manifest;
        try
        {
            manifest = JsonSerializer.Deserialize(first, ArchiveJsonContext.Default.Manifest);
        }
        catch (JsonException exception)
        {
            throw new ArchiveFormatException("bundle stream manifest: " + exception.Message, exception);
        }
        if (manifest is null)
        {
            throw new ArchiveFormatException("bundle stream manifest: empty");
        }
        NixArchive.ValidateManifest(manifest, limits.MaxRecords);
        manifest.Raw = first;
        return new BundleReader(source, limits, lines, manifest, first.Length + 1);
    }

    /// <summary>The next bundle, or null at the sentinel.</summary>
    public async Task<Bundle?> NextAsync(CancellationToken cancellationToken)
    {
        if (_ended)
        {
            return null;
        }
        var line = await _lines.ReadLineAsync(cancellationToken).ConfigureAwait(false)
            ?? throw new ArchiveFormatException("bundle stream is truncated");
        _seenBytes += line.Length + 1;
        if (_seenBytes > _limits.MaxBytes)
        {
            throw new StreamLimitException();
        }
        StreamEnd? end = null;
        try
        {
            end = JsonSerializer.Deserialize(line, ArchiveJsonContext.Default.StreamEnd);
        }
        catch (JsonException)
        {
            // Not the sentinel.
        }
        if (end is { End: true })
        {
            if (end.Items != _index || _index != Manifest.Items.Count)
            {
                throw new ArchiveFormatException("bundle stream sentinel count does not match manifest");
            }
            if (await _lines.ReadLineAsync(cancellationToken).ConfigureAwait(false) is not null)
            {
                throw new ArchiveFormatException("bundle stream has data after its sentinel");
            }
            _ended = true;
            return null;
        }
        if (_index >= _limits.MaxRecords || _index >= Manifest.Items.Count)
        {
            throw new StreamLimitException();
        }
        Bundle? bundle;
        try
        {
            bundle = JsonSerializer.Deserialize(line, ArchiveJsonContext.Default.Bundle);
        }
        catch (JsonException)
        {
            bundle = null;
        }
        if (bundle is null || string.IsNullOrEmpty(bundle.Id) || string.IsNullOrEmpty(bundle.Title))
        {
            throw new ArchiveFormatException("bundle stream contains an invalid item");
        }
        if (bundle.Id != Manifest.Items[_index].Id)
        {
            throw new ArchiveFormatException("bundle stream order does not match manifest");
        }
        bundle.Raw = line;
        _index++;
        return bundle;
    }

    public void Dispose()
    {
        _lines.Dispose();
        _source.Dispose();
    }

    /// <summary>Reads newline-delimited lines with a ceiling, like a bufio.Scanner with a bounded buffer.</summary>
    private sealed class LineReader(Stream stream, int maxLine) : IDisposable
    {
        private readonly byte[] _buffer = new byte[Math.Min(maxLine, 64 * 1024)]; // byte[]: the scanner's read buffer
        private readonly MemoryStream _pending = new();
        private int _start;
        private int _end;
        private bool _eof;

        public async Task<byte[]?> ReadLineAsync(CancellationToken cancellationToken)
        {
            while (true)
            {
                var newline = Array.IndexOf(_buffer, (byte)'\n', _start, _end - _start);
                if (newline >= 0)
                {
                    await _pending.WriteAsync(_buffer.AsMemory(_start, newline - _start), cancellationToken).ConfigureAwait(false);
                    _start = newline + 1;
                    return Take();
                }
                await _pending.WriteAsync(_buffer.AsMemory(_start, _end - _start), cancellationToken).ConfigureAwait(false);
                _start = _end = 0;
                if (_pending.Length > maxLine)
                {
                    throw new StreamLimitException();
                }
                if (_eof)
                {
                    return _pending.Length == 0 ? null : Take();
                }
                var read = await stream.ReadAsync(_buffer, cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    _eof = true;
                }
                _end = read;
            }
        }

        public void Dispose() => _pending.Dispose();

        private byte[] Take()
        {
            var line = _pending.ToArray();
            _pending.SetLength(0);
            if (line.Length > 0 && line[^1] == '\r')
            {
                line = line[..^1];
            }
            return line;
        }
    }
}
