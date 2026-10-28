namespace Nix.Persistence.ObjectStorage;

/// <summary>
/// Issues object capabilities on the sites bucket: the same signing as <see cref="S3CapabilitySigner"/>
/// with the bucket overridden.
/// </summary>
/// <remarks>
/// A separate bucket lets the serving process hold a read-only credential scoped to it, because
/// R2 and Versity scope by bucket and not by prefix (ADR-0063). Only the operations the sites
/// workers need are exposed: sites objects are written and deleted through Core and never read
/// through it, except a host manifest a worker reads before deleting it.
/// </remarks>
public sealed class SiteCapabilitySigner(
    S3CapabilitySigner signer,
    S3CapabilitySigner? hostSigner = null)
{
    /// <summary>The longest a host-manifest capability lives, whatever the store's default.</summary>
    public const int HostManifestCapabilitySeconds = 300;

    private readonly S3CapabilitySigner _signer = signer;
    private readonly S3CapabilitySigner _hostSigner = hostSigner ?? signer;

    /// <summary>Whether the object store and the sites bucket are both configured.</summary>
    public bool IsConfigured => _signer.IsConfigured;

    /// <summary>
    /// Builds the signer for <paramref name="bucket"/> from the main object store configuration.
    /// An absent store or an empty bucket yields a signer that reports itself unconfigured.
    /// </summary>
    /// <param name="storage">The private object store configuration.</param>
    /// <param name="bucket">The sites bucket.</param>
    /// <param name="clock">Dates the capabilities.</param>
    /// <returns>The sites signer.</returns>
    public static SiteCapabilitySigner For(ObjectStorageOptions storage, string bucket, TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(storage);
        ArgumentNullException.ThrowIfNull(clock);
        return new SiteCapabilitySigner(
            new S3CapabilitySigner(Options(storage, bucket, storage.CapabilitySeconds), clock),
            new S3CapabilitySigner(Options(storage, bucket, Math.Min(storage.CapabilitySeconds, HostManifestCapabilitySeconds)), clock));
    }

    /// <summary>
    /// Signs a replacing write of a host manifest, verified by SHA-256, valid for at most five
    /// minutes: a leaked capability can re-point a hostname only briefly, and only at the exact
    /// bytes Core produced. The serving side refuses a manifest whose generation is lower than the
    /// one it holds.
    /// </summary>
    public ObjectCapability PutHostManifest(string key, long byteLength, string sha256) =>
        _hostSigner.PutVerified(key, byteLength, sha256);

    /// <summary>
    /// Signs a read of a host manifest, valid for at most five minutes: a delete is applied only to a
    /// manifest that still names the site being withdrawn.
    /// </summary>
    public ObjectCapability ReadHostManifest(string key) => _hostSigner.Get(key);

    /// <summary>Signs the delete of a host manifest, valid for at most five minutes.</summary>
    public ObjectCapability DeleteHostManifest(string key) => _hostSigner.Delete(key);

    private static ObjectStorageOptions Options(ObjectStorageOptions storage, string bucket, int capabilitySeconds) =>
        storage.Endpoint is null || string.IsNullOrWhiteSpace(bucket)
            ? new ObjectStorageOptions()
            : new ObjectStorageOptions
            {
                Endpoint = storage.Endpoint,
                PublicOrigin = storage.PublicOrigin,
                Region = storage.Region,
                Bucket = bucket,
                AccessKey = storage.AccessKey,
                SecretKey = storage.SecretKey,
                CapabilitySeconds = capabilitySeconds,
            };

    /// <summary>Signs a create-only upload that object storage verifies by SHA-256.</summary>
    public ObjectCapability PutImmutableVerified(string key, long byteLength, string sha256) =>
        _signer.PutImmutableVerified(key, byteLength, sha256);

    /// <summary>Signs a delete.</summary>
    public ObjectCapability Delete(string key) => _signer.Delete(key);
}
