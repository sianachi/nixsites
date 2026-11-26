using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Notifications;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Pets;

/// <summary>Where a person stands against their monthly pet budget. Month and zone are the ones the budget resets in.</summary>
public sealed record PetBudgetStatus(decimal? LimitUsd, decimal SpentUsd, decimal? RemainingUsd, string Month, string TimeZone);

/// <summary>A person's own pet usage for one month, with the budget. Costs are estimates.</summary>
public sealed record PetUsageResponse(PetBudgetStatus Budget, PetUsageGroup Total, IReadOnlyList<PetUsageGroup> Days,
    IReadOnlyList<PetUsageGroup> ByPet, IReadOnlyList<PetUsageGroup> ByModel, IReadOnlyList<PetUsageGroup> BySource);

/// <summary>One finished turn, as the companion reports it. Who, which pet and the source label come only from the ticket Core signed when it started the turn.</summary>
[SuppressMessage("Performance", "CA1812", Justification = "Bound from trusted service HTTP requests.")]
internal sealed record RecordPetUsageRequest(string Ticket, string? WorkspaceId,
    string Provider, string Model, long InputTokens, long CacheReadTokens, long CacheWriteTokens,
    long OutputTokens, decimal? CostUsd, DateTimeOffset StartedAt, int DurationMs);

/// <summary>The labels Core gives a turn's usage. A label is chosen from the session that started the turn, never from a request body.</summary>
public static class PetUsageSources
{
    // shortcut: only an interactive session can start a pet turn today (tokens are refused by
    // AccessTokenScopePolicy), so the label is always "app"; add "token:<name>" with pets:send.
    public const string App = "app";
    public const string Plan = "plan";
    public const string Run = "run";
    public const string Routine = "routine";
    public const string Inline = "inline";

    public static bool IsValid(string source)
    {
        ArgumentNullException.ThrowIfNull(source);
        return IsKnown(source);
    }

    private static bool IsKnown(string source) =>
        source is App or Plan or Run or Routine or Inline
        || source.StartsWith("token:", StringComparison.Ordinal) && source.Length <= 100 && !source.Any(char.IsControl);
}

