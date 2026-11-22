namespace Nix.Abstractions;

/// <summary>An insert named an item identifier that is already in use, in any tenant.</summary>
public sealed class ItemIdTakenException : Exception
{
    public ItemIdTakenException()
    {
    }

    public ItemIdTakenException(string message) : base(message)
    {
    }

    public ItemIdTakenException(string message, Exception innerException) : base(message, innerException)
    {
    }

    public ItemIdTakenException(Exception innerException) : base("The item identifier is already in use.", innerException)
    {
    }
}
