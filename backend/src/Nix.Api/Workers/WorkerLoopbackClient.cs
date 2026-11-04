using System.Net.Http.Headers;
using System.Net.Mime;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Options;
using Nix.Authentication;

namespace Nix.Workers;

/// <summary>
/// Calls this process's own <c>/internal/worker-executions/*</c> routes the way the Go workers did,
/// so <see cref="WorkerExecutionMiddleware"/> stays the one place that turns a live lease into a
/// tenant-scoped unit of work. The base address is Kestrel's own, resolved once it is listening.
/// </summary>
public sealed class WorkerLoopbackClient(
    IHttpClientFactory clients,
    IServer server,
    IConfiguration configuration,
    IOptions<WorkerOptions> options)
{
    /// <summary>The named client; tests swap its primary handler for the test server's.</summary>
    public const string HttpClientName = "worker-loopback";

    private Uri? baseAddress;

    /// <summary>A strict JSON POST, with or without a body, bounded to <paramref name="responseLimit"/> bytes.</summary>
    public async Task<TResponse?> PostJsonAsync<TResponse>(
        WorkerExecution execution,
        string path,
        HttpContent? content,
        JsonTypeInfo<TResponse>? responseInfo,
        int responseLimit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(execution);
        using var request = NewRequest(HttpMethod.Post, execution, path);
        request.Content = content;
        return await SendAsync(request, responseInfo, responseLimit, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>A JSON request body for <see cref="PostJsonAsync{TResponse}"/>.</summary>
    public static HttpContent Json<T>(T body, JsonTypeInfo<T> info) =>
        JsonContent.Create(body, info, new MediaTypeHeaderValue(MediaTypeNames.Application.Json));

    /// <summary>A strict JSON GET bounded to <paramref name="responseLimit"/> bytes.</summary>
    public async Task<TResponse?> GetJsonAsync<TResponse>(
        WorkerExecution execution,
        string path,
        JsonTypeInfo<TResponse> responseInfo,
        int responseLimit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(execution);
        using var request = NewRequest(HttpMethod.Get, execution, path);
        return await SendAsync(request, responseInfo, responseLimit, cancellationToken).ConfigureAwait(false);
    }

    private HttpRequestMessage NewRequest(HttpMethod method, WorkerExecution execution, string path)
    {
        var request = new HttpRequestMessage(method, new Uri(BaseAddress, path));
        request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, configuration[InternalBoundaryMiddleware.SecretConfigurationKey]);
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.JobHeaderName, execution.Job.Id.ToString("D"));
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.ExecutionHeaderName, execution.ExecutionId);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(MediaTypeNames.Application.Json));
        return request;
    }

    private async Task<TResponse?> SendAsync<TResponse>(
        HttpRequestMessage request,
        JsonTypeInfo<TResponse>? responseInfo,
        int responseLimit,
        CancellationToken cancellationToken)
    {
        using var client = clients.CreateClient(HttpClientName);
        client.Timeout = TimeSpan.FromSeconds(Math.Max(1, options.Value.RequestTimeoutSeconds));
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new WorkerLoopbackException((int)response.StatusCode, request.RequestUri!.AbsolutePath, await ProblemCodeAsync(response, cancellationToken).ConfigureAwait(false), fromProblem: true);
        }
        if (responseInfo is null)
        {
            return default;
        }
        var mediaType = response.Content.Headers.ContentType?.MediaType;
        if (!string.Equals(mediaType, MediaTypeNames.Application.Json, StringComparison.OrdinalIgnoreCase))
        {
            throw new WorkerLoopbackException((int)response.StatusCode, request.RequestUri!.AbsolutePath, "the response is not JSON");
        }
        if (response.Content.Headers.ContentLength is > 0 and var length && length > responseLimit)
        {
            throw new WorkerLoopbackException((int)response.StatusCode, request.RequestUri!.AbsolutePath, "the response exceeds its size limit");
        }
        var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        await using (stream.ConfigureAwait(false))
        {
            var buffer = new byte[responseLimit + 1]; // byte[]: Utf8JsonReader needs the whole bounded body in one span
            var total = 0;
            while (total < buffer.Length)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(total), cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    break;
                }
                total += read;
            }
            if (total > responseLimit)
            {
                throw new WorkerLoopbackException((int)response.StatusCode, request.RequestUri!.AbsolutePath, "the response exceeds its size limit");
            }
            // Same strictness as the Go decoder: exactly one JSON value, no unknown members.
            var reader = new Utf8JsonReader(buffer.AsSpan(0, total), new JsonReaderOptions { MaxDepth = 32 });
            var value = JsonSerializer.Deserialize(ref reader, Strict(responseInfo))
                ?? throw new WorkerLoopbackException((int)response.StatusCode, request.RequestUri!.AbsolutePath, "the response is empty");
            if (reader.Read())
            {
                throw new WorkerLoopbackException((int)response.StatusCode, request.RequestUri!.AbsolutePath, "multiple JSON values are not allowed");
            }
            return value;
        }
    }

    // A 409's stable problem code tells a worker-lease refusal from a terminal domain conflict.
    private static async Task<string?> ProblemCodeAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.StatusCode != System.Net.HttpStatusCode.Conflict)
        {
            return null;
        }
        try
        {
            var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            await using (stream.ConfigureAwait(false))
            {
                var buffer = new byte[16 * 1024]; // byte[]: a bounded problem-details read
                var total = 0;
                while (total < buffer.Length)
                {
                    var read = await stream.ReadAsync(buffer.AsMemory(total), cancellationToken).ConfigureAwait(false);
                    if (read == 0)
                    {
                        break;
                    }
                    total += read;
                }
                using var document = JsonDocument.Parse(buffer.AsMemory(0, total));
                return document.RootElement.ValueKind == JsonValueKind.Object
                    && document.RootElement.TryGetProperty("code", out var code)
                    && code.ValueKind == JsonValueKind.String
                    ? code.GetString()
                    : null;
            }
        }
        catch (Exception exception) when (exception is JsonException or HttpRequestException or IOException)
        {
            return null;
        }
    }

    private static JsonTypeInfo<T> Strict<T>(JsonTypeInfo<T> info)
    {
        if (info.Options.UnmappedMemberHandling == System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow)
        {
            return info;
        }
        var options = new JsonSerializerOptions(info.Options) { UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow };
        return (JsonTypeInfo<T>)options.GetTypeInfo(typeof(T));
    }

    private Uri BaseAddress
    {
        get
        {
            if (baseAddress is { } known)
            {
                return known;
            }
            if (configuration["Nix:Workers:LoopbackUrl"] is { Length: > 0 } configured)
            {
                return baseAddress = new Uri(configured, UriKind.Absolute);
            }
            var listening = server.Features.Get<IServerAddressesFeature>()?.Addresses
                .Select(address => new Uri(address.Replace("://*", "://127.0.0.1", StringComparison.Ordinal)
                    .Replace("://+", "://127.0.0.1", StringComparison.Ordinal)
                    .Replace("://0.0.0.0", "://127.0.0.1", StringComparison.Ordinal)
                    .Replace("://[::]", "://127.0.0.1", StringComparison.Ordinal), UriKind.Absolute))
                .OrderBy(uri => uri.Scheme == Uri.UriSchemeHttp ? 0 : 1)
                .FirstOrDefault();
            return baseAddress = listening
                ?? throw new InvalidOperationException("The server is not listening yet; worker loopback calls need a bound address.");
        }
    }
}