/// <summary>The month's spending against the person's limit, and the refusal when it is used up.</summary>
public sealed class PetUsageService(IPetUsageStore store, IPrincipalPreferencesStore preferences, NixDispatcher dispatcher,
    INixSessionContextAccessor session, TimeProvider clock, IDataProtectionProvider protection)
{
    private readonly IDataProtector _tickets = protection.CreateProtector("Nix.PetUsage.v1");
    private static readonly TimeSpan TicketLife = TimeSpan.FromHours(2);

    /// <summary>The refusal code when the month's limit is reached.</summary>
    public const string BudgetExhausted = "pets.budget_exhausted";

    internal const string BudgetExhaustedMessage = "This month's pet budget is used up. Raise it in Settings > Pets.";

    private NixSessionContext Caller => session.Current ?? throw new InvalidOperationException("A session is required.");

    /// <summary>
    /// A signed ticket binding one turn's usage report to the caller, pet and source label. The companion echoes it back;
    /// Core trusts nothing else in the report. shortcut: not single-use, so a leaked ticket can repeat reports for its
    /// two hours; add a per-turn nonce row if that matters.
    /// </summary>
    public string Ticket(Guid petId, string source) => _tickets.Protect(string.Create(CultureInfo.InvariantCulture,
        $"{Caller.TenantId.Value}|{Caller.PrincipalId.Value}|{petId}|{clock.GetUtcNow().Add(TicketLife).ToUnixTimeSeconds()}|{source}"));

    /// <summary>The tenant, person, pet and source a live ticket was signed for; <see langword="null"/> when forged, expired or malformed.</summary>
    public (Guid TenantId, Guid PrincipalId, Guid PetId, string Source)? Open(string? ticket)
    {
        if (string.IsNullOrEmpty(ticket) || ticket.Length > 1024)
        {
            return null;
        }

        try
        {
            var parts = _tickets.Unprotect(ticket).Split('|', 5);
            return parts.Length == 5 && Guid.TryParse(parts[0], out var tenant) && Guid.TryParse(parts[1], out var person)
                && Guid.TryParse(parts[2], out var pet) && long.TryParse(parts[3], CultureInfo.InvariantCulture, out var expires)
                && expires > clock.GetUtcNow().ToUnixTimeSeconds() && PetUsageSources.IsValid(parts[4])
                ? (tenant, person, pet, parts[4])
                : null;
        }
        catch (System.Security.Cryptography.CryptographicException)
        {
            return null;
        }
    }

    /// <summary>The calendar month containing <paramref name="at"/> in <paramref name="zone"/>, as UTC bounds.</summary>
    public static (DateTimeOffset From, DateTimeOffset To, string Month) MonthOf(DateTimeOffset at, string zone, string? month = null)
    {
        TimeZoneInfo tz;
        try
        {
            tz = TimeZoneInfo.FindSystemTimeZoneById(zone);
        }
        catch (Exception exception) when (exception is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            tz = TimeZoneInfo.Utc;
        }

        var local = TimeZoneInfo.ConvertTime(at, tz);
        var first = month is not null && DateTime.TryParseExact(month, "yyyy-MM", CultureInfo.InvariantCulture, DateTimeStyles.None, out var asked)
            ? new DateTime(asked.Year, asked.Month, 1, 0, 0, 0, DateTimeKind.Unspecified)
            : new DateTime(local.Year, local.Month, 1, 0, 0, 0, DateTimeKind.Unspecified);
        return (Start(first, tz), Start(first.AddMonths(1), tz), first.ToString("yyyy-MM", CultureInfo.InvariantCulture));
    }

    private static DateTimeOffset Start(DateTime localMidnight, TimeZoneInfo tz) =>
        new(TimeZoneInfo.ConvertTimeToUtc(tz.IsInvalidTime(localMidnight) ? localMidnight.AddHours(1) : localMidnight, tz), TimeSpan.Zero);

    private async Task<string> ZoneAsync(CancellationToken cancellationToken)
    {
        var caller = Caller;
        var saved = await preferences.FindAsync(caller.TenantId, caller.PrincipalId, cancellationToken).ConfigureAwait(false);
        return saved?.TimeZone ?? "Etc/UTC";
    }

    /// <summary>The current month's limit, spend and what is left.</summary>
    public async Task<PetBudgetStatus> BudgetAsync(CancellationToken cancellationToken)
    {
        var caller = Caller;
        var zone = await ZoneAsync(cancellationToken).ConfigureAwait(false);
        var (from, to, month) = MonthOf(clock.GetUtcNow(), zone);
        var settings = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), cancellationToken).ConfigureAwait(false);
        var spent = await store.SpentAsync(caller.TenantId, caller.PrincipalId, from, to, cancellationToken).ConfigureAwait(false);
        var limit = settings.Settings.MonthlyBudgetUsd;
        return new(limit, spent, limit is { } cap ? Math.Max(cap - spent, 0) : null, month, zone);
    }

    /// <summary>Whether a new turn may start: a failure with <see cref="BudgetExhausted"/> once the limit is reached.</summary>
    public async Task<Result<PetBudgetStatus>> RequireAsync(CancellationToken cancellationToken)
    {
        var status = await BudgetAsync(cancellationToken).ConfigureAwait(false);
        return status.RemainingUsd is 0 && status.LimitUsd is not null
            ? Result.Failure<PetBudgetStatus>(new(BudgetExhausted, BudgetExhaustedMessage))
            : Result.Success(status);
    }

    /// <summary>The one line a turn carries so the pet can keep work lean; <see langword="null"/> with no limit.</summary>
    public static string? Line(PetBudgetStatus status) => status is { LimitUsd: { } limit, RemainingUsd: { } left }
        ? string.Create(CultureInfo.InvariantCulture, $"Budget: ${status.SpentUsd:0.00} of ${limit:0.00} used this month, ${left:0.00} left.")
        : null;

    /// <summary>The usage and budget for the current month, or for <paramref name="month"/> (yyyy-MM) when given.</summary>
    public async Task<PetUsageResponse> GetAsync(string? month, CancellationToken cancellationToken)
    {
        var caller = Caller;
        var budget = await BudgetAsync(cancellationToken).ConfigureAwait(false);
        var (from, to, label) = MonthOf(clock.GetUtcNow(), budget.TimeZone, month);
        async Task<IReadOnlyList<PetUsageGroup>> Group(string by) =>
            await store.GroupAsync(caller.TenantId, caller.PrincipalId, by, from, to, budget.TimeZone, cancellationToken).ConfigureAwait(false);
        var days = await Group("day").ConfigureAwait(false);
        var total = new PetUsageGroup(label, days.Sum(day => day.Turns), days.Sum(day => day.InputTokens), days.Sum(day => day.CacheReadTokens),
            days.Sum(day => day.CacheWriteTokens), days.Sum(day => day.OutputTokens), days.Sum(day => day.CostUsd));
        return new(budget, total, days, await Group("pet").ConfigureAwait(false), await Group("model").ConfigureAwait(false),
            await Group("source").ConfigureAwait(false));
    }

    /// <summary>Stores a reported turn, and once per month tells the person when 80% of their limit is used.</summary>
    public async Task RecordAsync(PetUsageRow row, INotificationWriter notifications, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(notifications);
        await store.RecordAsync(row, cancellationToken).ConfigureAwait(false);
        var status = await BudgetAsync(cancellationToken).ConfigureAwait(false);
        if (status.LimitUsd is { } limit && status.SpentUsd >= limit * 0.8m)
        {
            _ = await notifications.CreateAsync(Caller.PrincipalId, NotificationKind.System, "Pet budget at 80%",
                string.Create(CultureInfo.InvariantCulture, $"Your pets have used ${status.SpentUsd:0.00} of this month's ${limit:0.00} budget. Raise it in Settings > Pets."),
                null, null, "pet-budget-80:" + status.Month, cancellationToken).ConfigureAwait(false);
        }
    }
}

