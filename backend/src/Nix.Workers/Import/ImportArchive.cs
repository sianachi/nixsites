using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Nix.Workers.Archive;
using Nix.Workers.Files;

namespace Nix.Workers.Import;

/// <summary>
/// The bounded ZIP reader every archive import goes through (DOCX and .nix): it refuses unsafe,
/// encrypted or duplicate member names, compression ratios above 100:1, and expansions past the
/// configured limits before a single member is read.
/// </summary>
internal static partial class ImportArchive
{
    public static ZipArchive Open(string path, ImportPlanLimits limits, bool allowNixFileVersions)
    {
        ZipArchive archive;
        try
        {
            archive = ZipFile.OpenRead(path);
        }
        catch (InvalidDataException exception)
        {
            throw new ImportPlanException("zip: not a valid zip file", exception);
        }
        try
        {
            Validate(archive, limits, allowNixFileVersions);
            return archive;
        }
        catch
        {
            archive.Dispose();
            throw;
        }
    }

    private static void Validate(ZipArchive archive, ImportPlanLimits limits, bool allowNixFileVersions)
    {
        var maxEntries = limits.MaxItems + 100;
        if (allowNixFileVersions)
        {
            maxEntries = limits.MaxItems <= NixArchive.MaxTemplateArchiveItems ? NixArchive.MaxTemplateArchiveEntries : NixArchive.MaxArchiveEntries;
        }
        if (archive.Entries.Count > maxEntries)
        {
            throw new ImportPlanException("archive contains too many entries");
        }
        ulong expanded = 0;
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in archive.Entries)
        {
            var name = entry.FullName;
            var clean = CleanPath(name);
            if (clean == "." || clean != name || clean.StartsWith("../", StringComparison.Ordinal) || name.StartsWith('/') || name.Contains('\\', StringComparison.Ordinal) || entry.IsEncrypted)
            {
                throw new ImportPlanException("archive contains an unsafe or encrypted entry");
            }
            if (!names.Add(name))
            {
                throw new ImportPlanException("archive contains duplicate entries");
            }
            var size = (ulong)entry.Length;
            if (size > Math.Max(1UL, (ulong)entry.CompressedLength) * 100)
            {
                throw new ImportPlanException("archive entry exceeds the allowed compression ratio");
            }
            expanded += size;
            var maxEntryBytes = (ulong)limits.MaxEntryBytes;
            if (allowNixFileVersions && IsNixFileVersionPath(name))
            {
                maxEntryBytes = Math.Min((ulong)limits.MaxSourceBytes, 100UL << 20);
            }
            if (expanded > (ulong)limits.MaxSourceBytes || size > maxEntryBytes)
            {
                throw new ImportPlanException("archive expands beyond the configured limits");
            }
        }
    }

    public static bool IsNixFileVersionPath(string name)
    {
        var match = NixFileEntryPattern().Match(name);
        return match.Success && int.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture) <= 100;
    }

    public static bool IsNixFileEntry(string name) => NixFileEntryPattern().IsMatch(name);

    public static string NixFileVersionEntryName(string itemId, int version) =>
        string.Create(System.Globalization.CultureInfo.InvariantCulture, $"files/{itemId}/{version}.bin");

    public static ZipArchiveEntry? Find(ZipArchive archive, string name) =>
        archive.Entries.FirstOrDefault(entry => entry.FullName == name);

    public static byte[] ReadEntry(ZipArchive archive, string name, long maxBytes)
    {
        var entry = Find(archive, name) ?? throw new ImportPlanException("required archive entry is missing");
        return ReadEntry(entry, maxBytes);
    }

    public static byte[] ReadEntry(ZipArchiveEntry entry, long maxBytes)
    {
        if (entry.Length > maxBytes)
        {
            throw new ImportPlanException("archive entry exceeds the configured byte limit");
        }
        using var stream = OpenVerified(entry);
        return ImportPlanner.ReadBounded(stream, maxBytes);
    }

    /// <summary>The member's bytes, failing on a length or CRC-32 that disagrees with the directory, as Go's zip reader did.</summary>
    public static Stream OpenVerified(ZipArchiveEntry entry) => new VerifiedEntryStream(entry.Open(), entry.Length, entry.Crc32);

    /// <summary>Hashes a member and inspects its leading bytes.</summary>
    public static (FileMetadata Metadata, string Sha256, long Length) Inspect(ZipArchiveEntry entry, CancellationToken cancellationToken)
    {
        using var stream = OpenVerified(entry);
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var header = new byte[FileInspector.HeaderLimit]; // byte[]: the inspector's fixed header window
        var headerLength = stream.ReadAtLeast(header, header.Length, throwOnEndOfStream: false);
        digest.AppendData(header, 0, headerLength);
        var buffer = new byte[64 * 1024]; // byte[]: streaming copy buffer
        long total = headerLength;
        int read;
        while ((read = stream.Read(buffer)) > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            total += read;
            digest.AppendData(buffer, 0, read);
        }
        var metadata = FileInspector.InspectHeader(header.AsSpan(0, headerLength), total);
        return (metadata, Convert.ToHexStringLower(digest.GetHashAndReset()), total);
    }

    /// <summary>Go's path.Clean for slash-separated names.</summary>
    public static string CleanPath(string path)
    {
        if (path.Length == 0)
        {
            return ".";
        }
        var rooted = path[0] == '/';
        var parts = new List<string>();
        foreach (var part in path.Split('/'))
        {
            if (part.Length == 0 || part == ".")
            {
                continue;
            }
            if (part == "..")
            {
                if (parts.Count > 0 && parts[^1] != "..")
                {
                    parts.RemoveAt(parts.Count - 1);
                }
                else if (!rooted)
                {
                    parts.Add(part);
                }
                continue;
            }
            parts.Add(part);
        }
        var joined = string.Join('/', parts);
        if (rooted)
        {
            return "/" + joined;
        }
        return joined.Length == 0 ? "." : joined;
    }

    [GeneratedRegex(@"^files/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/([1-9][0-9]{0,2})\.bin\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex NixFileEntryPattern();
}

/// <summary>Counts and checksums a member as it streams, failing at the end on a length or CRC that disagrees with the directory.</summary>
internal sealed class VerifiedEntryStream(Stream inner, long expectedLength, uint expectedCrc) : Stream
{
    private long position;
    private uint crc;

    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length => expectedLength;

    public override long Position
    {
        get => position;
        set => throw new NotSupportedException();
    }

    public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

    public override int Read(Span<byte> buffer)
    {
        var read = inner.Read(buffer);
        Account(buffer[..read], buffer.IsEmpty);
        return read;
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        var read = await inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
        Account(buffer.Span[..read], buffer.IsEmpty);
        return read;
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
        ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    private void Account(ReadOnlySpan<byte> read, bool emptyRequest)
    {
        position += read.Length;
        if (position > expectedLength)
        {
            throw new InvalidDataException("zip: archive member is longer than declared");
        }
        crc = Crc32.Append(crc, read);
        // A zero-length read into a non-empty buffer is the end of the member.
        if (read.IsEmpty && !emptyRequest)
        {
            if (position != expectedLength)
            {
                throw new InvalidDataException("zip: archive member is shorter than declared");
            }
            if (crc != expectedCrc)
            {
                throw new InvalidDataException("zip: checksum error");
            }
        }
    }

    public override void Flush()
    {
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            inner.Dispose();
        }
        base.Dispose(disposing);
    }
}

/// <summary>A planned DOCX asset streamed out of the source for commit. Disposing closes the archive.</summary>
public sealed class AssetReader : IDisposable
{
    private readonly ZipArchive archive;

    private AssetReader(ZipArchive archive, Stream body, long size)
    {
        this.archive = archive;
        Body = body;
        Size = size;
    }

    public Stream Body { get; }

    public long Size { get; }

    public static AssetReader Open(ImportSource source, string assetPath, ImportPlanLimits limits)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(assetPath);
        ArgumentNullException.ThrowIfNull(limits);
        var archive = ImportArchive.Open(source.Path, limits, allowNixFileVersions: false);
        try
        {
            var entry = ImportArchive.Find(archive, assetPath);
            if (entry is null || entry.Length > limits.MaxEntryBytes)
            {
                throw new ImportPlanException("planned import asset is missing or oversized");
            }
            return new AssetReader(archive, ImportArchive.OpenVerified(entry), entry.Length);
        }
        catch
        {
            archive.Dispose();
            throw;
        }
    }

    public void Dispose()
    {
        Body.Dispose();
        archive.Dispose();
    }
}

