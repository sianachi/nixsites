using Nix.Domain.Primitives;

namespace Nix.Features.Automations;

/// <summary>The refusals the automation endpoints give, with their stable codes.</summary>
public static class AutomationErrors
{
    internal const string PetRoutineOwnerRequiredCode = "automation.pet_routine_owner_required";

    internal static NixError PetRoutineOwnerRequired { get; } = new(
        PetRoutineOwnerRequiredCode, "Open Nix in your signed-in browser to save this pet routine.");

    /// <summary>The rule document was malformed; the message lists every violation.</summary>
    public const string InvalidCode = "automation.invalid";

    /// <summary>The rule names an action this build recognises but does not run yet.</summary>
    public const string ActionUnavailableCode = "automation.action_unavailable";

    /// <summary>The owner already keeps the most rules one workspace allows.</summary>
    public const string LimitReachedCode = "automation.limit_reached";

    /// <summary>No rule (or workspace) by that id is visible to the caller.</summary>
    public const string NotFoundCode = "automation.not_found";

    /// <summary>The rule changed since the caller read it.</summary>
    public const string ConflictCode = "automation.conflict";

    /// <summary>A malformed rule document.</summary>
    public static NixError Invalid(string message) => new(InvalidCode, message);

    /// <summary>An unavailable action.</summary>
    public static NixError ActionUnavailable(string message) => new(ActionUnavailableCode, message);

    /// <summary>
    /// The rule, as stored, exceeds the table's size bound - the backstop behind the validator's
    /// own limits. Reported as <see cref="InvalidCode"/>.
    /// </summary>
    public static NixError TooLarge { get; } = new(
        InvalidCode,
        "actions: the automation is larger than one automation may be; shorten its text or values");

    /// <summary>The per-owner, per-workspace ceiling.</summary>
    public static NixError LimitReached { get; } = new(
        LimitReachedCode,
        "You already have the most automations one workspace allows. Delete one before adding another.");

    /// <summary>Not visible.</summary>
    public static NixError NotFound { get; } = new(NotFoundCode, "No automation by that id is visible.");

    /// <summary>A stale revision.</summary>
    public static NixError Conflict { get; } = new(
        ConflictCode,
        "This automation changed since you opened it. Reload it before saving.");
}