internal static class PetUsageEndpoints
{
    internal static void MapPetUsageEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/v1/me/pets/usage", Read).WithTags("Pets").WithName("GetPetUsage")
            .WithSummary("The caller's own pet usage and spending limit")
            .WithDescription("Daily totals for the month with a breakdown by pet, model and source, and the monthly budget "
                + "(limit, spent, remaining) the pets are held to. Costs are estimates. 'month' (yyyy-MM) reads an earlier "
                + "month within the 13 months kept; the budget is always the current month's.")
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
        endpoints.MapPost("/internal/pets/usage", Record).ExcludeFromDescription().WithRequestBodyLimit(4 * 1024);
    }

    private static async Task<Results<Ok<PetUsageResponse>, ProblemHttpResult>> Read(HttpContext http, [FromServices] PetUsageService usage, string? month = null)
    {
        http.Response.Headers.CacheControl = "no-store";
        if (month is not null && !System.Text.RegularExpressions.Regex.IsMatch(month, @"^\d{4}-(0[1-9]|1[0-2])$"))
        {
            return TypedResults.Problem(ApiProblem.Create(http, 422, "pets.invalid_request", "Pet usage could not be read", "Use a month like 2026-11."));
        }

        return TypedResults.Ok(await usage.GetAsync(month, http.RequestAborted).ConfigureAwait(false));
    }

    private static async Task<IResult> Record(RecordPetUsageRequest request, HttpContext http, [FromServices] IIsolatedUnitOfWork isolated,
        [FromServices] PetUsageService usage)
    {
        Guid? workspace = null;
        if (!string.IsNullOrEmpty(request.WorkspaceId))
        {
            if (!Guid.TryParse(request.WorkspaceId, out var parsed))
            {
                return TypedResults.BadRequest();
            }

            workspace = parsed;
        }

        var ticket = usage.Open(request.Ticket);
        if (ticket is not { } bound)
        {
            return TypedResults.Unauthorized();
        }

        if (request.Provider is not (PetProviders.Anthropic or PetProviders.OpenRouter) || request.Model.Length > 160
            || request.InputTokens is < 0 or > 1_000_000_000 || request.CacheReadTokens is < 0 or > 1_000_000_000
            || request.CacheWriteTokens is < 0 or > 1_000_000_000 || request.OutputTokens is < 0 or > 1_000_000_000
            || request.CostUsd is < 0 or > 10_000 || request.DurationMs < 0)
        {
            return TypedResults.BadRequest();
        }

        var row = new PetUsageRow(bound.PetId, workspace, request.Provider, request.Model, bound.Source, request.InputTokens,
            request.CacheReadTokens, request.CacheWriteTokens, request.OutputTokens, request.CostUsd, request.StartedAt, request.DurationMs);
        var context = new NixSessionContext(TenantId.From(bound.TenantId), null, Nix.Domain.Identity.PrincipalId.From(bound.PrincipalId));
        _ = await isolated.RunAsync(context, async (services, token) =>
        {
            await services.GetRequiredService<PetUsageService>()
                .RecordAsync(row, services.GetRequiredService<INotificationWriter>(), token).ConfigureAwait(false);
            return new IsolatedOutcome<bool>(true, true);
        }, http.RequestAborted).ConfigureAwait(false);
        return TypedResults.NoContent();
    }
}
