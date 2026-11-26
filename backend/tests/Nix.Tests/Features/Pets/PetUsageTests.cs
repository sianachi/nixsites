using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Notifications;
using Nix.Domain.Tenancy;
using Nix.Features.Pets;
using Nix.Messaging;
using Nix.Persistence;

namespace Nix.Tests.Features.Pets;

public sealed class PetUsageTests
{
    private static readonly Guid PetId = new("33333333-3333-4333-8333-333333333333");
    private static readonly DateTimeOffset Now = new(2026, 11, 20, 12, 0, 0, TimeSpan.Zero);
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public void The_month_resets_at_local_midnight_in_the_persons_zone()
    {
        var (from, until, month) = PetUsageService.MonthOf(new DateTimeOffset(2026, 11, 30, 12, 0, 0, TimeSpan.Zero), "Pacific/Auckland");
        Assert.Equal("2026-12", month);
        Assert.Equal(new DateTimeOffset(2026, 11, 30, 11, 0, 0, TimeSpan.Zero), from);
        Assert.Equal(new DateTimeOffset(2026, 12, 31, 11, 0, 0, TimeSpan.Zero), until);
    }

    [Fact]
    public void An_unknown_zone_is_read_as_UTC_and_an_earlier_month_can_be_asked_for()
    {
        var (from, until, month) = PetUsageService.MonthOf(Now, "Not/AZone", "2026-02");
        Assert.Equal("2026-02", month);
        Assert.Equal(new DateTimeOffset(2026, 2, 1, 0, 0, 0, TimeSpan.Zero), from);
        Assert.Equal(new DateTimeOffset(2026, 3, 1, 0, 0, 0, TimeSpan.Zero), until);
    }

    [Fact]
    public void The_budget_line_names_spent_limit_and_what_is_left_and_is_absent_without_a_limit()
    {
        Assert.Equal("Budget: $12.40 of $20.00 used this month, $7.60 left.",
            PetUsageService.Line(new(20m, 12.4m, 7.6m, "2026-11", "Etc/UTC")));
        Assert.Null(PetUsageService.Line(new(null, 3m, null, "2026-11", "Etc/UTC")));
    }

    [Theory]
    [InlineData("app", true)]
    [InlineData("plan", true)]
    [InlineData("run", true)]
    [InlineData("routine", true)]
    [InlineData("inline", true)]
    [InlineData("token:Claude", true)]
    [InlineData("token:bad\nname", false)]
    [InlineData("", false)]
    [InlineData("admin", false)]
    public void Only_known_source_labels_are_stored(string source, bool valid) =>
        Assert.Equal(valid, PetUsageSources.IsValid(source));

    [Theory]
    [InlineData(0.01, true)]
    [InlineData(20, true)]
    [InlineData(0, false)]
    [InlineData(-5, false)]
    [InlineData(100001, false)]
    [InlineData(1.005, false)]
    public void A_monthly_limit_is_a_positive_amount_in_whole_cents(double usd, bool valid)
    {
        var settings = new PetSettings(false, PetId, [new(PetId, "Nix", "owl", "")], MonthlyBudgetUsd: (decimal)usd);
        Assert.Equal(valid, PetSettingsValidation.IsValid(settings));
    }

    [Theory]
    [InlineData(5.0, 4.99, true)]
    [InlineData(5.0, 5.0, false)]
    [InlineData(5.0, 7.5, false)]
    [InlineData(null, 1000.0, true)]
    public async Task A_new_turn_is_refused_once_the_limit_is_reached(double? limit, double spent, bool allowed)
    {
        var service = Service(limit is { } cap ? (decimal)cap : null, (decimal)spent, out _);
        var result = await service.RequireAsync(Cancellation);
        Assert.Equal(allowed, result.IsSuccess);
        if (!allowed)
        {
            Assert.Equal("pets.budget_exhausted", result.Error.Code);
            Assert.Equal("This month's pet budget is used up. Raise it in Settings > Pets.", result.Error.Message);
        }
    }

    [Fact]
    public async Task The_eighty_percent_notice_is_sent_once_per_month_through_the_inbox()
    {
        var service = Service(10m, 8m, out var notices);
        await service.RecordAsync(Row(), notices, Cancellation);
        var notice = Assert.Single(notices.Created);
        Assert.Equal("pet-budget-80:2026-11", notice);
        var below = Service(10m, 7.99m, out var none);
        await below.RecordAsync(Row(), none, Cancellation);
        Assert.Empty(none.Created);
    }

    private static PetUsageRow Row() => new(PetId, null, "anthropic", "claude-haiku-5-5", "app", 1, 0, 0, 1, 0.01m, Now, 5);

    internal static PetUsageService Service(decimal? limit, decimal spent) => Service(limit, spent, out _);

    private static PetUsageService Service(decimal? limit, decimal spent, out Notices notices)
    {
        var session = new ScopedNixSessionContextAccessor();
        session.Set(new NixSessionContext(TenantId.Create(), null, PrincipalId.Create()));
        var services = new ServiceCollection();
        services.AddSingleton<IQueryHandler<GetPetSettings, PetSettingsResponse>>(new Settings(limit));
        notices = new Notices();
        return new PetUsageService(new Store(spent), new NoPreferences(), new NixDispatcher(services.BuildServiceProvider()), session, new Clock());
    }

    private sealed class Clock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class Settings(decimal? limit) : IQueryHandler<GetPetSettings, PetSettingsResponse>
    {
        public ValueTask<PetSettingsResponse> HandleAsync(GetPetSettings query, CancellationToken cancellationToken) =>
            ValueTask.FromResult(new PetSettingsResponse(1, new PetSettings(true, PetId, [new(PetId, "Nix", "owl", "")], MonthlyBudgetUsd: limit)));
    }

    private sealed class Store(decimal spent) : IPetUsageStore
    {
        public Task RecordAsync(PetUsageRow row, CancellationToken cancellationToken) => Task.CompletedTask;

        public Task<IReadOnlyList<PetUsageGroup>> GroupAsync(TenantId tenantId, PrincipalId principalId, string by,
            DateTimeOffset from, DateTimeOffset until, string timeZone, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<PetUsageGroup>>([]);

        public Task<decimal> SpentAsync(TenantId tenantId, PrincipalId principalId, DateTimeOffset from, DateTimeOffset until,
            CancellationToken cancellationToken) => Task.FromResult(spent);
    }

    private sealed class NoPreferences : IPrincipalPreferencesStore
    {
        public ValueTask<PrincipalPreferences?> FindAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
            ValueTask.FromResult<PrincipalPreferences?>(null);

        public Task<bool> SaveAsync(PrincipalPreferences preferences, long expectedRevision, CancellationToken cancellationToken) =>
            Task.FromResult(true);
    }

    private sealed class Notices : INotificationWriter
    {
        public List<string> Created { get; } = [];

        public Task<NotificationWriteResult> CreateAsync(PrincipalId principal, NotificationKind kind, string title, string body,
            Nix.Domain.Items.ItemId? itemId, WorkspaceId? workspaceId, string dedupeKey, CancellationToken cancellationToken)
        {
            Created.Add(dedupeKey);
            return Task.FromResult(default(NotificationWriteResult)!);
        }

        public Task<NotificationWriteResult> CreatePetDecisionAsync(PrincipalId principal, Nix.Domain.Items.ItemId itemId,
            WorkspaceId workspaceId, NotificationPetDecisionTarget target, CancellationToken cancellationToken) =>
            throw new NotSupportedException();
    }
}
