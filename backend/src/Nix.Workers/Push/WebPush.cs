using System.Buffers.Binary;
using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nix.Workers.Push;

/// <summary>
/// The application-server halves of Web Push message encryption (RFC 8291) and self
/// identification (RFC 8292, VAPID). Nothing here touches the network.
/// </summary>
public static class WebPush
{
    /// <summary>The single aes128gcm record size a push message is encrypted with (RFC 8291 section 4).</summary>
    public const int RecordSize = 4096;

    /// <summary>The most plaintext that fits one record beside the padding delimiter and the 16-byte tag.</summary>
    public const int MaxPlaintextBytes = RecordSize - 1 - 16;

    /// <summary>How long a VAPID token stays valid, well inside the RFC 8292 24-hour ceiling.</summary>
    public static readonly TimeSpan VapidLifetime = TimeSpan.FromHours(12);

    private const int UncompressedP256PointSize = 65;
    private const int AuthSecretSize = 16;
    private const int SaltSize = 16;
    private static readonly byte[] KeyInfoPrefix = "WebPush: info\0"u8.ToArray();
    private static readonly byte[] ContentEncryptionKeyInfo = "Content-Encoding: aes128gcm\0"u8.ToArray();
    private static readonly byte[] NonceInfo = "Content-Encoding: nonce\0"u8.ToArray();

    /// <summary>
    /// Seals <paramref name="plaintext"/> for a subscription whose <c>p256dh</c> and <c>auth</c>
    /// values decode to <paramref name="subscriberPublicKey"/> and <paramref name="authSecret"/>.
    /// Returns the whole aes128gcm body: header, then the one encrypted record.
    /// </summary>
    public static byte[] Encrypt(ReadOnlySpan<byte> plaintext, byte[] subscriberPublicKey, byte[] authSecret)
    {
        using var local = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        return Encrypt(plaintext, subscriberPublicKey, authSecret, local, RandomNumberGenerator.GetBytes(SaltSize));
    }

    /// <summary>The deterministic core of <see cref="Encrypt(ReadOnlySpan{byte}, byte[], byte[])"/>, replayable against the RFC 8291 Appendix A vector.</summary>
    public static byte[] Encrypt(ReadOnlySpan<byte> plaintext, byte[] subscriberPublicKey, byte[] authSecret, ECDiffieHellman localPrivate, byte[] salt)
    {
        ArgumentNullException.ThrowIfNull(subscriberPublicKey);
        ArgumentNullException.ThrowIfNull(authSecret);
        ArgumentNullException.ThrowIfNull(localPrivate);
        ArgumentNullException.ThrowIfNull(salt);
        if (plaintext.Length > MaxPlaintextBytes)
        {
            throw new ArgumentException("push plaintext exceeds the single aes128gcm record", nameof(plaintext));
        }
        if (authSecret.Length != AuthSecretSize)
        {
            throw new ArgumentException("push subscription auth secret must be 16 bytes", nameof(authSecret));
        }
        if (subscriberPublicKey.Length != UncompressedP256PointSize || subscriberPublicKey[0] != 0x04)
        {
            throw new ArgumentException("push subscription public key must be an uncompressed P-256 point", nameof(subscriberPublicKey));
        }
        if (salt.Length != SaltSize)
        {
            throw new ArgumentException("push message salt must be 16 bytes", nameof(salt));
        }

        using var remote = ECDiffieHellman.Create(new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint { X = subscriberPublicKey[1..33], Y = subscriberPublicKey[33..65] },
        });
        var ecdhSecret = localPrivate.DeriveRawSecretAgreement(remote.PublicKey);
        var localPublic = UncompressedPoint(localPrivate.ExportParameters(false).Q);

        // PRK_key = HKDF-Extract(salt=auth_secret, IKM=ecdh_secret); IKM = HKDF-Expand(PRK_key, key_info, 32)
        var prkKey = HKDF.Extract(HashAlgorithmName.SHA256, ecdhSecret, authSecret);
        var keyInfo = new byte[KeyInfoPrefix.Length + subscriberPublicKey.Length + localPublic.Length]; // byte[]: HKDF.Expand takes the info as an array
        KeyInfoPrefix.CopyTo(keyInfo, 0);
        subscriberPublicKey.CopyTo(keyInfo, KeyInfoPrefix.Length);
        localPublic.CopyTo(keyInfo, KeyInfoPrefix.Length + subscriberPublicKey.Length);
        var ikm = HKDF.Expand(HashAlgorithmName.SHA256, prkKey, 32, keyInfo);

