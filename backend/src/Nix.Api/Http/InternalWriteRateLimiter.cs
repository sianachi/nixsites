using System.Collections.Concurrent;
using System.Threading.RateLimiting;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Http;

/// <summary>Partitions trusted-service mutations by the authenticated tenant and principal.</summary>
public sealed class InternalWriteRateLimiter : IDisposable
{
    private readonly ConcurrentDictionary<InternalCaller, FixedWindowRateLimiter> _limiters = [];
    private readonly int _permitLimit;
    private readonly TimeSpan _window;

    public InternalWriteRateLimiter(int permitLimit, TimeSpan window)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(permitLimit, 1);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(window, TimeSpan.Zero);

        _permitLimit = permitLimit;
        _window = window;
    }

    internal RateLimitLease Attempt(NixSessionContext session) =>
        _limiters.GetOrAdd(
            new InternalCaller(session.TenantId, session.PrincipalId),
            _ => new FixedWindowRateLimiter(new FixedWindowRateLimiterOptions
            {
                AutoReplenishment = true,
                PermitLimit = _permitLimit,
                QueueLimit = 0,
                Window = _window,
            })).AttemptAcquire(1);

    public void Dispose()
    {
        foreach (var limiter in _limiters.Values)
        {
            limiter.Dispose();
        }
    }

    private readonly record struct InternalCaller(TenantId TenantId, PrincipalId PrincipalId);
}

public sealed class InternalWriteRateLimitMiddleware(RequestDelegate next)
{
    private static readonly TimeSpan RetryAfterFallback = TimeSpan.FromMinutes(1);

    public async Task InvokeAsync(
        HttpContext context,
        INixSessionContextAccessor sessionAccessor,
        InternalWriteRateLimiter limiter,
        ILogger<InternalWriteRateLimitMiddleware> logger)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(sessionAccessor);
        ArgumentNullException.ThrowIfNull(limiter);
        ArgumentNullException.ThrowIfNull(logger);

        if (!IsMutation(context.Request.Method))
        {
            await next(context).ConfigureAwait(false);
            return;
        }

        var session = sessionAccessor.Current;
        if (session is null || !session.Value.IsComplete)
        {
            throw new InvalidOperationException(
                "Internal write limiting must run after authenticated session resolution.");
        }

        using var lease = limiter.Attempt(session.Value);
        if (lease.IsAcquired)
        {
            await next(context).ConfigureAwait(false);
            return;
        }

        var retryAfter = lease.TryGetMetadata(MetadataName.RetryAfter, out var value)
            ? value
            : RetryAfterFallback;
        await RateLimitRefusal.WriteAsync(
            context,
            logger,
            RateLimitRefusal.WritesPolicyName,
            retryAfter,
            LogLevel.Information,
            context.RequestAborted).ConfigureAwait(false);
    }

    private static bool IsMutation(string method) =>
        HttpMethods.IsPost(method)
        || HttpMethods.IsPut(method)
        || HttpMethods.IsPatch(method)
        || HttpMethods.IsDelete(method);
}
