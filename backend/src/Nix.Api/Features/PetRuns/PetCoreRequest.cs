using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing.Patterns;
using Nix.Authentication;
using Nix.Domain.Primitives;

namespace Nix.Features.PetRuns;

internal sealed record PetCoreRequest(
    PetCapabilityDefinition Definition,
    string Target,
    string? Body,
    IReadOnlyList<KeyValuePair<string, string>> References,
    PetTurnMode TurnMode)
{
    internal static PetCoreRequest Parse(JsonElement args, EndpointDataSource endpoints)
    {
        var fields = Object(args);
        var id = String(fields.GetValueOrDefault("operationId"));
        var definition = PetCapabilities.Find(id);
        if (definition?.Method is null || definition.Path is null || definition.Mode is "human" or "internal")
        {
            throw new InvalidPetActionException("That action is unavailable to a pet.");
        }
        if (definition.Mode != "read" && definition.Executor != "nix.action")
        {
            throw new InvalidPetActionException("This action has no verified revision for its complete effect. Choose an available pet action or make the change in Nix.");
        }
        if (fields.Keys.Any(key => key is not ("operationId" or "path" or "query" or "body")))
        {
            throw new InvalidPetActionException("Use operationId, path, query and body to describe a Nix action.");
        }

        var endpoint = endpoints.Endpoints.OfType<RouteEndpoint>().SingleOrDefault(candidate =>
            string.Equals(candidate.Metadata.GetMetadata<IEndpointNameMetadata>()?.EndpointName, id, StringComparison.Ordinal));
        if (endpoint is null || !string.Equals(PlainPath(endpoint.RoutePattern), definition.Path, StringComparison.Ordinal)
            || endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods.Contains(definition.Method, StringComparer.Ordinal) != true)
        {
            throw new InvalidPetActionException("The deployed action does not match its reviewed capability.");
        }

        var path = Object(fields.GetValueOrDefault("path"));
        if (endpoint.RoutePattern.Parameters.Count != path.Count)
        {
            throw new InvalidPetActionException("Supply exactly the named path parameters for the action.");
        }
        var target = definition.Path;
        var references = new List<KeyValuePair<string, string>>();
        foreach (var parameter in endpoint.RoutePattern.Parameters)
        {
            var value = String(path.GetValueOrDefault(parameter.Name));
            if (value.Length > 200 || value is "." or ".." || value.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or '_' or ':')))
            {
                throw new InvalidPetActionException("An action path parameter is invalid.");
            }
            target = target.Replace("{" + parameter.Name + "}", value, StringComparison.Ordinal);
            references.Add(new(parameter.Name, value));
        }
        var request = new DefaultHttpContext().Request;
        request.Method = definition.Method;
        request.Path = target;
        var scope = AccessTokenScopePolicy.Classify(request.Method, request.Path);
        if (PetTurnPolicy.IsHumanOnly(request) || scope == AccessTokenScopePolicy.Requirement.InteractiveOnly
            || definition.Mode == "read" && scope != AccessTokenScopePolicy.Requirement.Read)
        {
            throw new InvalidPetActionException("The action requires a person or changed scope.");
        }

        var queryParts = new List<KeyValuePair<string, string?>>();
        var queryNames = QueryNames(endpoint, path);
        foreach (var field in Object(fields.GetValueOrDefault("query")).OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            if (!queryNames.Contains(field.Key))
            {
                throw new InvalidPetActionException("An action query parameter is not part of the current API operation.");
            }
            foreach (var value in Values(field.Value))
            {
                var scalar = Scalar(value);
                queryParts.Add(new(field.Key, scalar));
                references.Add(new(field.Key, scalar));
            }
        }
        var query = QueryString.Create(queryParts);
        if (query.ToUriComponent().Length > 8_192)
        {
            throw new InvalidPetActionException("The action query is too large.");
        }
        var body = fields.GetValueOrDefault("body");
        string? bodyText = null;
        if (body.ValueKind != JsonValueKind.Undefined)
        {
            if (definition.Method == HttpMethods.Get || definition.Method == HttpMethods.Delete)
            {
                throw new InvalidPetActionException("This action does not accept a body.");
            }
            var fieldsInBody = Object(body);
            var bodyType = endpoint.Metadata.GetMetadata<IAcceptsMetadata>()?.RequestType;
            if (bodyType is null || !fieldsInBody.Keys.All(BodyNames(bodyType).Contains))
            {
                throw new InvalidPetActionException("An action body parameter is not part of the current API operation.");
            }
            if (id == "AddComment" && fieldsInBody.GetValueOrDefault("anchor").ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null))
            {
                throw new InvalidPetActionException("A pet can add a task comment without anchoring it to an unreviewed note revision.");
            }
            bodyText = body.GetRawText();
            if (Encoding.UTF8.GetByteCount(bodyText) > PetActionRequestBinding.MaximumBodyBytes)
            {
                throw new InvalidPetActionException("The action body is too large.");
            }
            Collect(body, references, null);
        }
        if (references.Count > 4096)
        {
            throw new InvalidPetActionException("The action contains too many parameters.");
        }

        return new(definition, target + query.ToUriComponent(), bodyText, references, scope switch
        {
            AccessTokenScopePolicy.Requirement.Read => PetTurnMode.Read,
            AccessTokenScopePolicy.Requirement.Admin => PetTurnMode.Admin,
            _ => PetTurnMode.Write,
        });
    }

    private static HashSet<string> QueryNames(RouteEndpoint endpoint, Dictionary<string, JsonElement> path)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var parameter in endpoint.Metadata.GetOrderedMetadata<IParameterBindingMetadata>())
        {
            var attributes = parameter.ParameterInfo.GetCustomAttributes(inherit: true);
            var query = attributes.OfType<IFromQueryMetadata>().FirstOrDefault();
            if (query is not null)
            {
                names.Add(query.Name ?? parameter.Name);
            }
            else if (attributes.All(attribute => attribute is not (IFromServiceMetadata or IFromBodyMetadata or IFromHeaderMetadata))
                && (parameter.HasTryParse || parameter.ParameterInfo.ParameterType == typeof(string))
                && !path.ContainsKey(parameter.Name))
            {
                names.Add(parameter.Name);
            }
        }
        return names;
    }

    private static HashSet<string> BodyNames(Type type) => type.GetProperties(BindingFlags.Instance | BindingFlags.Public)
        .Where(property => property.GetCustomAttribute<JsonIgnoreAttribute>()?.Condition != JsonIgnoreCondition.Always)
        .Select(property => property.GetCustomAttribute<JsonPropertyNameAttribute>()?.Name
            ?? JsonNamingPolicy.CamelCase.ConvertName(property.Name))
        .ToHashSet(StringComparer.Ordinal);

    // ASP.NET route constraints are enforced by routing, and are omitted by OpenAPI.
    private static string PlainPath(RoutePattern pattern) => "/" + string.Join('/', pattern.PathSegments.Select(segment =>
        string.Concat(segment.Parts.Select(part => part switch
        {
            RoutePatternLiteralPart literal => literal.Content,
            RoutePatternParameterPart parameter => "{" + parameter.Name + "}",
            RoutePatternSeparatorPart separator => separator.Content,
            _ => string.Empty,
        }))));

    private static Dictionary<string, JsonElement> Object(JsonElement value)
    {
        var fields = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        if (value.ValueKind == JsonValueKind.Undefined)
        {
            return fields;
        }
        if (value.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidPetActionException("Action parameters must be an object.");
        }
        foreach (var field in value.EnumerateObject())
        {
            if (!fields.TryAdd(field.Name, field.Value))
            {
                throw new InvalidPetActionException("The action contains a duplicate parameter.");
            }
        }
        return fields;
    }

    private static JsonElement[] Values(JsonElement value) =>
        value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().ToArray() : [value];

    private static string String(JsonElement value) =>
        value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()!
            : throw new InvalidPetActionException("The action requires a nonempty string.");

    private static string Scalar(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString()!,
        JsonValueKind.True or JsonValueKind.False or JsonValueKind.Number => value.GetRawText(),
        _ => throw new InvalidPetActionException("Action query values must be strings, numbers, or booleans."),
    };

    private static void Collect(JsonElement value, List<KeyValuePair<string, string>> refs, string? name)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var field in Object(value))
                {
                    Collect(field.Value, refs, field.Key);
                }
                break;
            case JsonValueKind.Array:
                foreach (var entry in value.EnumerateArray())
                {
                    Collect(entry, refs, name);
                }
                break;
            case JsonValueKind.String when name is not null:
                refs.Add(new(name, value.GetString()!));
                break;
        }
    }
}

internal sealed class InvalidPetActionException : Exception
{
    private readonly string _code = "pet_runs.invalid_action";
    public InvalidPetActionException() : this("The Nix action is invalid.") { }

    public InvalidPetActionException(string message) : base(message) { }

    internal InvalidPetActionException(string code, string message) : base(message) => _code = code;

    public InvalidPetActionException(string message, Exception innerException) : base(message, innerException) { }

    internal NixError Error => new(_code, Message);
}
