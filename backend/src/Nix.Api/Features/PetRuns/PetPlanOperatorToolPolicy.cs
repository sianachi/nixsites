namespace Nix.Features.PetRuns;

internal static class PetPlanOperatorToolPolicy
{
    internal static bool IsDecisionTool(string tool)
    {
        var normalized = "_" + tool.Replace('-', '_').Replace('.', '_');
        return normalized.EndsWith("_pet_plans", StringComparison.OrdinalIgnoreCase)
            || normalized.Contains("_pet_plan_", StringComparison.OrdinalIgnoreCase)
            || normalized.EndsWith("_pet_sharing", StringComparison.OrdinalIgnoreCase)
            || normalized.Contains("_pet_sharing_", StringComparison.OrdinalIgnoreCase);
    }
}
