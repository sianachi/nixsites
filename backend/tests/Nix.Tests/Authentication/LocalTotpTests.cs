using System.Text;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Features.LocalAuth;

namespace Nix.Tests.Authentication;

/// <summary>RFC 6238 vectors plus the second-step rules: window, single use, attempt limit and account pause.</summary>
public sealed class LocalTotpTests
{
    private static readonly byte[] Rfc = Encoding.ASCII.GetBytes("12345678901234567890");
    private static readonly DateTimeOffset Now = DateTimeOffset.FromUnixTimeSeconds(1_111_111_109);

    [Theory]
    [InlineData(59L, "287082")]
    [InlineData(1_111_111_109L, "081804")]
    [InlineData(1_111_111_111L, "050471")]
    [InlineData(1_234_567_890L, "005924")]
    [InlineData(2_000_000_000L, "279037")]
    [InlineData(20_000_000_000L, "353130")]
    public void Codes_match_the_RFC_6238_vectors(long seconds, string expected) =>
        Assert.Equal(expected, LocalTotp.Code(Rfc, seconds / 30));

    [Fact]
    public void One_step_either_side_is_accepted_and_two_are_not()
    {
        var step = LocalTotp.StepAt(Now);
        Assert.Equal(step - 1, LocalTotp.Match(Rfc, LocalTotp.Code(Rfc, step - 1), Now));
        Assert.Equal(step, LocalTotp.Match(Rfc, LocalTotp.Code(Rfc, step), Now));
        Assert.Equal(step + 1, LocalTotp.Match(Rfc, LocalTotp.Code(Rfc, step + 1), Now));
        Assert.Null(LocalTotp.Match(Rfc, LocalTotp.Code(Rfc, step + 2), Now));
        Assert.Null(LocalTotp.Match(Rfc, LocalTotp.Code(Rfc, step - 2), Now));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("12345")]
    [InlineData("1234567")]
    [InlineData("12a456")]
    public void Malformed_codes_never_match(string? code) => Assert.Null(LocalTotp.Match(Rfc, code, Now));

    [Fact]
    public void A_code_typed_with_a_space_in_it_still_matches()
    {
        var code = LocalTotp.Code(Rfc, LocalTotp.StepAt(Now));
        Assert.NotNull(LocalTotp.Match(Rfc, code.Insert(3, " "), Now));
    }

