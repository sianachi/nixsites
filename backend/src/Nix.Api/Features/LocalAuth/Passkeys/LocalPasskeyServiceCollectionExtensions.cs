namespace Nix.Features.LocalAuth;

/// <summary>Registers the passkey and security-key services.</summary>
internal static class LocalPasskeyServiceCollectionExtensions
{
    internal static IServiceCollection AddLocalPasskeys(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<LocalPasskeyCeremony>();
        services.AddScoped<ILocalSecondStepMethod, LocalSecurityKeySecondStep>();
        return services;
    }
}
