using Nix.Persistence.ObjectStorage;
using Nix.Tests.Support;

namespace Nix.Tests.Persistence.ObjectStorage;

public sealed class S3CapabilitySignerTests
{
    private static readonly DateTimeOffset Instant = new(2026, 8, 31, 20, 15, 0, TimeSpan.Zero);

    [Fact]
    public void A_capability_is_method_key_and_expiry_bound()
    {
        var signer = Signer();

        var first = signer.Put("files/tenant/upload id").Url;
        var second = signer.Get("files/tenant/upload id").Url;

        Assert.Equal("/api/nix-objects/files/tenant/upload%20id", first.AbsolutePath);
        Assert.Contains("X-Amz-Expires=300", first.Query, StringComparison.Ordinal);
        Assert.Contains("X-Amz-Date=20260831T201500Z", first.Query, StringComparison.Ordinal);
        Assert.NotEqual(first.Query, second.Query);
        Assert.Equal(Instant.AddMinutes(5), signer.Put("files/tenant/upload id").ExpiresAt);
    }

    [Fact]
    public void Terminal_cleanup_waits_until_every_issued_capability_and_clock_skew_have_expired()
    {
        var signer = Signer();

        Assert.Equal(Instant.AddMinutes(6), signer.GetCleanupNotBefore());
    }

    [Fact]
    public void Escaped_endpoint_path_segments_are_not_double_encoded()
    {
        var options = Options();
        options.Endpoint = new Uri("https://objects.test/storage/team%20one");
        var signer = new S3CapabilitySigner(options, new FixedTimeProvider(Instant));

        var capability = signer.Get("files/object").Url;

        Assert.Equal("/storage/team%20one/nix-objects/files/object", capability.AbsolutePath);
        Assert.DoesNotContain("%2520", capability.AbsolutePath, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("storage%2Fteam", capability.AbsolutePath, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Capabilities_use_the_public_origin_and_keep_the_internal_endpoint_path()
    {
        var options = Options();
        options.Endpoint = new Uri("https://objects.internal.test/storage/team%20one");
        options.PublicOrigin = new Uri("https://objects.example.test:9443");
        var signer = new S3CapabilitySigner(options, new FixedTimeProvider(Instant));

        var capability = signer.Get("files/object").Url;

        Assert.Equal("https", capability.Scheme);
        Assert.Equal("objects.example.test", capability.Host);
        Assert.Equal(9443, capability.Port);
        Assert.Equal("/storage/team%20one/nix-objects/files/object", capability.AbsolutePath);

        options.PublicOrigin = new Uri("https://objects-alternate.example.test:9443");
        var alternate = new S3CapabilitySigner(options, new FixedTimeProvider(Instant))
            .Get("files/object")
            .Url;
        Assert.NotEqual(capability.Query, alternate.Query);
    }

    [Fact]
    public void A_loopback_http_public_origin_is_supported_for_development()
    {
        var options = Options();
        options.PublicOrigin = new Uri("http://127.0.0.1:7070");

        var capability = new S3CapabilitySigner(options, new FixedTimeProvider(Instant))
            .Put("files/object");

        Assert.Equal("http://127.0.0.1:7070", capability.Url.GetLeftPart(UriPartial.Authority));
    }

    public static TheoryData<Uri> UnsafePublicOrigins => new()
    {
        new Uri("relative", UriKind.Relative),
        new Uri("ftp://objects.example.test"),
        new Uri("http://objects.example.test"),
        new Uri("https://user@objects.example.test"),
        new Uri("https://objects.example.test/path"),
        new Uri("https://objects.example.test?mode=public"),
        new Uri("https://objects.example.test#public"),
    };

    [Theory]
    [MemberData(nameof(UnsafePublicOrigins))]
    public void Unsafe_public_origins_are_refused(Uri publicOrigin)
    {
        var options = Options();
        options.PublicOrigin = publicOrigin;

        Assert.Throws<InvalidOperationException>(() =>
            new S3CapabilitySigner(options, new FixedTimeProvider(Instant)));
    }

    [Fact]
    public void A_public_origin_without_an_internal_endpoint_is_refused()
    {
        var options = new ObjectStorageOptions
        {
            PublicOrigin = new Uri("https://objects.example.test"),
        };

        Assert.Throws<InvalidOperationException>(() =>
            new S3CapabilitySigner(options, new FixedTimeProvider(Instant)));
    }

    [Fact]
    public void Upload_capabilities_bind_size_and_immutable_creation_headers()
    {
        var sized = Signer().PutSized("files/upload", 42).Url;
        var immutable = Signer().PutImmutable("files/version", 42).Url;

        Assert.Contains("X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost", sized.Query, StringComparison.Ordinal);
        Assert.Contains(
            "X-Amz-SignedHeaders=content-length%3Bhost%3Bif-none-match",
            immutable.Query,
            StringComparison.Ordinal);
        Assert.NotEqual(sized.Query, immutable.Query);
    }

    [Fact]
    public void Verified_immutable_uploads_bind_the_storage_checksum_header()
    {
        var verified = Signer().PutImmutableVerified("exports/result", 42, new string('a', 64)).Url;

        Assert.Contains(
            "X-Amz-SignedHeaders=content-length%3Bhost%3Bif-none-match%3Bx-amz-checksum-sha256",
            verified.Query,
            StringComparison.Ordinal);
    }

    [Fact]
    public void Verified_replacing_uploads_bind_the_checksum_but_not_create_only()
    {
        var verified = Signer().PutVerified("sites/_hosts/docs.example.test.json", 42, new string('a', 64)).Url;

        Assert.Contains(
            "X-Amz-SignedHeaders=content-length%3Bhost%3Bx-amz-checksum-sha256",
            verified.Query,
            StringComparison.Ordinal);
        Assert.DoesNotContain("if-none-match", verified.Query, StringComparison.Ordinal);
        Assert.Throws<ArgumentException>(() => Signer().PutVerified("sites/_hosts/x.json", 42, "not-a-digest"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("/absolute")]
    [InlineData("files//object")]
    [InlineData("files/../object")]
    [InlineData("files\\object")]
    public void Unsafe_object_keys_are_refused(string key)
    {
        Assert.Throws<ArgumentException>(() => Signer().Get(key));
    }

    [Fact]
    public void Plain_http_is_limited_to_loopback_development()
    {
        var options = Options();
        options.Endpoint = new Uri("http://objects.internal:9000");

        Assert.Throws<InvalidOperationException>(() =>
            new S3CapabilitySigner(options, new FixedTimeProvider(Instant)));
    }

    [Fact]
    public void A_completely_absent_configuration_is_disabled_without_breaking_the_host()
    {
        var signer = new S3CapabilitySigner(new ObjectStorageOptions(), new FixedTimeProvider(Instant));

        Assert.False(signer.IsConfigured);
        Assert.Throws<InvalidOperationException>(() => signer.Get("files/object"));
    }

    private static S3CapabilitySigner Signer() =>
        new(Options(), new FixedTimeProvider(Instant));

    private static ObjectStorageOptions Options() => new()
    {
        Endpoint = new Uri("https://objects.test/api"),
        Region = "eu-west-2",
        Bucket = "nix-objects",
        AccessKey = "access",
        SecretKey = "secret",
        CapabilitySeconds = 300,
    };
}