    [Fact]
    public void Base32_and_the_otpauth_link_follow_RFC_4648_and_the_key_URI_format()
    {
        Assert.Equal("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", LocalTotp.ToBase32(Rfc));
        var uri = LocalTotp.OtpAuthLink("ada@example.com", Rfc);
        Assert.StartsWith("otpauth://totp/Nix:ada%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Nix", uri, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_right_code_signs_in_and_uses_the_challenge_up()
    {
        var w = new World();
        var outcome = await w.Subject.CheckAsync(w.ChallengeId, World.CodeNow(), CancellationToken.None);

        Assert.Equal(TotpAttemptKind.Accepted, outcome.Kind);
        Assert.Equal(w.Principal, outcome.PrincipalId);
        Assert.Equal("/home", outcome.ReturnTo);
        Assert.True(w.Challenges.Taken);
        Assert.Equal(0, w.Accounts.Failures);
    }

    [Fact]
    public async Task The_same_step_cannot_be_used_twice_and_the_replay_counts_as_a_failure()
    {
        var w = new World();
        var code = World.CodeNow();
        Assert.Equal(TotpAttemptKind.Accepted, (await w.Subject.CheckAsync(w.ChallengeId, code, CancellationToken.None)).Kind);

        w.Challenges.Taken = false;
        var replay = await w.Subject.CheckAsync(w.ChallengeId, code, CancellationToken.None);

        Assert.Equal(TotpAttemptKind.Invalid, replay.Kind);
        Assert.False(w.Challenges.Taken);
        Assert.Equal(1, w.Accounts.Failures);
        Assert.Equal(1, w.Challenges.Attempts);
    }

    [Fact]
    public async Task A_wrong_code_bumps_the_challenge_and_the_account_failure_count()
    {
        var w = new World();
        var outcome = await w.Subject.CheckAsync(w.ChallengeId, "000000", CancellationToken.None);

        Assert.Equal(TotpAttemptKind.Invalid, outcome.Kind);
        Assert.Equal(1, w.Accounts.Failures);
        Assert.Equal(1, w.Challenges.Attempts);
        Assert.False(w.Challenges.Taken);
    }

    [Fact]
    public async Task The_tenth_failure_pauses_and_a_paused_account_refuses_even_the_right_code()
    {
        var w = new World { PauseOnFailure = 1 };
        var paused = await w.Subject.CheckAsync(w.ChallengeId, "000000", CancellationToken.None);
        Assert.Equal(TotpAttemptKind.Paused, paused.Kind);

        var right = await w.Subject.CheckAsync(w.ChallengeId, World.CodeNow(), CancellationToken.None);
        Assert.Equal(TotpAttemptKind.Paused, right.Kind);
        Assert.False(w.Challenges.Taken);
    }

    [Fact]
    public async Task An_unconfirmed_secret_never_answers_a_second_step()
    {
        var w = new World { Confirmed = false };
        var outcome = await w.Subject.CheckAsync(w.ChallengeId, World.CodeNow(), CancellationToken.None);
        Assert.Equal(TotpAttemptKind.Invalid, outcome.Kind);
    }

    [Fact]
    public async Task An_unknown_challenge_is_invalid()
    {
        var w = new World();
        var outcome = await w.Subject.CheckAsync(Guid.NewGuid(), World.CodeNow(), CancellationToken.None);
        Assert.Equal(TotpAttemptKind.Invalid, outcome.Kind);
    }

    private sealed class World
    {
        public PrincipalId Principal { get; } = PrincipalId.From(Guid.NewGuid());

        public Guid ChallengeId { get; } = Guid.NewGuid();

        public bool Confirmed { get; init; } = true;

        public int PauseOnFailure { get; init; }

        public FakeAccounts Accounts => field ??= new(this);

        public FakeCredentials Credentials => field ??= new(this);

        public FakeChallenges Challenges => field ??= new(this);

        public LocalTotpSecondStep Subject => new(Accounts, Credentials, Challenges, new FixedClock());

        public static string CodeNow() => LocalTotp.Code(Rfc, LocalTotp.StepAt(Now));
    }

    private sealed class FixedClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class FakeAccounts(World world) : ILocalAccounts
    {
        public int Failures { get; private set; }

        private DateTimeOffset? _pausedUntil;

        public ValueTask<LocalAccountRecord?> FindByPrincipalAsync(PrincipalId principalId, CancellationToken cancellationToken) =>
            ValueTask.FromResult<LocalAccountRecord?>(new(
                world.Principal, TenantId.From(Guid.NewGuid()), "ada@example.com", "Ada", PrincipalStatus.Active, "hash", null, _pausedUntil, true, 0, 0));

        public ValueTask<DateTimeOffset?> RegisterFailureAsync(PrincipalId principalId, CancellationToken cancellationToken)
        {
            Failures++;
            if (world.PauseOnFailure > 0 && Failures >= world.PauseOnFailure)
            {
                _pausedUntil = Now + TimeSpan.FromMinutes(5);
            }

            return ValueTask.FromResult(_pausedUntil);
        }

        public ValueTask<bool> AnyAsync(CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<LocalAccountRecord?> FindByEmailAsync(string normalizedEmail, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<AuthenticatedPrincipal?> CreateAsync(TenantId tenantId, string normalizedEmail, string displayName, string? passwordHash, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> SetPasswordAsync(PrincipalId principalId, string? hash, bool changed, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask ClearFailuresAsync(PrincipalId principalId, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<int> RevokeSessionsAsync(PrincipalId principalId, BrowserSessionId? except, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<LocalSessionFacts?> FindSessionAsync(BrowserSessionId sessionId, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<TenantId?> SetupTenantAsync(CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<LocalHashMix> HashMixAsync(CancellationToken cancellationToken) => throw new NotSupportedException();
    }

    private sealed class FakeCredentials(World world) : ILocalCredentials
    {
        private long? _lastStep;

        public ValueTask<LocalTotpRecord?> GetTotpAsync(PrincipalId principalId, CancellationToken cancellationToken) =>
            ValueTask.FromResult<LocalTotpRecord?>(new(Rfc, world.Confirmed ? Now : null, _lastStep));

        public ValueTask<bool> UseTotpStepAsync(PrincipalId principalId, long timeStep, CancellationToken cancellationToken)
        {
            if (_lastStep is { } last && last >= timeStep)
            {
                return ValueTask.FromResult(false);
            }

            _lastStep = timeStep;
            return ValueTask.FromResult(true);
        }

        public ValueTask<LocalPasskeyOwner?> FindPasskeyAsync(byte[] credentialId, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<IReadOnlyList<LocalPasskeyRecord>> ListPasskeysAsync(PrincipalId principalId, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> AddPasskeyAsync(PrincipalId principalId, LocalPasskeyRecord passkey, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask TouchPasskeyAsync(Guid id, long signCount, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> RenamePasskeyAsync(PrincipalId principalId, Guid id, string name, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> RemovePasskeyAsync(PrincipalId principalId, Guid id, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> SetPendingTotpAsync(PrincipalId principalId, byte[] secret, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> ConfirmTotpAsync(PrincipalId principalId, long timeStep, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> RemoveTotpAsync(PrincipalId principalId, CancellationToken cancellationToken) => throw new NotSupportedException();
    }

    private sealed class FakeChallenges(World world) : ILocalChallenges
    {
        public bool Taken { get; set; }

        public int Attempts { get; private set; }

        private LocalChallenge? Live(Guid id) => id == world.ChallengeId
            ? new(id, LocalChallengeKind.SecondStep, world.Principal, null, null, "/home", null, Attempts)
            : null;

        public ValueTask<LocalChallenge?> GetAsync(Guid id, LocalChallengeKind kind, CancellationToken cancellationToken) => ValueTask.FromResult(Live(id));

        public ValueTask<int> BumpAsync(Guid id, CancellationToken cancellationToken) => ValueTask.FromResult(++Attempts);

        public ValueTask<LocalChallenge?> TakeAsync(Guid id, LocalChallengeKind kind, CancellationToken cancellationToken)
        {
            Taken = true;
            return ValueTask.FromResult(Live(id));
        }

        public ValueTask<bool> CreateAsync(Guid id, LocalChallengeKind kind, PrincipalId? principalId, string? state, string? returnTo, string? native, DateTimeOffset expiresAt, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> SetStateAsync(Guid id, string state, CancellationToken cancellationToken) => throw new NotSupportedException();
    }
}
