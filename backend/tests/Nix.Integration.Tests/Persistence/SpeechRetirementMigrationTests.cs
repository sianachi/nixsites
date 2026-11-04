using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions.Workers;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class SpeechRetirementMigrationTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Upgrade_cancels_only_active_speech_jobs()
    {
        var options = new DbContextOptionsBuilder<NixDbContext>()
            .UseNpgsql(fixture.MigratorConnectionString).Options;
        await using var context = new NixDbContext(options);
        var migrator = context.GetService<IMigrator>();
        await migrator.MigrateAsync("20261009160000_CliBrowserLogin", Cancellation);
        try
        {
            var before = new DateTimeOffset(2020, 1, 1, 0, 0, 0, TimeSpan.Zero);
            var jobs = new List<WorkerJob>();
            foreach (var (kind, status, tenant) in new[]
            {
                ("transcribe.audio", "queued", M0SchemaSeed.Alpha),
                ("transcribe.audio", "running", M0SchemaSeed.Alpha),
                ("transcribe.audio", "queued", M0SchemaSeed.Beta),
                ("transcribe.audio", "completed", M0SchemaSeed.Alpha),
                ("transcribe.audio", "failed", M0SchemaSeed.Alpha),
                ("transcribe.audio", "cancelled", M0SchemaSeed.Alpha),
                ("export.docx", "queued", M0SchemaSeed.Alpha),
            })
            {
                var job = new WorkerJob
                {
                    Id = WorkerJobId.Create(),
                    TenantId = TenantId.From(tenant.TenantId),
                    WorkspaceId = WorkspaceId.From(tenant.WorkspaceId),
                    ActorId = PrincipalId.From(tenant.PrincipalId),
                    Kind = kind,
                    IdempotencyKey = Guid.NewGuid().ToString(),
                    Payload = "{}",
                    Result = "{\"preserved\": true}",
                    Status = status,
                    LeaseOwner = status == "running" ? "old-speech-worker" : null,
                    LeaseUntil = status == "running" ? DateTimeOffset.UtcNow.AddHours(1) : null,
                    CompletedAt = status is "completed" or "failed" or "cancelled" ? before : null,
                    CreatedAt = before,
                    UpdatedAt = before,
                };
                jobs.Add(job);
                context.WorkerJobs.Add(job);
            }
            await context.SaveChangesAsync(Cancellation);

            var unchangedJobs = jobs.Where(job => job.Kind != "transcribe.audio"
                || job.Status is "completed" or "failed" or "cancelled")
                .ToDictionary(job => job.Id, job => JsonSerializer.Serialize(job));
            var files = await context.FileVersions.AsNoTracking().OrderBy(file => file.Id).ToListAsync(Cancellation);
            var transcripts = await context.ItemTranscriptions.AsNoTracking().OrderBy(row => row.AudioItemId).ToListAsync(Cancellation);
            Assert.NotEmpty(files);
            Assert.NotEmpty(transcripts);
            var filesBefore = JsonSerializer.Serialize(files);
            var transcriptsBefore = JsonSerializer.Serialize(transcripts);

            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);

            foreach (var original in jobs)
            {
                var job = await context.WorkerJobs.AsNoTracking().SingleAsync(row => row.Id == original.Id, Cancellation);
                Assert.Equal(original.Payload, job.Payload);
                Assert.Equal(original.Result, job.Result);
                if (unchangedJobs.TryGetValue(job.Id, out var unchanged))
                {
                    Assert.Equal(unchanged, JsonSerializer.Serialize(job));
                }
                else
                {
                    Assert.Equal("cancelled", job.Status);
                    Assert.True(job.CancellationRequested);
                    Assert.Null(job.LeaseOwner);
                    Assert.Null(job.LeaseUntil);
                    Assert.Equal("job_cancelled", job.ErrorCode);
                    Assert.True(job.CompletedAt > before);
                    Assert.True(job.UpdatedAt > before);
                }
            }
            Assert.Equal(filesBefore, JsonSerializer.Serialize(await context.FileVersions.AsNoTracking().OrderBy(file => file.Id).ToListAsync(Cancellation)));
            Assert.Equal(transcriptsBefore, JsonSerializer.Serialize(await context.ItemTranscriptions.AsNoTracking().OrderBy(row => row.AudioItemId).ToListAsync(Cancellation)));

            await using var scope = fixture.Application.CreateUnscopedScope();
            var dispatch = scope.ServiceProvider.GetRequiredService<IWorkerDispatchStore>();
            Assert.Empty(await dispatch.LeaseJobsAsync("transcribe.audio", "new-worker", 10, 60, Cancellation));
        }
        finally
        {
            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);
        }
    }
}
