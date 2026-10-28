using Nix.Domain.Primitives;

namespace Nix.Domain.Templates;

/// <summary>Stable expected failures for catalog and application work.</summary>
public static class TemplateErrors
{
    /// <summary>The template/workspace/item is absent or not visible.</summary>
    public static NixError NotFound(string message) => new("templates.not_found", message);

    /// <summary>A managed template cannot be changed in the workspace.</summary>
    public static NixError Managed(string message) => new("templates.managed", message);

    /// <summary>The caller is authenticated but is not the managed-template service identity.</summary>
    public static NixError Forbidden(string message) => new("templates.forbidden", message);

    /// <summary>The requested shape is malformed or uses unsupported vocabulary.</summary>
    public static NixError Invalid(string message) => new("templates.invalid", message);

    /// <summary>A stable key or in-progress operation conflicts.</summary>
    public static NixError Conflict(string message) => new("templates.conflict", message);

    /// <summary>Stable code for a capture that would copy a locked body into a template.</summary>
    public const string SourceLockedCode = "templates.source_locked";

    /// <summary>A capture that includes a locked item, whose body a template would carry unlocked.</summary>
    public static NixError SourceLocked() =>
        new(SourceLockedCode, "This item or something under it is locked. Remove the lock before saving it as a template.");

    /// <summary>Collab has not written exactly the bodies Core asked it to write.</summary>
    public static NixError BodiesIncomplete(string message) => new("templates.bodies_incomplete", message);
}
