using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using Nix.Abstractions.Workers;
using Nix.Workers.Push;
using Nix.Workers.Queue;

namespace Nix.Workers;

/// <summary>Registers the in-process workers: one host per configured family, the startup sweep, and their clients.</summary>
public static class WorkersServiceCollectionExtensions
{
    /// <summary>The named client the calendar provider transports use.</summary>
    public const string CalendarProviderHttpClientName = "worker-calendar-provider";

    /// <summary>The named client capability-URL transfers use.</summary>
    public const string ObjectTransferHttpClientName = "worker-object-transfer";

    public static IServiceCollection AddNixWorkers(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);
        services.Configure<WorkerOptions>(configuration.GetSection(WorkerOptions.SectionName));
        services.Configure<PushOptions>(configuration.GetSection(PushOptions.SectionName));
        services.TryAddSingleton(provider => new InProcessJobQueue(
            provider.GetRequiredService<IOptions<WorkerOptions>>().Value.HostedFamilies(provider.GetServices<IWorkerJobHandler>())));
        services.TryAddSingleton<IJobQueue>(provider => provider.GetRequiredService<InProcessJobQueue>());
        services.AddHttpClient(WorkerLoopbackClient.HttpClientName, static client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(static () => new HttpClientHandler
            {
                AllowAutoRedirect = false,
                AutomaticDecompression = System.Net.DecompressionMethods.None,
            });
        services.TryAddSingleton<WorkerLoopbackClient>();
        services.TryAddSingleton(provider => new PushTransport(
            TimeSpan.FromSeconds(provider.GetRequiredService<IOptions<WorkerOptions>>().Value.RequestTimeoutSeconds)));

        services.AddSingleton<IWorkerJobHandler, NotifyPushHandler>();

        // Calendar providers: the same origin-locked, redirect-refusing client shape the Go worker had.
        services.AddHttpClient(CalendarProviderHttpClientName, static client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(static () => new HttpClientHandler
            {
                AllowAutoRedirect = false,
                AutomaticDecompression = System.Net.DecompressionMethods.None,
            });
        services.AddSingleton<IWorkerJobHandler>(provider =>
        {
            var calendar = provider.GetRequiredService<IOptions<Nix.Features.CalendarSync.CalendarSyncOptions>>().Value;
            var timeout = TimeSpan.FromSeconds(provider.GetRequiredService<IOptions<WorkerOptions>>().Value.RequestTimeoutSeconds);
            var logger = provider.GetService<ILogger<CalendarSyncHandler>>();
            HttpClient Client()
            {
                var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient(CalendarProviderHttpClientName);
                client.Timeout = timeout;
                return client;
            }
            var providers = new Dictionary<string, Nix.Workers.Calendar.ICalendarProvider>(StringComparer.Ordinal)
            {
                ["google"] = new Nix.Workers.Calendar.GoogleCalendarClient(new Nix.Workers.Calendar.CalendarTransport(Client(), calendar.Google.ApiOrigin)),
                ["microsoft"] = new Nix.Workers.Calendar.GraphCalendarClient(
                    new Nix.Workers.Calendar.CalendarTransport(Client(), calendar.Microsoft.ApiOrigin),
                    zone => CalendarSyncHandlerLog.UnknownZone(logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger<CalendarSyncHandler>.Instance, zone)),
            };
            return new CalendarSyncHandler(provider.GetRequiredService<WorkerLoopbackClient>(), providers, logger);
        });

        // Export: the bundle stream comes from Collab, files and results move through object storage
        // capabilities; both transports refuse redirects and keep an exact origin allowlist.
        services.AddHttpClient(ObjectTransferHttpClientName, static client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(static () => new HttpClientHandler
            {
                AllowAutoRedirect = false,
                AutomaticDecompression = System.Net.DecompressionMethods.None,
            });
        services.AddSingleton<IWorkerJobHandler>(provider =>
        {
            var options = provider.GetRequiredService<IOptions<WorkerOptions>>();
            var timeout = TimeSpan.FromSeconds(options.Value.RequestTimeoutSeconds);
            HttpClient Client()
            {
                var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient(ObjectTransferHttpClientName);
                client.Timeout = timeout;
                return client;
            }
            var collabOrigins = new[] { configuration["Nix:Collaboration:BaseUrl"] ?? string.Empty };
            var objectOrigins = new[] { configuration["Nix:ObjectStorage:Endpoint"] ?? string.Empty, configuration["Nix:ObjectStorage:PublicOrigin"] ?? string.Empty };
            return new ExportJobHandler(
                provider.GetRequiredService<WorkerLoopbackClient>(),
                new Nix.Workers.Transfer.ObjectTransfer(Client(), collabOrigins),
                new Nix.Workers.Transfer.ObjectTransfer(Client(), objectOrigins),
                configuration,
                options);
        });
        services.TryAddSingleton<IWorkerCapabilityRegistry, Nix.Persistence.RabbitMq.WorkerCapabilityRegistry>();
        services.AddSingleton<IHostedService, ExportCapabilityAdvertiser>();

        // Import family: uploads, imports, template imports and copies move bytes through object
        // storage capabilities; note bodies go to Collab with the execution proof.
        services.AddSingleton<IWorkerJobHandler>(provider => new ObjectCleanupHandler(
            provider.GetRequiredService<WorkerLoopbackClient>(), ObjectTransfer(provider, configuration), provider.GetRequiredService<TimeProvider>()));
        services.AddSingleton<IWorkerJobHandler>(provider => new TemplateFileCopyHandler(
            provider.GetRequiredService<WorkerLoopbackClient>(), ObjectTransfer(provider, configuration)));
        services.AddSingleton<IWorkerJobHandler>(provider => new FilePublishHandler(
            provider.GetRequiredService<WorkerLoopbackClient>(), ObjectTransfer(provider, configuration), provider.GetRequiredService<IOptions<WorkerOptions>>(),
            provider.GetRequiredService<TimeProvider>(), provider.GetService<ILogger<FilePublishHandler>>()));
        services.AddSingleton<IWorkerJobHandler>(provider => new DocumentImportHandler(
            provider.GetRequiredService<WorkerLoopbackClient>(), ObjectTransfer(provider, configuration), CollabClient(provider, configuration), provider.GetRequiredService<IOptions<WorkerOptions>>()));
        services.AddSingleton<IWorkerJobHandler>(provider => new TemplateImportHandler(
            provider.GetRequiredService<WorkerLoopbackClient>(), ObjectTransfer(provider, configuration), CollabClient(provider, configuration), provider.GetRequiredService<IOptions<WorkerOptions>>()));
        services.AddSingleton<IInterruptedJobCleanup, InterruptedImportCleanup>();
        services.AddSingleton<IHostedService, SpoolSweeper>();

        services.AddSingleton<IHostedService, InterruptedJobSweep>();
        foreach (var family in JobFamilies.All)
        {
            services.AddSingleton<IHostedService>(provider =>
            {
                var options = provider.GetRequiredService<IOptions<WorkerOptions>>();
                return provider.GetRequiredService<InProcessJobQueue>().HostedFamilies.Contains(family)
                    ? new WorkerJobHost(
                        family,
                        provider.GetRequiredService<InProcessJobQueue>(),
                        provider.GetRequiredService<IWorkerDispatchStore>(),
                        provider.GetServices<IWorkerJobHandler>(),
                        options,
                        provider.GetRequiredService<TimeProvider>(),
                        provider.GetService<ILogger<WorkerJobHost>>())
                    : new IdleHost();
            });
        }
        return services;
    }

    private static Nix.Workers.Transfer.ObjectTransfer ObjectTransfer(IServiceProvider provider, IConfiguration configuration)
    {
        var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient(ObjectTransferHttpClientName);
        client.Timeout = TimeSpan.FromSeconds(provider.GetRequiredService<IOptions<WorkerOptions>>().Value.RequestTimeoutSeconds);
        return new Nix.Workers.Transfer.ObjectTransfer(client, [configuration["Nix:ObjectStorage:Endpoint"] ?? string.Empty, configuration["Nix:ObjectStorage:PublicOrigin"] ?? string.Empty]);
    }

    private static CollabImportClient CollabClient(IServiceProvider provider, IConfiguration configuration)
    {
        var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient(ObjectTransferHttpClientName);
        client.Timeout = Timeout.InfiniteTimeSpan;
        return new CollabImportClient(client, new Uri(configuration["Nix:Collaboration:BaseUrl"] ?? "http://localhost:8100", UriKind.Absolute),
            configuration["Nix:InternalSecret"] ?? string.Empty, provider.GetRequiredService<IOptions<WorkerOptions>>());
    }

    /// <summary>A family not hosted here; its kinds keep going to the external worker.</summary>
    private sealed class IdleHost : IHostedService
    {
        public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
