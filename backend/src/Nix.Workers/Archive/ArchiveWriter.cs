using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace Nix.Workers.Archive;

/// <summary>A zip output that refuses to grow past a byte ceiling.</summary>
public sealed class LimitedStream(Stream inner, long maximum) : Stream
{
    private long _remaining = maximum;

    public override bool CanRead => false;

    public override bool CanSeek => false;

    public override bool CanWrite => true;

    public override long Length => throw new NotSupportedException();

    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

    public override void Flush() => inner.Flush();

    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count)
    {
        if (count > _remaining)
        {
            _remaining = 0;
            throw new StreamLimitException();
        }
        _remaining -= count;
        inner.Write(buffer, offset, count);
    }

    public override void Write(ReadOnlySpan<byte> buffer)
    {
        if (buffer.Length > _remaining)
        {
            _remaining = 0;
            throw new StreamLimitException();
        }
        _remaining -= buffer.Length;
        inner.Write(buffer);
    }
}

/// <summary>Writes a <c>.nix</c> archive one bundle and one file version at a time.</summary>
public static class ArchiveWriter
{
    private static readonly DateTimeOffset FixedEntryTime = new(1980, 1, 1, 0, 0, 0, TimeSpan.Zero);

    /// <summary>One file version's bytes, supplied as a stream so nothing is buffered whole.</summary>
    public delegate Task<(FileVersionEntry Entry, Stream Content)?> NextFile(CancellationToken cancellationToken);

    public static async Task WriteAsync(
        Stream output,
        Manifest manifest,
        Func<CancellationToken, Task<Bundle?>> next,
        NextFile? nextFile,
        long maxBytes,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(output);
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(next);
        if (manifest.Items.Count == 0 || manifest.Items.Count > NixArchive.MaxArchiveItems || 1 + manifest.Items.Count + (manifest.Files?.Count ?? 0) > NixArchive.MaxArchiveEntries)
        {
            throw new ArchiveFormatException("archive exceeds the shared Nix archive entry or item ceiling");
        }
        NixArchive.ValidateManifest(manifest, manifest.Items.Count);
        ValidateRawManifest(manifest);
        if (maxBytes <= 0)
        {
            throw new ArgumentException("archive writer configuration is invalid", nameof(maxBytes));
        }
        Portability.ValidateManifest(manifest);
        if (manifest.FormatVersion == NixArchive.FileFormatVersion && nextFile is null)
        {
            throw new ArchiveFormatException("archive v2 file reader is required");
        }
        using var limited = new LimitedStream(output, maxBytes);
        using var archive = new ZipArchive(limited, ZipArchiveMode.Create, leaveOpen: true);
        await WriteEntryAsync(archive, "manifest.json", Encoded(manifest.Raw, () => JsonSerializer.SerializeToUtf8Bytes(manifest, ArchiveJsonContext.Default.Manifest)), cancellationToken).ConfigureAwait(false);
        foreach (var item in manifest.Items)
        {
            var bundle = await next(cancellationToken).ConfigureAwait(false)
                ?? throw new ArchiveFormatException("archive bundle count does not match manifest");
            if (!NixArchive.SafeId(bundle.Id))
            {
                throw new ArchiveFormatException("unsafe bundle identifier");
            }
            if (bundle.Id != item.Id)
            {
                throw new ArchiveFormatException("archive bundle order does not match manifest");
            }
            if (bundle.Type != item.Type)
            {
                throw new ArchiveFormatException("archive bundle type does not match manifest");
            }
            Portability.ValidateBundle(bundle, manifest);
            await WriteEntryAsync(archive, "items/" + bundle.Id + ".json", Encoded(bundle.Raw, () => JsonSerializer.SerializeToUtf8Bytes(bundle, ArchiveJsonContext.Default.Bundle)), cancellationToken).ConfigureAwait(false);
        }
        if (await next(cancellationToken).ConfigureAwait(false) is not null)
        {
            throw new ArchiveFormatException("archive bundle count does not match manifest");
        }
        if (manifest.FormatVersion == NixArchive.FileFormatVersion)
        {
            var reader = nextFile ?? throw new ArchiveFormatException("archive v2 file reader is required");
            foreach (var expected in manifest.Files!)
            {
                var file = await reader(cancellationToken).ConfigureAwait(false)
                    ?? throw new ArchiveFormatException("archive file-version count does not match manifest");
                await using (file.Content.ConfigureAwait(false))
                {
                    if (file.Entry != expected)
                    {
                        throw new ArchiveFormatException("archive file-version order does not match manifest");
                    }
                    await WriteFileEntryAsync(archive, expected, file.Content, cancellationToken).ConfigureAwait(false);
                }
            }
            if (await reader(cancellationToken).ConfigureAwait(false) is { } extra)
            {
                await extra.Content.DisposeAsync().ConfigureAwait(false);
                throw new ArchiveFormatException("archive file-version count does not match manifest");
            }
        }
        else if (nextFile is not null && await nextFile(cancellationToken).ConfigureAwait(false) is { } unexpected)
        {
            await unexpected.Content.DisposeAsync().ConfigureAwait(false);
            throw new ArchiveFormatException("archive v1 cannot write file-version entries");
        }
    }

