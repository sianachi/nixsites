using System.Reflection;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Nix.Authentication;
using Nix.Messaging;
using Nix.Persistence;
using Nix.Persistence.ObjectStorage;
using Nix.Workers;

namespace Nix.Tests.Composition;

/// <summary>
/// Guards the composition root that used to be checked by assembly-reference tests. The backend
/// collapsed from five projects to one, which made <c>DependencyDirectionTests</c> unexpressible -
/// there is nothing left to check assembly references between. <c>scripts/check-layering.sh</c>
/// took over the layering half at the source level; the tests here take over the other half, which
/// is specific to this codebase's registration style: <see cref="NixPersistenceServiceCollectionExtensions.AddNixPersistence(IServiceCollection, string)"/>
/// registers every handler by hand, one line at a time, with no assembly scanning. That is
/// deliberate - scanning would hide a missing registration behind reflection - but it means a
/// developer who adds a handler and forgets the registration line gets a runtime failure on the
/// first request that needs it, not a compile error. These tests turn that back into a build
/// failure by discovering every handler through reflection and proving the composition root
/// actually accounts for each one.
/// </summary>
public sealed class CompositionRootTests
{
    /// <summary>
    /// A connection string that parses and authenticates as the runtime role. Building the
    /// persistence stack does not open a connection - <c>NpgsqlDataSourceBuilder.Build()</c> and
    /// <c>DbContext</c> construction are both lazy - so this can point anywhere.
    /// </summary>
    private const string RuntimeConnectionString = "Host=localhost;Database=nix;Username=nix_app;Password=x";

    [Fact]
    public void Api_host_exposes_a_public_entry_point_for_test_hosting()
    {
        // The Program marker must stay public so WebApplicationFactory<Program>
        // can host the application in later goals.
        Assert.True(typeof(Program).IsPublic);
    }

    [Fact]
    public void Every_handler_in_the_assembly_has_a_registration()
    {
        var handlerTypes = DiscoverHandlerTypes();

        var services = new ServiceCollection();
        services.AddNixPersistence(RuntimeConnectionString);
        services.AddNixObjectStorage(new ConfigurationBuilder().Build());

        var registeredImplementationTypes = new HashSet<Type>(
            services.Select(descriptor => descriptor.ImplementationType).OfType<Type>());

        var missing = handlerTypes
            .Where(handlerType => !registeredImplementationTypes.Contains(handlerType))
            .Select(handlerType => handlerType.FullName)
            .ToList();

        Assert.True(
            missing.Count == 0,
            "The following handler type(s) implement ICommandHandler<,> or IQueryHandler<,> but " +
            "have no registration in NixPersistenceServiceCollectionExtensions.AddNixPersistence: " +
            string.Join(", ", missing) +
            ". Add the missing `services.AddScoped<I...Handler<...>, ...Handler>();` line.");
    }

    /// <summary>
    /// Resolves every registered handler from a real scope, which proves the constructor graph
    /// each handler declares is actually satisfiable - not merely that a type was named in a
    /// registration call. Safe without a live database: every dependency in the graph
    /// (<c>NixDbContext</c>, <c>NpgsqlDataSource</c>, the stores, the resolvers) defers I/O past
    /// construction, so this only exercises DI wiring.
    /// </summary>
    [Fact]
    public void Every_registered_handler_resolves_from_a_scope()
    {
        var services = new ServiceCollection();
        var configuration = new ConfigurationBuilder().Build();
        using var serverServices = new ServiceCollection().AddOptions().BuildServiceProvider();
        using var server = new TestServer(serverServices);
        services.AddNixPersistence(RuntimeConnectionString);
        services.AddNixObjectStorage(configuration);
        services.AddNixWorkers(configuration);
        services.AddRouting();
        services.AddSingleton<IServer>(server);
        services.AddSingleton<SelfIssuedTokenService>();

        var handlerServiceTypes = services
            .Select(descriptor => descriptor.ServiceType)
            .Where(IsHandlerInterface)
            .Distinct()
            .ToList();

        using var provider = services.BuildServiceProvider(validateScopes: true);
        using var scope = provider.CreateScope();

        foreach (var serviceType in handlerServiceTypes)
        {
            var handler = scope.ServiceProvider.GetRequiredService(serviceType);
            Assert.NotNull(handler);
        }
    }

    [Fact]
    public void Every_template_operation_has_a_resolvable_handler()
    {
        var templateHandlers = DiscoverHandlerTypes()
            .Where(type => string.Equals(
                type.Namespace,
                "Nix.Features.Templates",
                StringComparison.Ordinal))
            .ToHashSet();
        Assert.Equal(29, templateHandlers.Count);

        var services = new ServiceCollection();
        services.AddNixPersistence(RuntimeConnectionString);
        services.AddNixObjectStorage(new ConfigurationBuilder().Build());
        var handlerServices = services
            .Where(descriptor => descriptor.ImplementationType is { } implementation
                && templateHandlers.Contains(implementation))
            .Select(descriptor => descriptor.ServiceType)
            .ToArray();
        Assert.Equal(templateHandlers.Count, handlerServices.Length);

        using var provider = services.BuildServiceProvider(validateScopes: true);
        using var scope = provider.CreateScope();
        foreach (var serviceType in handlerServices)
        {
            Assert.NotNull(scope.ServiceProvider.GetRequiredService(serviceType));
        }
    }

    [Fact]
    public void Template_endpoints_depend_only_on_the_dispatcher()
    {
        var assembly = typeof(NixPersistenceServiceCollectionExtensions).Assembly;
        var endpointTypes = assembly.GetTypes()
            .Where(type => type is { Namespace: "Nix.Features.Templates", IsAbstract: true, IsSealed: true }
                && type.Name.EndsWith("Endpoints", StringComparison.Ordinal))
            .ToArray();
        var concreteStore = assembly.GetType("Nix.Persistence.Templates.TemplateStore");
        Assert.True(endpointTypes.Length >= 2, "Expected the public and internal template endpoint classes.");
        Assert.NotNull(concreteStore);
        var routeMethods = endpointTypes
            .SelectMany(type => type.GetMethods(BindingFlags.Static | BindingFlags.NonPublic))
            .Where(method => method.ReturnType == typeof(Task<IResult>))
            .ToArray();

        Assert.Equal(28, routeMethods.Length);
        Assert.All(routeMethods, method =>
        {
            var dependencies = method.GetParameters().Select(parameter => parameter.ParameterType).ToArray();
            Assert.Contains(typeof(NixDispatcher), dependencies);
            Assert.DoesNotContain(concreteStore, dependencies);
        });
    }

    private static List<Type> DiscoverHandlerTypes() =>
        typeof(NixPersistenceServiceCollectionExtensions).Assembly
            .GetTypes()
            .Where(type => type is { IsClass: true, IsAbstract: false })
            .Where(type => type.GetInterfaces().Any(IsHandlerInterface))
            .ToList();

    private static bool IsHandlerInterface(Type type) =>
        type.IsGenericType &&
        (type.GetGenericTypeDefinition() == typeof(ICommandHandler<,>) ||
            type.GetGenericTypeDefinition() == typeof(IQueryHandler<,>));
}
