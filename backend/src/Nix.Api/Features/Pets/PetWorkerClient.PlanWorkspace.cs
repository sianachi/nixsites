using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Nix.Domain.Primitives;

namespace Nix.Features.Pets;

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(JsonObject))]
internal sealed partial class PetWorkspacePlanRpcJsonContext : JsonSerializerContext;

public sealed partial class PetWorkerClient
{
    internal Task<Result<JsonElement>> WorkspacePlanRpcAsync(JsonObject request, CancellationToken cancellationToken) =>
        PrivatePlanRpcAsync("/v1/sani/pet-workspace-plan", request, cancellationToken);

    internal Task<Result<JsonElement>> PlanToolsRpcAsync(JsonObject request, CancellationToken cancellationToken) =>
        PrivatePlanRpcAsync("/v1/companion", request, cancellationToken);

    private async Task<Result<JsonElement>> PrivatePlanRpcAsync(string path, JsonObject request, CancellationToken cancellationToken)
    {
        var address = configuration["Nix:Pets:WorkerUrl"];
        var secret = configuration["Nix:InternalSecret"];
        if (string.IsNullOrWhiteSpace(secret) || !Uri.TryCreate(address, UriKind.Absolute, out var origin)
            || origin.Scheme is not ("http" or "https") || origin.UserInfo.Length != 0 || origin.Query.Length != 0
            || origin.Fragment.Length != 0 || origin.AbsolutePath != "/")
        {
            return Result.Failure<JsonElement>(new("pet_plans.unavailable", "The trusted companion adapter is unavailable."));
        }
        using var outgoing = new HttpRequestMessage(HttpMethod.Post, new Uri(origin, path));
        outgoing.Headers.Add("X-Nix-Internal-Secret", secret);
        outgoing.Content = JsonContent.Create(request, PetWorkspacePlanRpcJsonContext.Default.JsonObject);
        try
        {
            using var response = await http.SendAsync(outgoing, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode || response.Content.Headers.ContentType?.MediaType != "application/json")
            {
                return Result.Failure<JsonElement>(new("pet_plans.adapter_refused", "The trusted companion adapter refused this request."));
            }
            var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            var bounded = new CappedStream(stream, 1_100_000);
            await using var boundedLease = bounded.ConfigureAwait(false);
            using var json = await JsonDocument.ParseAsync(bounded,
                new JsonDocumentOptions { MaxDepth = 64, AllowDuplicateProperties = false }, cancellationToken).ConfigureAwait(false);
            if (json.RootElement.ValueKind != JsonValueKind.Object)
            {
                return Result.Failure<JsonElement>(new("pet_plans.adapter_invalid", "The companion returned an invalid plan result."));
            }
            return Result.Success(json.RootElement.Clone());
        }
        catch (Exception error) when (error is HttpRequestException or IOException or JsonException or StreamCapExceededException)
        {
            return Result.Failure<JsonElement>(new("pet_plans.adapter_unavailable", "The plan adapter could not confirm its result. Inspect Nix before retrying a write."));
        }
    }
}
