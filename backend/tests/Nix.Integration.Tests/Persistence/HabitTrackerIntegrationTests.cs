using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Habits;
using Nix.Features.Items;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Habit settings and check-ins over the real PostgreSQL persistence boundary.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class HabitTrackerIntegrationTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;
    private static WorkspaceId Workspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    public HabitTrackerIntegrationTests(NixPostgresFixture fixture) => _fixture = fixture;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_quantity_check_in_is_read_back_and_can_be_undone()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var habit = await CreateHabitAsync(dispatcher);
            var configured = await dispatcher.SendAsync<SetHabitSettings, HabitTrackerResponse>(
                new SetHabitSettings(habit.Id, new HabitSettingsRequest("daily", [], "UTC", new DateOnly(2026, 1, 1), 2, "reps")), Cancellation);
            Assert.True(configured.IsSuccess, configured.IsSuccess ? "" : configured.Error.Message);

            var checkIn = await dispatcher.SendAsync<SetHabitCheckIn, HabitCheckInResponse>(
                new SetHabitCheckIn(habit.Id, new DateOnly(2026, 9, 10), new HabitCheckInRequest(false, 2)), Cancellation);
            Assert.True(checkIn.IsSuccess, checkIn.IsSuccess ? "" : checkIn.Error.Message);
            Assert.True(checkIn.Value.Completed);

            var changed = await dispatcher.SendAsync<SetHabitSettings, HabitTrackerResponse>(
                new SetHabitSettings(habit.Id, new HabitSettingsRequest("daily", [], "UTC", new DateOnly(2026, 1, 1), 3, "reps")), Cancellation);
            Assert.True(changed.IsSuccess, changed.IsSuccess ? "" : changed.Error.Message);

            var read = await dispatcher.QueryAsync<ReadHabitTracker, Result<HabitTrackerResponse>>(
                new ReadHabitTracker(habit.Id, new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 14)), Cancellation);
            Assert.True(read.IsSuccess, read.IsSuccess ? "" : read.Error.Message);
            Assert.Contains(read.Value.CheckIns, row => row.Id == checkIn.Value.Id);

            var undone = await dispatcher.SendAsync<UndoHabitCheckIn, ItemId>(
                new UndoHabitCheckIn(habit.Id, new DateOnly(2026, 9, 10)), Cancellation);
            Assert.True(undone.IsSuccess, undone.IsSuccess ? "" : undone.Error.Message);
            var afterUndo = await dispatcher.QueryAsync<ReadHabitTracker, Result<HabitTrackerResponse>>(
                new ReadHabitTracker(habit.Id, new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 14)), Cancellation);
            Assert.True(afterUndo.IsSuccess);
            Assert.DoesNotContain(afterUndo.Value.CheckIns, row => row.Id == checkIn.Value.Id);
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Two_check_in_writes_for_one_day_are_idempotent()
    {
        var setup = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        ItemId habitId;
        await using (setup.ConfigureAwait(false))
        {
            var dispatcher = setup.Resolve<NixDispatcher>();
            var habit = await CreateHabitAsync(dispatcher);
            habitId = habit.Id;
            var configured = await dispatcher.SendAsync<SetHabitSettings, HabitTrackerResponse>(
                new SetHabitSettings(habitId, new HabitSettingsRequest("daily", [], "UTC", new DateOnly(2026, 1, 1), 1, "done")), Cancellation);
            Assert.True(configured.IsSuccess);
            await setup.CommitAsync(Cancellation);
        }

        var first = WriteCheckInAsync(habitId, 1);
        var second = WriteCheckInAsync(habitId, 1);
        var results = await Task.WhenAll(first, second);
        Assert.All(results, result => Assert.True(result.IsSuccess, result.IsSuccess ? "" : result.Error.Message));
        Assert.Equal(results[0].Value.Id, results[1].Value.Id);

        var readWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (readWork.ConfigureAwait(false))
        {
            var read = await readWork.Resolve<NixDispatcher>().QueryAsync<ReadHabitTracker, Result<HabitTrackerResponse>>(
                new ReadHabitTracker(habitId, new DateOnly(2026, 9, 10), new DateOnly(2026, 9, 10)), Cancellation);
            Assert.True(read.IsSuccess, read.IsSuccess ? "" : read.Error.Message);
            Assert.Single(read.Value.CheckIns);
        }
    }

    [Fact]
    public async Task A_check_in_for_an_unscheduled_or_future_day_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var habit = await CreateHabitAsync(dispatcher);
            var configured = await dispatcher.SendAsync<SetHabitSettings, HabitTrackerResponse>(
                new SetHabitSettings(habit.Id, new HabitSettingsRequest("weekly", [1], "UTC", new DateOnly(2026, 1, 1), 1, "done")), Cancellation);
            Assert.True(configured.IsSuccess);
            var refused = await dispatcher.SendAsync<SetHabitCheckIn, HabitCheckInResponse>(
                new SetHabitCheckIn(habit.Id, new DateOnly(2026, 9, 13), new HabitCheckInRequest(false, 1)), Cancellation);
            Assert.True(refused.IsFailure);
            Assert.Equal("habits.not_scheduled", refused.Error.Code);

            var future = await dispatcher.SendAsync<SetHabitCheckIn, HabitCheckInResponse>(
                new SetHabitCheckIn(habit.Id, DateOnly.FromDateTime(DateTime.UtcNow).AddDays(1), new HabitCheckInRequest(false, 1)), Cancellation);
            Assert.True(future.IsFailure);
            Assert.Equal("habits.not_scheduled", future.Error.Code);
        }
    }

    [Fact]
    public async Task Invalid_settings_are_refused_and_other_tenants_cannot_read()
    {
        ItemId habitId;
        var owner = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (owner.ConfigureAwait(false))
        {
            var dispatcher = owner.Resolve<NixDispatcher>();
            var habit = await CreateHabitAsync(dispatcher);
            habitId = habit.Id;
            var invalidTarget = await dispatcher.SendAsync<SetHabitSettings, HabitTrackerResponse>(
                new SetHabitSettings(habitId, new HabitSettingsRequest("daily", [], "UTC", new DateOnly(2026, 1, 1), 0, "done")), Cancellation);
            Assert.True(invalidTarget.IsFailure);
            Assert.Equal("habits.invalid_settings", invalidTarget.Error.Code);
            var invalidZone = await dispatcher.SendAsync<SetHabitSettings, HabitTrackerResponse>(
                new SetHabitSettings(habitId, new HabitSettingsRequest("daily", [], "Not/AZone", new DateOnly(2026, 1, 1), 1, "done")), Cancellation);
            Assert.True(invalidZone.IsFailure);
            Assert.Equal("habits.invalid_settings", invalidZone.Error.Code);
            var valid = await dispatcher.SendAsync<SetHabitSettings, HabitTrackerResponse>(
                new SetHabitSettings(habitId, new HabitSettingsRequest("daily", [], "UTC", new DateOnly(2026, 1, 1), 1, "done")), Cancellation);
            Assert.True(valid.IsSuccess);
            await owner.CommitAsync(Cancellation);
        }

        var outsider = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (outsider.ConfigureAwait(false))
        {
            var read = await outsider.Resolve<NixDispatcher>().QueryAsync<ReadHabitTracker, Result<HabitTrackerResponse>>(
                new ReadHabitTracker(habitId, new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 14)), Cancellation);
            Assert.True(read.IsFailure);
            Assert.Equal("items.not_found", read.Error.Code);
        }
    }

    [Fact]
    public async Task Occurrences_report_partial_and_today_pending_states()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var habit = await CreateHabitAsync(dispatcher);
            var today = DateOnly.FromDateTime(DateTime.UtcNow);
            var settings = await dispatcher.SendAsync<SetHabitSettings, HabitTrackerResponse>(
                new SetHabitSettings(habit.Id, new HabitSettingsRequest("daily", [], "UTC", today.AddDays(-30), 2, "reps")), Cancellation);
            Assert.True(settings.IsSuccess);
            var partial = await dispatcher.SendAsync<SetHabitCheckIn, HabitCheckInResponse>(
                new SetHabitCheckIn(habit.Id, today.AddDays(-2), new HabitCheckInRequest(false, 1)), Cancellation);
            Assert.True(partial.IsSuccess);
            var read = await dispatcher.QueryAsync<ReadHabitTracker, Result<HabitTrackerResponse>>(
                new ReadHabitTracker(habit.Id, today.AddDays(-2), today), Cancellation);
            Assert.True(read.IsSuccess, read.IsSuccess ? "" : read.Error.Message);
            Assert.Contains(read.Value.Occurrences!, row => row.Date == today.AddDays(-2) && row.State == "partial");
            Assert.Contains(read.Value.Occurrences!, row => row.Date == today && row.State == "scheduled");
        }
    }

    [Fact]
    public async Task Pause_and_archive_status_are_returned_and_block_check_ins()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var habit = await CreateHabitAsync(dispatcher);
            var configured = await dispatcher.SendAsync<SetHabitSettings, HabitTrackerResponse>(
                new SetHabitSettings(habit.Id, new HabitSettingsRequest("daily", [], "UTC", new DateOnly(2026, 1, 1), 1, "done")), Cancellation);
            Assert.True(configured.IsSuccess);
            var paused = await dispatcher.SendAsync<SetHabitStatus, HabitStatusResponse>(
                new SetHabitStatus(habit.Id, new HabitStatusRequest("paused")), Cancellation);
            Assert.True(paused.IsSuccess);
            var refused = await dispatcher.SendAsync<SetHabitCheckIn, HabitCheckInResponse>(
                new SetHabitCheckIn(habit.Id, new DateOnly(2026, 9, 10), new HabitCheckInRequest(false, 1)), Cancellation);
            Assert.True(refused.IsFailure);
            Assert.Equal("habits.paused", refused.Error.Code);
            var archived = await dispatcher.SendAsync<SetHabitStatus, HabitStatusResponse>(
                new SetHabitStatus(habit.Id, new HabitStatusRequest("archived")), Cancellation);
            Assert.True(archived.IsSuccess);
        }
    }

    private static async Task<Item> CreateHabitAsync(NixDispatcher dispatcher)
    {
        var created = await dispatcher.SendAsync<CreateItem, Item>(
            new CreateItem(Workspace, "note", "Integration habit", null, null), Cancellation);
        Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
        return created.Value;
    }

    private async Task<Result<HabitCheckInResponse>> WriteCheckInAsync(ItemId habitId, decimal quantity)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>().SendAsync<SetHabitCheckIn, HabitCheckInResponse>(
                new SetHabitCheckIn(habitId, new DateOnly(2026, 9, 10), new HabitCheckInRequest(false, quantity)), Cancellation);
            await work.CommitAsync(Cancellation);
            return result;
        }
    }
}
