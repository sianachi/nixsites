namespace Nix.Tests.Features.Files;

/// <summary>
/// Browser uploads are only safe to leave without a signed type if every browser read forces its
/// own response type and disposition. These pin that the browser-facing file reads never mint a
/// plain <c>Get</c> capability.
/// </summary>
public sealed class BrowserReadCapabilityTests
{
    [Fact]
    public void Browser_facing_file_reads_only_issue_GetForBrowser_capabilities()
    {
        var source = File.ReadAllText(Path.Combine(RepositoryRoot(), "backend/src/Nix.Api/Features/Files/FileEndpoints.cs"));
        var start = source.IndexOf("Task<IResult> AuthorizePublicDownload(", StringComparison.Ordinal);
        var end = source.IndexOf("Task<IResult> AuthorizeThumbnailUpload(", StringComparison.Ordinal);
        Assert.InRange(start, 0, end);

        var browserReads = source[start..end];

        Assert.Contains("signer.GetForBrowser(", browserReads, StringComparison.Ordinal);
        Assert.DoesNotContain("signer.Get(", browserReads, StringComparison.Ordinal);
    }

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Nix.slnx")))
            {
                return directory.FullName;
            }
        }
        throw new InvalidOperationException("Repository root (Nix.slnx) not found.");
    }
}
