namespace Nix.Workers.Transfer;

/// <summary>
/// Private spool files for sources, plans and staged objects, the way the Go <c>worktemp</c>
/// package kept them: one owner-only directory, owned name prefixes, and a sweep that removes
/// only old regular files with those prefixes, so a shared temp directory is never cleaned by
/// accident.
/// </summary>
public static class WorkSpool
{
    private const string DirectoryName = "nix-workers";
    private static readonly string[] Prefixes =
    [
        "nix-document-import-",
        "nix-export-",
        "nix-file-inspection-",
        "nix-import-stage-",
        "nix-template-import-",
    ];

    /// <summary>Creates an empty spool file under <paramref name="root"/> (the temp directory when null) and returns its path.</summary>
    public static string Create(string? root, string prefix)
    {
        if (!Prefixes.Contains(prefix, StringComparer.Ordinal))
        {
            throw new ArgumentException("worker spool prefix is not owned", nameof(prefix));
        }
        var directory = EnsureDirectory(root);
        var path = Path.Combine(directory, prefix + Guid.NewGuid().ToString("N"));
        using (new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
        }
        return path;
    }

    /// <summary>Removes owned regular spool files whose last write is older than <paramref name="maximumAge"/>.</summary>
    public static void Sweep(string? root, DateTimeOffset now, TimeSpan maximumAge)
    {
        if (maximumAge <= TimeSpan.Zero)
        {
            throw new ArgumentException("worker spool sweep age must be positive", nameof(maximumAge));
        }
        var cutoff = now - maximumAge;
        foreach (var path in Directory.EnumerateFiles(EnsureDirectory(root)))
        {
            var name = Path.GetFileName(path);
            if (!Prefixes.Any(prefix => name.StartsWith(prefix, StringComparison.Ordinal)))
            {
                continue;
            }
            var info = new FileInfo(path);
            if (info.LinkTarget is not null || info.LastWriteTimeUtc >= cutoff.UtcDateTime)
            {
                continue;
            }
            info.Delete();
        }
    }

    private static string EnsureDirectory(string? root)
    {
        var directory = Path.Combine(root ?? Path.GetTempPath(), DirectoryName);
        Directory.CreateDirectory(directory);
        var info = new DirectoryInfo(directory);
        if (info.LinkTarget is not null)
        {
            throw new IOException("worker spool path is not a directory");
        }
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        return directory;
    }
}
