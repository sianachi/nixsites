using Nix.Persistence.Identity;

namespace Nix.Features.LocalAuth;

/// <summary>Registers the local sign-in services this feature owns.</summary>
internal static class LocalAuthServiceCollectionExtensions
{
    internal static IServiceCollection AddLocalAuth(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<LocalAccountProvisioner>();
        services.AddScoped<LocalSecondStepGate>();
        services.AddSingleton<LocalSignInDecoy>();
        services.AddScoped<LocalPasswordSignIn>();
        services.AddScoped<LocalSignInCompleter>();
        services.AddScoped<LocalReauth>();
        services.AddScoped<LocalLinkIssuer>();
        services.AddScoped<LocalSecurityGuard>();
        services.AddScoped<LocalTotpSecondStep>();
        services.AddScoped<ILocalSecondStepMethod>(static sp => sp.GetRequiredService<LocalTotpSecondStep>());
        services.AddSingleton<Nix.Features.People.IPeopleStore, PeopleStore>();
        services.AddScoped<Nix.Features.People.PeopleService>();
        services.AddLocalPasskeys();
        return services;
    }
}
