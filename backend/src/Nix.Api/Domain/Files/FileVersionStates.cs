namespace Nix.Domain.Files;

/// <summary>The lifecycle states of a file version, as stored in <c>file_version.state</c>.</summary>
public static class FileVersionStates
{
    public const string Draft = "draft";
    public const string InReview = "in_review";
    public const string Approved = "approved";
    public const string Revoked = "revoked";

    /// <summary>Whether the text names a state.</summary>
    public static bool IsValid(string? state) => state is Draft or InReview or Approved or Revoked;
}
