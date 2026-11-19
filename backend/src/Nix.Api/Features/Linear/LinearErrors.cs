using Nix.Domain.Primitives;

namespace Nix.Features.Linear;

internal static class LinearErrors
{
    internal static NixError Missing() => new("linear.not_found", "The Linear connection or request is unavailable.");
    internal static NixError Browser() => new("linear.browser_required", "Use the signed-in Nix browser to manage the Linear connection or hand work to a pet or approve a request.");
    internal static NixError WorkspaceOwner() => new("linear.forbidden", "Managing a Linear connection needs permission to manage the workspace.");
    internal static NixError Unavailable() => new("linear.unavailable", "The Linear connection could not be reached.");
    internal static NixError Ended() => new("linear.conflict", "This request expired, was already decided, or its connection changed.");
    internal static NixError InvalidPet() => new("linear.invalid_pet", "Choose an enabled pet with a single-line name.");
    internal static NixError CommentsRequired() => new("linear.comments_required", "Turn on comments for this task so the pet can leave a next step.");
    internal static NixError InvalidIssue() => new("linear.invalid_issue", "Use a Linear issue ID such as APP-42.");
}