        // RFC 8188 key derivation.
        var prk = HKDF.Extract(HashAlgorithmName.SHA256, ikm, salt);
        var cek = HKDF.Expand(HashAlgorithmName.SHA256, prk, 16, ContentEncryptionKeyInfo);
        var nonce = HKDF.Expand(HashAlgorithmName.SHA256, prk, 12, NonceInfo);

        var padded = new byte[plaintext.Length + 1]; // byte[]: AesGcm.Encrypt takes arrays
        plaintext.CopyTo(padded);
        padded[^1] = 0x02;
        var ciphertext = new byte[padded.Length]; // byte[]: AesGcm.Encrypt output array
        var tag = new byte[16]; // byte[]: AesGcm.Encrypt tag array
        using (var gcm = new AesGcm(cek, tag.Length))
        {
            gcm.Encrypt(nonce, padded, ciphertext, tag);
        }

        var body = new byte[SaltSize + 4 + 1 + localPublic.Length + ciphertext.Length + tag.Length]; // byte[]: the push body HttpContent sends
        var offset = 0;
        salt.CopyTo(body, offset);
        offset += SaltSize;
        BinaryPrimitives.WriteUInt32BigEndian(body.AsSpan(offset, 4), RecordSize);
        offset += 4;
        body[offset++] = (byte)localPublic.Length;
        localPublic.CopyTo(body, offset);
        offset += localPublic.Length;
        ciphertext.CopyTo(body, offset);
        offset += ciphertext.Length;
        tag.CopyTo(body, offset);
        return body;
    }

    /// <summary>Parses the raw 32-byte P-256 scalar <c>Nix:Push:VapidPrivateKey</c> is delivered as, base64url without padding.</summary>
    public static ECDsa ParseVapidPrivateKey(string encoded)
    {
        ArgumentNullException.ThrowIfNull(encoded);
        byte[] raw;
        try
        {
            raw = Base64UrlDecode(encoded);
        }
        catch (FormatException exception)
        {
            throw new ArgumentException("VAPID private key is not base64url", nameof(encoded), exception);
        }
        if (raw.Length != 32)
        {
            throw new ArgumentException("VAPID private key must be 32 raw bytes", nameof(encoded));
        }
        return ECDsa.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, D = raw });
    }

    /// <summary>
    /// The RFC 8292 <c>vapid</c> Authorization header for a push request to <paramref name="endpoint"/>,
    /// signed ES256 with <paramref name="privateKey"/>, self-identifying as <paramref name="subject"/>.
    /// </summary>
    public static string VapidAuthorization(ECDsa privateKey, string endpoint, string subject, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(privateKey);
        var audience = PushOrigin(endpoint);
        var claims = JsonSerializer.SerializeToUtf8Bytes(
            new VapidClaims(audience, (now + VapidLifetime).ToUnixTimeSeconds(), subject),
            WebPushJsonContext.Default.VapidClaims);
        var signingInput = Base64UrlEncode("{\"typ\":\"JWT\",\"alg\":\"ES256\"}"u8) + "." + Base64UrlEncode(claims);
        var signature = privateKey.SignData(
            Encoding.ASCII.GetBytes(signingInput),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        var publicKey = UncompressedPoint(privateKey.ExportParameters(false).Q);
        return $"vapid t={signingInput}.{Base64UrlEncode(signature)}, k={Base64UrlEncode(publicKey)}";
    }

    /// <summary>Decodes base64url with or without padding, as subscriptions send their keys.</summary>
    public static byte[] Base64UrlDecode(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        return Base64Url.DecodeFromChars(value.TrimEnd('='));
    }

    private static string Base64UrlEncode(ReadOnlySpan<byte> bytes) => Base64Url.EncodeToString(bytes);

    private static byte[] UncompressedPoint(ECPoint point)
    {
        var bytes = new byte[UncompressedP256PointSize]; // byte[]: ECPoint coordinates are arrays
        bytes[0] = 0x04;
        point.X!.CopyTo(bytes, 1 + (32 - point.X.Length));
        point.Y!.CopyTo(bytes, 33 + (32 - point.Y.Length));
        return bytes;
    }

    // RFC 8292 section 2: the "aud" claim is the push resource's origin, scheme and host only, https only.
    private static string PushOrigin(string endpoint)
    {
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var parsed)
            || parsed.Scheme != Uri.UriSchemeHttps
            || string.IsNullOrEmpty(parsed.Host)
            || !string.IsNullOrEmpty(parsed.UserInfo))
        {
            throw new ArgumentException("push endpoint is not a valid HTTPS URL", nameof(endpoint));
        }
        return parsed.IsDefaultPort ? $"https://{parsed.Host}" : $"https://{parsed.Host}:{parsed.Port}";
    }
}