/// <summary>Keeps a validated .nix archive open while an importer streams its declared file-version members.</summary>
public sealed class NixArchiveFiles : IDisposable
{
    private readonly ZipArchive archive;
    private readonly Dictionary<string, ZipArchiveEntry> entries;

    private NixArchiveFiles(ZipArchive archive)
    {
        this.archive = archive;
        entries = archive.Entries.Where(entry => ImportArchive.IsNixFileEntry(entry.FullName)).ToDictionary(entry => entry.FullName, StringComparer.Ordinal);
    }

    public static NixArchiveFiles Open(string path, ImportPlanLimits limits)
    {
        ArgumentNullException.ThrowIfNull(path);
        ArgumentNullException.ThrowIfNull(limits);
        return new NixArchiveFiles(ImportArchive.Open(path, limits, allowNixFileVersions: true));
    }

    /// <summary>The member's bytes; the caller disposes the stream. Fails when it is undeclared or its length differs.</summary>
    public Stream OpenVersion(string itemId, int version, long expectedLength)
    {
        if (!NixArchive.SafeId(itemId) || version < 1 || version > NixArchive.MaxFileVersionsPerItem || expectedLength < 0 || expectedLength > NixArchive.MaxFileVersionBytes)
        {
            throw new ImportPlanException("Nix archive file version request is invalid");
        }
        if (!entries.TryGetValue(ImportArchive.NixFileVersionEntryName(itemId, version), out var entry) || entry.Length != expectedLength)
        {
            throw new ImportPlanException("Nix archive file version is missing or has a different declared length");
        }
        return ImportArchive.OpenVerified(entry);
    }

    public void Dispose() => archive.Dispose();
}