    private static void ValidateRawManifest(Manifest manifest)
    {
        if (manifest.Raw is null || manifest.Raw.Length == 0)
        {
            return;
        }
        Manifest? source;
        try
        {
            source = JsonSerializer.Deserialize(manifest.Raw, ArchiveJsonContext.Default.Manifest);
        }
        catch (JsonException exception)
        {
            throw new ArchiveFormatException("archive source JSON is invalid: " + exception.Message, exception);
        }
        if (source is null)
        {
            throw new ArchiveFormatException("archive source JSON is invalid");
        }
        NixArchive.ValidateManifest(source, manifest.Items.Count);
        if (source.Format != manifest.Format || source.FormatVersion != manifest.FormatVersion || source.Root != manifest.Root
            || !source.Items.SequenceEqual(manifest.Items) || !SameFiles(source.Files, manifest.Files))
        {
            throw new ArchiveFormatException("archive manifest source does not match its validated descriptor");
        }
    }

    private static bool SameFiles(IList<FileVersionEntry>? left, IList<FileVersionEntry>? right) =>
        (left is null && right is null) || (left is not null && right is not null && left.SequenceEqual(right));

    private static async Task WriteFileEntryAsync(ZipArchive archive, FileVersionEntry metadata, Stream source, CancellationToken cancellationToken)
    {
        var entry = archive.CreateEntry($"files/{metadata.ItemId}/{metadata.Version.ToString(CultureInfo.InvariantCulture)}.bin", CompressionLevel.NoCompression);
        entry.LastWriteTime = FixedEntryTime;
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var target = await entry.OpenAsync(cancellationToken).ConfigureAwait(false);
        await using (target.ConfigureAwait(false))
        {
            var buffer = new byte[64 * 1024]; // byte[]: copy buffer between the capability stream and the zip entry
            long count = 0;
            while (true)
            {
                var read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    break;
                }
                count += read;
                if (count > metadata.ByteLength)
                {
                    throw new ArchiveFormatException($"file version {metadata.ItemId}/{metadata.Version} exceeds manifest length");
                }
                digest.AppendData(buffer, 0, read);
                await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
            }
            if (count != metadata.ByteLength)
            {
                throw new ArchiveFormatException($"file version {metadata.ItemId}/{metadata.Version} length does not match manifest");
            }
            if (!string.Equals(Convert.ToHexStringLower(digest.GetHashAndReset()), metadata.Sha256, StringComparison.Ordinal))
            {
                throw new ArchiveFormatException($"file version {metadata.ItemId}/{metadata.Version} digest does not match manifest");
            }
        }
    }

    public static async Task WriteEntryAsync(ZipArchive archive, string name, byte[] payload, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(archive);
        ArgumentNullException.ThrowIfNull(name);
        ArgumentNullException.ThrowIfNull(payload);
        if (name.Contains("..", StringComparison.Ordinal) || name.Contains('\\', StringComparison.Ordinal))
        {
            throw new ArchiveFormatException("unsafe archive path");
        }
        var entry = archive.CreateEntry(name, CompressionLevel.Optimal);
        entry.LastWriteTime = FixedEntryTime;
        var target = await entry.OpenAsync(cancellationToken).ConfigureAwait(false);
        await using (target.ConfigureAwait(false))
        {
            await target.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
        }
    }

    private static byte[] Encoded(byte[]? raw, Func<byte[]> encode)
    {
        if (raw is { Length: > 0 })
        {
            try
            {
                using var document = JsonDocument.Parse(raw);
            }
            catch (JsonException exception)
            {
                throw new ArchiveFormatException("archive source JSON is invalid", exception);
            }
            return raw;
        }
        return encode();
    }
}
