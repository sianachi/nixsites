using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Features.BrowserAuth;

namespace Nix.Tests.Authentication;

public sealed class NativeHandoffCoordinatorTests
{
    private static readonly DateTimeOffset Start = new(2026, 11, 2, 12, 0, 0, TimeSpan.Zero);
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", true)]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", false)]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", false)]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", false)]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+", false)]
    [InlineData("-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-", true)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Challenges_are_exactly_43_base64url_characters(string? value, bool expected) =>
        Assert.Equal(expected, NativeHandoffCoordinator.IsChallenge(value));

    [Theory]
    [InlineData(42, false)]
    [InlineData(43, true)]
    [InlineData(128, true)]
    [InlineData(129, false)]
    public void Verifiers_are_43_to_128_characters(int length, bool expected) =>
        Assert.Equal(expected, NativeHandoffCoordinator.IsVerifier(new string('a', length)));

    [Fact]
    public async Task Only_a_hash_of_the_code_is_stored_and_redeem_works_once()
    {
        var (coordinator, store, _) = Create();
        var verifier = Verifier();
        var code = await coordinator.CreateAsync(Completion(), Challenge(verifier), Cancellation);

        Assert.NotNull(code);
        var key = Assert.Single(store.Rows).Key;
        Assert.Equal(BrowserSessionSecret.Hash(code), key);
        Assert.DoesNotContain(code, store.Rows[key].Payload, StringComparison.Ordinal);
        Assert.DoesNotContain("nixsession_", store.Rows[key].Payload, StringComparison.Ordinal);

        var redeemed = await coordinator.RedeemAsync(code, verifier, Cancellation);
        Assert.Equal(("nixsession_secret", Start.AddHours(8)), redeemed);
        Assert.Null(await coordinator.RedeemAsync(code, verifier, Cancellation));
    }

    [Fact]
    public async Task A_wrong_verifier_burns_the_code()
    {
        var (coordinator, _, _) = Create();
        var verifier = Verifier();
        var code = await coordinator.CreateAsync(Completion(), Challenge(verifier), Cancellation);

        Assert.Null(await coordinator.RedeemAsync(code, Verifier(), Cancellation));
        Assert.Null(await coordinator.RedeemAsync(code, verifier, Cancellation));
    }

    [Fact]
    public async Task Codes_expire_after_sixty_seconds()
    {
        var (coordinator, _, clock) = Create();
        var verifier = Verifier();
        var live = await coordinator.CreateAsync(Completion(), Challenge(verifier), Cancellation);
        var late = await coordinator.CreateAsync(Completion(), Challenge(verifier), Cancellation);

        clock.Now = Start.AddSeconds(59);
        Assert.NotNull(await coordinator.RedeemAsync(live, verifier, Cancellation));
        clock.Now = Start.AddSeconds(60);
        Assert.Null(await coordinator.RedeemAsync(late, verifier, Cancellation));
    }

    [Fact]
    public async Task Malformed_input_never_reaches_the_store()
    {
        var (coordinator, store, _) = Create();
        Assert.Null(await coordinator.RedeemAsync("short", Verifier(), Cancellation));
        Assert.Null(await coordinator.RedeemAsync(new string('a', 43), "short", Cancellation));
        Assert.Equal(0, store.Consumed);
    }

    private static string Verifier() => Base64UrlTextEncoder.Encode(RandomNumberGenerator.GetBytes(48));

    private static string Challenge(string verifier) =>
        Base64UrlTextEncoder.Encode(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));

    private static BrowserLoginCompletion Completion() =>
        new("nixsession_secret", Start.AddHours(8), "/", new AuthenticatedPrincipal(PrincipalId.Create(), TenantId.Create(), PrincipalStatus.Active, "Test"));

    private static (NativeHandoffCoordinator Coordinator, StoreFake Store, ClockFake Clock) Create()
    {
        var store = new StoreFake();
        var clock = new ClockFake { Now = Start };
        return (new NativeHandoffCoordinator(store, new EphemeralDataProtectionProvider(), clock), store, clock);
    }

    private sealed class ClockFake : TimeProvider
    {
        public DateTimeOffset Now { get; set; }

        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class StoreFake : INativeHandoffs
    {
        public Dictionary<string, NativeHandoffRecord> Rows { get; } = [];

        public int Consumed { get; private set; }

        public ValueTask<bool> CreateAsync(string codeHash, Guid principalId, string challenge, string payload, DateTimeOffset expiresAt, CancellationToken cancellationToken)
        {
            Rows[codeHash] = new NativeHandoffRecord(challenge, payload, expiresAt);
            return ValueTask.FromResult(true);
        }

        public ValueTask<NativeHandoffRecord?> ConsumeAsync(string codeHash, CancellationToken cancellationToken)
        {
            Consumed++;
            return ValueTask.FromResult(Rows.Remove(codeHash, out var row) ? row : null);
        }
    }
}
