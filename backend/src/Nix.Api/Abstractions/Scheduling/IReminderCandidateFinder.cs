using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Scheduling;

/// <summary>An item carrying a <c>reminder</c> property whose instant falls in a plan window.</summary>
/// <param name="PrincipalId">
/// The recipient: the active principal of the item's tenant named by <c>$reminder_set_by</c>, or
/// the item's creator.
/// </param>
public sealed record ExplicitReminderCandidate(
    TenantId TenantId,
    Guid ItemId,
    WorkspaceId WorkspaceId,
    PrincipalId PrincipalId,
    DateTimeOffset ReminderAt);

/// <summary>An active item whose <c>expiry</c>, set through the write path, falls before a plan window's end.</summary>
/// <param name="PrincipalId">The setter while active in the item's tenant, else the item's creator.</param>
public sealed record ExpiryCandidate(
    TenantId TenantId,
    Guid ItemId,
    WorkspaceId WorkspaceId,
    PrincipalId PrincipalId,
    DateTimeOffset ExpiryAt);

/// <summary>A plain (non-recurring), not-complete item whose due day falls in a plan window.</summary>
/// <param name="PrincipalId">
/// The recipient: the active principal of the item's tenant named by <c>$due_set_by</c>, or the
/// item's creator.
/// </param>
/// <param name="DueDayText">The stored due day exactly as the keyset orders it.</param>
/// <param name="DueDay">
/// The due day, or <see langword="null"/> when the stored text is not a date (an undeclared
/// <c>due_date</c> key can hold anything); such a row still advances the keyset.
/// </param>
public sealed record DueReminderCandidate(
    TenantId TenantId,
    Guid ItemId,
    WorkspaceId WorkspaceId,
    PrincipalId PrincipalId,
    string DueDayText,
    DateOnly? DueDay);

/// <summary>A live recurring item whose rule could produce an occurrence in a plan window.</summary>
/// <param name="AnchorDay">The rule's anchor (the item's due day), or <see langword="null"/> when it does not parse.</param>
/// <param name="Recurrence">The item's recurrence rule as stored JSON.</param>
public sealed record RecurringDueReminderCandidate(
    TenantId TenantId,
    Guid ItemId,
    WorkspaceId WorkspaceId,
    PrincipalId PrincipalId,
    DateOnly? AnchorDay,
    string Recurrence);

/// <summary>An item declaring a habit reminder time, with the scheduling properties needed to plan it.</summary>
/// <param name="Settings">
/// The item's <c>$habit_</c>-prefixed scheduling properties, as a JSON object
/// <see cref="Nix.Domain.Habits.HabitSettings.Read"/> reads directly - never the title, and never
/// any other property the item carries.
/// </param>
public sealed record HabitReminderCandidate(
    TenantId TenantId,
    Guid ItemId,
    WorkspaceId WorkspaceId,
    PrincipalId PrincipalId,
    string Settings);

/// <summary>A recipient, named by the whole key of <c>principal_preferences</c>.</summary>
public readonly record struct ReminderRecipient(TenantId TenantId, PrincipalId PrincipalId);

/// <summary>
/// One recipient's reminder preferences, defaulted exactly as a fresh <c>principal_preferences</c>
/// row would be (ADR-0051 section 3) when they have never saved one at all.
/// </summary>
public sealed record ReminderPreferences(
    TenantId TenantId,
    PrincipalId PrincipalId,
    string TimeZone,
    TimeOnly? QuietStart,
    TimeOnly? QuietEnd,
    TimeOnly DueReminderTime,
    bool DueReminders,
    bool HabitReminders,
    IReadOnlyList<Guid> MutedContainerIds)
{
    /// <summary>Gets the recipient these preferences belong to.</summary>
    public ReminderRecipient Recipient => new(TenantId, PrincipalId);
}

/// <summary>
/// Cross-tenant discovery for the three reminder sources, backed by the SECURITY DEFINER functions
/// in <c>ReminderSourceSecuritySql</c> - the only cross-tenant reader of <c>item</c> and
/// <c>principal_preferences</c> these sources need, exactly as <see cref="IScheduledTriggerLeaseStore"/>
/// is for <c>scheduled_trigger</c>. Called from <c>ITriggerSource.PlanAsync</c>, which runs with no
/// session established yet.
/// </summary>
public interface IReminderCandidateFinder
{
    /// <summary>
    /// Items with a <c>reminder</c> property firing in <c>[from, until)</c>, one keyset page at a
    /// time - <paramref name="afterInstant"/>/<paramref name="afterId"/> default to "the
    /// beginning"; a caller pages by passing back the last row's own instant and id.
    /// </summary>
    /// <remarks>
    /// Paged rather than a single bounded call: without a cursor, whichever 500 candidates a
    /// single page happens to hold would permanently starve every candidate that sorts after
    /// them the moment more than 500 exist globally at once.
    /// </remarks>
    public Task<IReadOnlyList<ExplicitReminderCandidate>> FindExplicitAsync(
        DateTimeOffset from,
        DateTimeOffset until,
        int limit,
        DateTimeOffset afterInstant,
        Guid afterId,
        CancellationToken cancellationToken);

    /// <summary>
    /// Active items with an <c>expiry</c> and an <c>$expiry_set_by</c> stamp whose instant is before
    /// <paramref name="until"/> - with no lower bound, so an overdue item that could not be trashed
    /// stays a candidate - in <c>(instant, id)</c> order, one keyset page at a time.
    /// </summary>
    public Task<IReadOnlyList<ExpiryCandidate>> FindExpiringAsync(
        DateTimeOffset until,
        int limit,
        DateTimeOffset afterInstant,
        Guid afterId,
        CancellationToken cancellationToken);

    /// <summary>
    /// Plain, not-complete items whose due day falls in <c>[from, until]</c>, in
    /// <c>(due day text, id)</c> order, one keyset page at a time. Pass an empty
    /// <paramref name="afterDayText"/> for the first page, then the last row's
    /// <see cref="DueReminderCandidate.DueDayText"/> and id.
    /// </summary>
    public Task<IReadOnlyList<DueReminderCandidate>> FindDueAsync(
        DateOnly from,
        DateOnly until,
        int limit,
        string afterDayText,
        Guid afterId,
        CancellationToken cancellationToken);

    /// <summary>
    /// Live recurring items whose anchor is not after <paramref name="until"/> and whose rule has
    /// not ended before <paramref name="from"/>, in id order, one keyset page at a time.
    /// </summary>
    public Task<IReadOnlyList<RecurringDueReminderCandidate>> FindRecurringDueAsync(
        DateOnly from,
        DateOnly until,
        int limit,
        Guid afterId,
        CancellationToken cancellationToken);

    /// <summary>Every item declaring a habit reminder time, one keyset page at a time - see <see cref="FindExplicitAsync"/>'s remarks.</summary>
    public Task<IReadOnlyList<HabitReminderCandidate>> FindHabitsAsync(
        int limit, Guid afterId, CancellationToken cancellationToken);

    /// <summary>
    /// Reminder preferences for any number of recipients (looked up in batches), defaulted for any
    /// with no saved row.
    /// </summary>
    public Task<IReadOnlyList<ReminderPreferences>> PreferencesForAsync(
        IReadOnlyCollection<ReminderRecipient> recipients, CancellationToken cancellationToken);
}
