namespace Nix.Workers.Queue;

/// <summary>
/// The job families, one per hosted worker loop, and the kinds each one owns. The grouping is
/// the one the Go roles had: the import role also ran template, file and object-cleanup jobs.
/// </summary>
public static class JobFamilies
{
    public const string Notify = "notify";
    public const string Calendar = "calendar";
    public const string Export = "export";
    public const string Import = "import";

    /// <summary>Every family in the order the hosts start.</summary>
    public static IReadOnlyList<string> All { get; } = [Notify, Calendar, Export, Import];

    /// <summary>The job kinds a family's host leases, exact matches for <c>nix_lease_worker_jobs</c>.</summary>
    public static IReadOnlyList<string> KindsOf(string family) => family switch
    {
        Notify => ["notify.push"],
        Calendar => ["calendar.sync"],
        Export => ["export.nix", "export.markdown", "export.docx", "export.pdf"],
        Import =>
        [
            "import.preview.nix", "import.preview.markdown", "import.preview.txt", "import.preview.docx", "import.preview.pdf",
            "import.commit", "template.preview", "template.commit", "template.files.copy", "file.publish", "object.cleanup",
        ],
        _ => [],
    };

    /// <summary>The family that owns <paramref name="kind"/>, or <see langword="null"/> for a kind no host runs (site jobs).</summary>
    public static string? Of(string kind)
    {
        ArgumentNullException.ThrowIfNull(kind);
        foreach (var family in All)
        {
            if (KindsOf(family).Contains(kind, StringComparer.Ordinal))
            {
                return family;
            }
        }
        return null;
    }
}