/// <summary>A loopback call answered with a non-success status or an unreadable body.</summary>
public sealed class WorkerLoopbackException : Exception
{
    public WorkerLoopbackException(int status, string path)
        : base($"worker API {path} answered {status}")
    {
        Status = status;
        Path = path;
    }

    public WorkerLoopbackException(int status, string path, string reason)
        : base($"worker API {path} answered {status}: {reason}")
    {
        Status = status;
        Path = path;
    }

    public WorkerLoopbackException(int status, string path, string? code, bool fromProblem)
        : base($"worker API {path} answered {status}" + (code is null ? string.Empty : $" ({code})"))
    {
        Status = status;
        Path = path;
        Code = code;
        FromProblem = fromProblem;
    }

    public WorkerLoopbackException()
    {
        Path = string.Empty;
    }

    public WorkerLoopbackException(string message)
        : base(message)
    {
        Path = string.Empty;
    }

    public WorkerLoopbackException(string message, Exception innerException)
        : base(message, innerException)
    {
        Path = string.Empty;
    }

    public int Status { get; }

    public string Path { get; }

    /// <summary>The problem code of a 409 answer, when it carried one.</summary>
    public string? Code { get; }

    /// <summary>Whether the status came from an answered request (as opposed to an unreadable body).</summary>
    public bool FromProblem { get; }
}
