using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;

namespace Nix.Integration.Tests.Persistence;

/// <summary>A worker response is not observable until the enclosing execution can commit.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class WorkerExecutionMiddlewareIntegrationTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly Guid JobId = new("81111111-1111-4111-8111-111111111111");
    private static readonly Guid TenantId = new("82222222-2222-4222-8222-222222222222");
    private static readonly Guid WorkspaceId = new("83333333-3333-4333-8333-333333333333");
    private static readonly Guid ActorId = new("84444444-4444-4444-8444-444444444444");
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_lost_final_fence_replaces_the_buffered_success_with_a_conflict()
    {
        var context = Context();
        await using var scope = fixture.Application.CreateUnscopedScope();
        var middleware = new WorkerExecutionMiddleware(async next =>
        {
            next.Response.StatusCode = StatusCodes.Status200OK;
            await next.Response.WriteAsJsonAsync(new { accepted = true }, Cancellation);
        });

        await middleware.InvokeAsync(
            context,
            new DispatchFake(),
            new FenceFake(held: false),
            scope.ServiceProvider.GetRequiredService<ScopedNixSessionContextAccessor>(),
            scope.ServiceProvider.GetRequiredService<NixDbContext>());

        Assert.Equal(StatusCodes.Status409Conflict, context.Response.StatusCode);
        context.Response.Body.Position = 0;
        using var response = await JsonDocument.ParseAsync(context.Response.Body, cancellationToken: Cancellation);
        Assert.Equal("worker.execution_refused", response.RootElement.GetProperty("code").GetString());
        Assert.False(response.RootElement.TryGetProperty("accepted", out _));
    }

    [Fact]
    public async Task A_held_final_fence_publishes_the_buffered_success_after_commit()
    {
        var context = Context();
        await using var scope = fixture.Application.CreateUnscopedScope();
        var middleware = new WorkerExecutionMiddleware(async next =>
        {
            next.Response.StatusCode = StatusCodes.Status200OK;
            await next.Response.WriteAsJsonAsync(new { accepted = true }, Cancellation);
        });

        await middleware.InvokeAsync(
            context,
            new DispatchFake(),
            new FenceFake(held: true),
            scope.ServiceProvider.GetRequiredService<ScopedNixSessionContextAccessor>(),
            scope.ServiceProvider.GetRequiredService<NixDbContext>());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        context.Response.Body.Position = 0;
        using var response = await JsonDocument.ParseAsync(context.Response.Body, cancellationToken: Cancellation);
        Assert.True(response.RootElement.GetProperty("accepted").GetBoolean());
    }

    private static DefaultHttpContext Context()
    {
        var context = new DefaultHttpContext();
        context.Request.Headers[WorkerExecutionMiddleware.JobHeaderName] = JobId.ToString("D");
        context.Request.Headers[WorkerExecutionMiddleware.ExecutionHeaderName] = "worker:test";
        context.Response.Body = new MemoryStream();
        context.RequestAborted = Cancellation;
        return context;
    }

    private sealed class FenceFake(bool held) : IWorkerExecutionFence
    {
        public ValueTask<bool> HoldAsync(
            Guid jobId,
            string owner,
            WorkerExecutionAuthorization authorization,
            CancellationToken cancellationToken) => ValueTask.FromResult(held);
    }

    private sealed class DispatchFake : IWorkerDispatchStore
    {
        public ValueTask<WorkerExecutionAuthorization?> AuthorizeExecutionAsync(
            Guid jobId,
            string owner,
            CancellationToken cancellationToken) => ValueTask.FromResult<WorkerExecutionAuthorization?>(
                new WorkerExecutionAuthorization(TenantId, WorkspaceId, ActorId, "template.commit"));

        public ValueTask<IReadOnlyList<DispatchedWorkerJob>> LeaseJobsAsync(string? kind, string owner, int limit, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<DispatchedWorkerJob?> ClaimJobAsync(Guid jobId, string owner, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> RenewJobAsync(Guid jobId, string owner, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<WorkerExecutionState?> GetJobStateAsync(Guid jobId, string owner, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<WorkerResultApplication> ApplyResultAsync(Guid jobId, string owner, bool succeeded, bool retryable, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> FinishJobAsync(Guid jobId, string owner, bool succeeded, bool retryable, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> ScheduleExportCleanupAsync(Guid jobId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<IReadOnlyList<DispatchedWorkerJob>> InterruptJobsAsync(string ownerPrefix, IReadOnlyList<string> kinds, string errorCode, CancellationToken cancellationToken) => throw new NotSupportedException();
    }
}
