using System.Net.Http.Headers;
using System.Net.Mime;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Microsoft.Extensions.Options;
using Nix.Authentication;

namespace Nix.Workers;

/// <summary>
/// Writes imported note bodies through Collab's import routes, carrying the internal secret and
/// the worker execution proof so Collab can ask Core who may write what. Redirects are refused
/// and responses bounded, as in the Go collaboration clients.
/// </summary>
public sealed class CollabImportClient(HttpClient client, Uri baseUrl, string internalSecret, IOptions<WorkerOptions> options)
{
    private const int ResponseLimit = 1 << 20;

    /// <summary>Document import bodies: <c>POST /internal/imports/{id}/bodies</c>.</summary>
    public Task WriteDocumentBodiesAsync<TBody>(WorkerExecution execution, Guid importId, TBody body, JsonTypeInfo<TBody> info, CancellationToken cancellationToken) =>
        SendAsync<TBody, object>(execution, $"/internal/imports/{importId:D}/bodies", body, info, null, cancellationToken);

    /// <summary>Template import bodies: <c>POST /internal/worker-executions/template-imports/{id}/bodies</c>, answering the written targets.</summary>
    public Task<TResponse?> WriteTemplateBodiesAsync<TBody, TResponse>(WorkerExecution execution, Guid importId, TBody body, JsonTypeInfo<TBody> info, JsonTypeInfo<TResponse> responseInfo, CancellationToken cancellationToken) =>
        SendAsync(execution, $"/internal/worker-executions/template-imports/{importId:D}/bodies", body, info, responseInfo, cancellationToken);

    private async Task<TResponse?> SendAsync<TBody, TResponse>(WorkerExecution execution, string path, TBody body, JsonTypeInfo<TBody> info, JsonTypeInfo<TResponse>? responseInfo, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(execution);
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(baseUrl, path));
        request.Content = JsonContent.Create(body, info, new MediaTypeHeaderValue(MediaTypeNames.Application.Json));
        request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, internalSecret);
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.JobHeaderName, execution.Job.Id.ToString("D"));
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.ExecutionHeaderName, execution.ExecutionId);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(MediaTypeNames.Application.Json));
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(Math.Max(1, options.Value.RequestTimeoutSeconds)));
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new WorkerLoopbackException((int)response.StatusCode, path, await ProblemCodeAsync(response, timeout.Token).ConfigureAwait(false), fromProblem: true);
        }
        if (responseInfo is null)
        {
            return default;
        }
        var bytes = await response.Content.ReadAsByteArrayAsync(timeout.Token).ConfigureAwait(false);
        if (bytes.Length > ResponseLimit)
        {
            throw new WorkerLoopbackException((int)response.StatusCode, path, "Collaboration response exceeds its byte limit");
        }
        return JsonSerializer.Deserialize(bytes, responseInfo);
    }

    private static async Task<string?> ProblemCodeAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.StatusCode != System.Net.HttpStatusCode.Conflict)
        {
            return null;
        }
        try
        {
            using var document = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false));
            return document.RootElement.TryGetProperty("code", out var code) && code.ValueKind == JsonValueKind.String ? code.GetString() : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
