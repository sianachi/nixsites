using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Nix.Workers.Push;

namespace Nix.Tests.Workers;

public sealed class WebPushTests
{
    // RFC 8291 Appendix A: same plaintext, subscriber keys, application-server ephemeral key and
    // salt, so the body must match the RFC's bytes exactly. The Go worker's webpush_test.go
    // replayed the same vector, which is the parity claim for the crypto.
    [Fact]
    public void Encrypt_reproduces_the_rfc_8291_appendix_a_vector()
    {
        var plaintext = WebPush.Base64UrlDecode("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24");
        var uaPublic = WebPush.Base64UrlDecode("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        var authSecret = WebPush.Base64UrlDecode("BTBZMqHH6r4Tts7J_aSIgg");
        var asPrivate = WebPush.Base64UrlDecode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
        var salt = WebPush.Base64UrlDecode("DGv6ra1nlYgDCS1FRnbzlw");
        var expected = WebPush.Base64UrlDecode(
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
            + "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"
            + "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
        using var local = ECDiffieHellman.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, D = asPrivate });

        var body = WebPush.Encrypt(plaintext, uaPublic, authSecret, local, salt);

        Assert.Equal(expected, body);
    }

    [Fact]
    public void Encrypt_with_random_inputs_produces_a_single_record_with_the_header_layout()
    {
        using var subscriber = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var subscriberPublic = Uncompressed(subscriber.ExportParameters(false).Q);
        var auth = RandomNumberGenerator.GetBytes(16);
        var plaintext = "{\"title\":\"Reminder\",\"body\":\"Water the plants\",\"url\":\"/items/abc\",\"tag\":\"reminder:abc\"}"u8;

        var body = WebPush.Encrypt(plaintext, subscriberPublic, auth);

        Assert.Equal(16 + 4 + 1 + 65 + plaintext.Length + 1 + 16, body.Length);
        Assert.Equal(65, body[16 + 4]);
        Assert.Equal(WebPush.RecordSize, (body[16] << 24) | (body[17] << 16) | (body[18] << 8) | body[19]);
    }

    [Fact]
    public void Encrypt_rejects_oversized_plaintext_and_invalid_subscriber_keys()
    {
        using var subscriber = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var subscriberPublic = Uncompressed(subscriber.ExportParameters(false).Q);
        var auth = new byte[16];

        Assert.Throws<ArgumentException>(() => WebPush.Encrypt(new byte[WebPush.MaxPlaintextBytes + 1], subscriberPublic, auth));
        Assert.Throws<ArgumentException>(() => WebPush.Encrypt("hi"u8, new byte[65], auth));
        Assert.Throws<ArgumentException>(() => WebPush.Encrypt("hi"u8, subscriberPublic, new byte[15]));
    }

    [Fact]
    public void Vapid_authorization_verifies_with_the_advertised_key_and_carries_the_origin_audience()
    {
        using var key = WebPush.ParseVapidPrivateKey("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
        var now = new DateTimeOffset(2026, 11, 4, 12, 0, 0, TimeSpan.Zero);

        var header = WebPush.VapidAuthorization(key, "https://fcm.googleapis.com/fcm/send/abc?x=1", "mailto:ops@example.com", now);

        Assert.StartsWith("vapid t=", header, StringComparison.Ordinal);
        var parts = header["vapid ".Length..].Split(", ");
        var token = parts[0]["t=".Length..];
        var advertised = WebPush.Base64UrlDecode(parts[1]["k=".Length..]);
        Assert.Equal(65, advertised.Length);
        var segments = token.Split('.');
        Assert.Equal(3, segments.Length);
        using var claims = JsonDocument.Parse(WebPush.Base64UrlDecode(segments[1]));
        Assert.Equal("https://fcm.googleapis.com", claims.RootElement.GetProperty("aud").GetString());
        Assert.Equal((now + WebPush.VapidLifetime).ToUnixTimeSeconds(), claims.RootElement.GetProperty("exp").GetInt64());
        Assert.Equal("mailto:ops@example.com", claims.RootElement.GetProperty("sub").GetString());

        using var verifier = ECDsa.Create(new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint { X = advertised[1..33], Y = advertised[33..65] },
        });
        Assert.True(verifier.VerifyData(
            Encoding.ASCII.GetBytes(segments[0] + "." + segments[1]),
            WebPush.Base64UrlDecode(segments[2]),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
    }

    [Fact]
    public void Vapid_authorization_rejects_a_non_https_endpoint_and_a_wrong_sized_key()
    {
        using var key = WebPush.ParseVapidPrivateKey("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");

        Assert.Throws<ArgumentException>(() => WebPush.VapidAuthorization(key, "http://fcm.googleapis.com/x", "mailto:a@b", DateTimeOffset.UtcNow));
        Assert.Throws<ArgumentException>(() => WebPush.ParseVapidPrivateKey("AAAA"));
    }

    [Theory]
    [InlineData("https://fcm.googleapis.com/fcm/send/abc", true)]
    [InlineData("https://updates.push.services.mozilla.com/wpush/v2/abc", true)]
    [InlineData("https://web.push.apple.com/abc", true)]
    [InlineData("https://db5p.notify.windows.com/w/?token=abc", true)]
    [InlineData("https://notify.windows.com/w/", false)]
    [InlineData("https://evil.example.com/fcm.googleapis.com", false)]
    [InlineData("http://fcm.googleapis.com/fcm/send/abc", false)]
    [InlineData("https://user@fcm.googleapis.com/fcm/send/abc", false)]
    [InlineData("https://fcm.googleapis.com/fcm/send/abc#frag", false)]
    public void Push_transport_allows_only_the_known_push_service_origins(string endpoint, bool allowed) =>
        Assert.Equal(allowed, PushTransport.IsAllowedEndpoint(endpoint));

    [Fact]
    public void Base64url_decodes_with_and_without_padding()
    {
        Assert.Equal(new byte[] { 0xfb, 0xff }, WebPush.Base64UrlDecode("-_8"));
        Assert.Equal(new byte[] { 0xfb, 0xff }, WebPush.Base64UrlDecode("-_8="));
        Assert.Equal(16, WebPush.Base64UrlDecode("BTBZMqHH6r4Tts7J_aSIgg").Length);
    }

    private static byte[] Uncompressed(ECPoint point)
    {
        var bytes = new byte[65];
        bytes[0] = 0x04;
        point.X!.CopyTo(bytes, 1 + (32 - point.X.Length));
        point.Y!.CopyTo(bytes, 33 + (32 - point.Y.Length));
        return bytes;
    }
}
