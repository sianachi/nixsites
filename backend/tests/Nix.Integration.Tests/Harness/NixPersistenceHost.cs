using System.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Persistence;
using Nix.Persistence.ObjectStorage;

namespace Nix.Integration.Tests.Harness;

/// <summary>
/// A composition root built the way the application builds one - through
/// <see cref="NixPersistenceServiceCollectionExtensions.AddNixPersistence(IServiceCollection, string)"/>
/// - so the tests exercise the registration the host will use rather than a hand-wired
/// approximation of it.
/// </summary>
/// <remarks>
/// Each host owns its own <c>NpgsqlDataSource</c>, and therefore its own connection pool. That is
/// what lets the pool-scoping proof ask for a pool of exactly one physical connection without
/// disturbing every other test in the suite.
/// </remarks>
internal sealed class NixPersistenceHost : IAsyncDisposable
{
    private readonly ServiceProvider _services;

    private NixPersistenceHost(ServiceProvider services) => _services = services;

    /// <summary>
    /// Builds a host over <paramref name="connectionString"/>.
    /// </summary>
    /// <param name="connectionString">A connection string for the runtime role.</param>
    /// <param name="testInterceptor">An optional observer appended by an integration test.</param>
    /// <returns>The host.</returns>
    public static NixPersistenceHost Create(
        string connectionString,
        IInterceptor? testInterceptor = null,
        IConfiguration? configuration = null)
    {
        var services = new ServiceCollection();

        // The host configuration, when a suite needs one (sites, object storage). Registered first
        // so AddNixPersistence keeps it instead of its empty stand-in.
        configuration ??= new ConfigurationBuilder().Build();
        services.AddSingleton(configuration);
        services.AddNixPersistence(connectionString);
        services.AddNixObjectStorage(configuration);

        // Registered only here, never by production composition (ADR-0051's A2 lane): a fixed
        // point the scheduling tests use to exercise plan -> fire -> notify end to end without a
        // real reminder or automation source existing yet.
        services.AddScoped<Nix.Abstractions.Scheduling.ITriggerSource, SystemTestTriggerSource>();

        if (testInterceptor is not null)
        {
            // Test-only composition seam: append an observer to the real persistence graph so
            // plan evidence can capture the exact EF command production executes. The runtime
            // registration remains AddNixPersistence above; this does not replace any of its RLS
            // interceptors or context options.
            services.AddDbContext<NixDbContext>(
                (_, builder) => builder.AddInterceptors(testInterceptor));
        }

        return new NixPersistenceHost(services.BuildServiceProvider(validateScopes: true));
    }

    /// <summary>
    /// Opens a scope, establishes <paramref name="context"/> as its tenant, and begins a
    /// transaction.
    /// </summary>
    /// <param name="context">The tenant scope for this unit of work.</param>
    /// <param name="cancellationToken">Cancels the begin.</param>
    /// <returns>The started unit of work; the caller disposes it.</returns>
    public Task<NixUnitOfWork> BeginUnitOfWorkAsync(
        NixSessionContext context,
        CancellationToken cancellationToken = default) =>
        NixUnitOfWork.StartAsync(_services.CreateAsyncScope(), context, IsolationLevel.ReadCommitted, cancellationToken);

    public Task<NixUnitOfWork> BeginUnitOfWorkAsync(
        NixSessionContext context,
        IsolationLevel isolationLevel,
        CancellationToken cancellationToken) =>
        NixUnitOfWork.StartAsync(_services.CreateAsyncScope(), context, isolationLevel, cancellationToken);

    /// <summary>
    /// Opens a scope without establishing a tenant, for the tests that assert what happens when
    /// nobody did.
    /// </summary>
    /// <returns>The scope; the caller disposes it.</returns>
    public AsyncServiceScope CreateUnscopedScope() => _services.CreateAsyncScope();

    /// <inheritdoc />
    public ValueTask DisposeAsync() => _services.DisposeAsync();
}
