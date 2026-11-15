using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Features.LocalAuth;

namespace Nix.Tests.Authentication;

/// <summary>The password sign-in decision table, the pause rule and the re-authentication rule, over in-memory fakes.</summary>
public sealed class LocalPasswordSignInTests
{
    private const string Password = "correct horse battery";
    private static readonly DateTimeOffset Now = new(2026, 11, 15, 12, 0, 0, TimeSpan.Zero);
    private static readonly TenantId Tenant = TenantId.From(Guid.NewGuid());
    private readonly PasswordHasher _hasher = new();
    private readonly FakeClock _clock = new(Now);

    private LocalPasswordSignIn Subject(FakeAccounts accounts, params ILocalSecondStepMethod[] methods) =>
        new(accounts, _hasher, new LocalSecondStepGate(methods), new LocalSignInDecoy(_hasher), _clock);

    private LocalAccountRecord Account(
        string? hash = null, PrincipalStatus status = PrincipalStatus.Active, DateTimeOffset? pausedUntil = null,
        bool totp = false, int securityKeys = 0) =>
        new(PrincipalId.From(Guid.NewGuid()), Tenant, "ada@example.com", "Ada", status, hash ?? _hasher.Hash(Password),
            null, pausedUntil, totp, 0, securityKeys);

    [Fact]
    public async Task A_correct_password_signs_in_and_clears_the_failure_window()
    {
        var accounts = new FakeAccounts(Account());

        var outcome = await Subject(accounts).CheckAsync("Ada@Example.com", Password, CancellationToken.None);

        Assert.Equal(PasswordSignInKind.SignedIn, outcome.Kind);
        Assert.Equal(accounts.Record!.PrincipalId, outcome.PrincipalId);
        Assert.Equal(1, accounts.Cleared);
        Assert.Equal(0, accounts.Failures);
    }

    [Fact]
    public async Task Unknown_email_wrong_password_no_password_and_disabled_all_look_the_same()
    {
        var wrong = await Subject(new FakeAccounts(Account())).CheckAsync("ada@example.com", "not the password", CancellationToken.None);
        var unknown = await Subject(new FakeAccounts(null)).CheckAsync("nobody@example.com", Password, CancellationToken.None);
        var malformed = await Subject(new FakeAccounts(null)).CheckAsync("not an email", Password, CancellationToken.None);
        var passwordless = await Subject(new FakeAccounts(Account() with { PasswordHash = null })).CheckAsync("ada@example.com", Password, CancellationToken.None);
        var disabled = await Subject(new FakeAccounts(Account(status: PrincipalStatus.Suspended))).CheckAsync("ada@example.com", Password, CancellationToken.None);

        Assert.All([wrong, unknown, malformed, passwordless, disabled], o => Assert.Equal(new PasswordSignInOutcome(PasswordSignInKind.Invalid), o));
    }

    [Fact]
    public async Task Only_a_wrong_password_on_a_real_account_counts_as_a_failure()
    {
        var real = new FakeAccounts(Account());
        var disabled = new FakeAccounts(Account(status: PrincipalStatus.Suspended));

        _ = await Subject(real).CheckAsync("ada@example.com", "wrong password!", CancellationToken.None);
        _ = await Subject(disabled).CheckAsync("ada@example.com", "wrong password!", CancellationToken.None);

        Assert.Equal(1, real.Failures);
        Assert.Equal(0, disabled.Failures);
    }

    [Fact]
    public async Task The_tenth_wrong_password_pauses_the_account_and_a_paused_account_refuses_even_the_right_password()
    {
        var accounts = new FakeAccounts(Account()) { PauseOnFailure = 10, PauseFor = TimeSpan.FromMinutes(5) };
        var subject = Subject(accounts);
        for (var i = 1; i < 10; i++)
        {
            Assert.Equal(PasswordSignInKind.Invalid, (await subject.CheckAsync("ada@example.com", "wrong password!", CancellationToken.None)).Kind);
        }

        var tenth = await subject.CheckAsync("ada@example.com", "wrong password!", CancellationToken.None);
        Assert.Equal(PasswordSignInKind.Paused, tenth.Kind);
        Assert.Equal(TimeSpan.FromMinutes(5), tenth.RetryAfter);

        var correctWhilePaused = await subject.CheckAsync("ada@example.com", Password, CancellationToken.None);
        Assert.Equal(PasswordSignInKind.Paused, correctWhilePaused.Kind);
        Assert.Equal(10, accounts.Failures);
    }

    [Fact]
    public async Task A_pause_that_has_ended_no_longer_blocks()
    {
        var accounts = new FakeAccounts(Account(pausedUntil: Now - TimeSpan.FromSeconds(1)));

        Assert.Equal(PasswordSignInKind.SignedIn, (await Subject(accounts).CheckAsync("ada@example.com", Password, CancellationToken.None)).Kind);
    }

    [Fact]
    public async Task An_imported_hash_signs_in_and_is_rehashed_to_argon2id_without_touching_the_change_time()
    {
        const string Bcrypt = "$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW"; // crypt_blowfish vector, password "U*U"
        var accounts = new FakeAccounts(Account(Bcrypt));

        var outcome = await Subject(accounts).CheckAsync("ada@example.com", "U*U", CancellationToken.None);

        Assert.Equal(PasswordSignInKind.SignedIn, outcome.Kind);
        Assert.StartsWith("$argon2id$", accounts.Rehashed, StringComparison.Ordinal);
        Assert.False(accounts.RehashCountedAsChange);
    }

    [Fact]
    public async Task An_enrolled_second_step_turns_a_correct_password_into_a_challenge()
    {
        var accounts = new FakeAccounts(Account(totp: true));

        var outcome = await Subject(accounts, new FakeMethod(LocalSecondStepMethods.Totp, enrolled: true))
            .CheckAsync("ada@example.com", Password, CancellationToken.None);

        Assert.Equal(PasswordSignInKind.SecondStep, outcome.Kind);
        Assert.Equal([LocalSecondStepMethods.Totp], outcome.Methods);
    }

    [Fact]
    public async Task A_second_factor_nobody_can_check_refuses_the_sign_in_instead_of_skipping_it()
    {
        var accounts = new FakeAccounts(Account(totp: true));

        var outcome = await Subject(accounts).CheckAsync("ada@example.com", Password, CancellationToken.None);

        Assert.Equal(PasswordSignInKind.SecondStepUnavailable, outcome.Kind);
    }

    [Fact]
    public async Task Re_authentication_asks_for_the_current_password_and_counts_wrong_ones()
    {
        var accounts = new FakeAccounts(Account());
        var reauth = Reauth(accounts);

        Assert.True((await reauth.CheckAsync(accounts.Record!, Password, CancellationToken.None)).IsOk);
        Assert.Equal(ReauthOutcome.WrongPassword, (await reauth.CheckAsync(accounts.Record!, "nope nope nope", CancellationToken.None)).Outcome);
        Assert.Equal(ReauthOutcome.WrongPassword, (await reauth.CheckAsync(accounts.Record!, null, CancellationToken.None)).Outcome);
        Assert.Equal(2, accounts.Failures);
    }

    [Theory]
    [InlineData(14, true)]
    [InlineData(16, false)]
    public async Task Without_a_password_only_a_session_younger_than_fifteen_minutes_re_authenticates(int ageMinutes, bool allowed)
    {
        var sessionId = Guid.NewGuid();
        var account = Account() with { PasswordHash = null };
        var credential = new CredentialSessionContext();
        credential.Set(sessionId);
        var reauth = Reauth(new FakeAccounts(account) { SessionCreatedAt = Now - TimeSpan.FromMinutes(ageMinutes) }, credential);

        var result = await reauth.CheckAsync(account, null, CancellationToken.None);

        Assert.Equal(allowed, result.IsOk);
        Assert.Equal(allowed ? ReauthOutcome.Ok : ReauthOutcome.StaleSession, result.Outcome);
    }

    private LocalReauth Reauth(FakeAccounts accounts, CredentialSessionContext? credential = null) =>
        new(accounts, _hasher, credential ?? new CredentialSessionContext(), _clock);

    [Fact]
    public async Task An_unknown_email_is_paused_after_ten_attempts_like_a_real_account()
    {
        var subject = Subject(new FakeAccounts(null));
        for (var attempt = 1; attempt < 10; attempt++)
        {
            Assert.Equal(PasswordSignInKind.Invalid, (await subject.CheckAsync("nobody@example.com", "wrong password!", CancellationToken.None)).Kind);
        }

        var tenth = await subject.CheckAsync("nobody@example.com", "wrong password!", CancellationToken.None);
        var eleventh = await subject.CheckAsync("Nobody@Example.com", "wrong password!", CancellationToken.None);

        Assert.Equal(PasswordSignInKind.Paused, tenth.Kind);
        Assert.Equal(TimeSpan.FromMinutes(5), tenth.RetryAfter);
        Assert.Equal(PasswordSignInKind.Paused, eleventh.Kind);
    }

    private sealed class FakeClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class FakeMethod(string method, bool enrolled) : ILocalSecondStepMethod
    {
        public string Method => method;

        public ValueTask<bool> IsEnrolledAsync(LocalAccountRecord account, CancellationToken cancellationToken) => ValueTask.FromResult(enrolled);
    }

    private sealed class FakeAccounts(LocalAccountRecord? record) : ILocalAccounts
    {
        public LocalAccountRecord? Record { get; private set; } = record;

        public int Failures { get; private set; }

        public int Cleared { get; private set; }

        public int PauseOnFailure { get; init; }

        public TimeSpan PauseFor { get; init; }

        public string? Rehashed { get; private set; }

        public bool RehashCountedAsChange { get; private set; }

        public ValueTask<LocalAccountRecord?> FindByEmailAsync(string normalizedEmail, CancellationToken cancellationToken) =>
            ValueTask.FromResult(Record is { } r && r.Email == normalizedEmail ? Record : null);

        public ValueTask<DateTimeOffset?> RegisterFailureAsync(PrincipalId principalId, CancellationToken cancellationToken)
        {
            Failures++;
            if (PauseOnFailure > 0 && Failures >= PauseOnFailure)
            {
                var until = Now + PauseFor;
                Record = Record! with { PausedUntil = until };
                return ValueTask.FromResult<DateTimeOffset?>(until);
            }

            return ValueTask.FromResult<DateTimeOffset?>(null);
        }

        public ValueTask ClearFailuresAsync(PrincipalId principalId, CancellationToken cancellationToken)
        {
            Cleared++;
            return ValueTask.CompletedTask;
        }

        public ValueTask<bool> SetPasswordAsync(PrincipalId principalId, string? hash, bool changed, CancellationToken cancellationToken)
        {
            Rehashed = hash;
            RehashCountedAsChange = changed;
            return ValueTask.FromResult(true);
        }

        public ValueTask<bool> AnyAsync(CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<LocalAccountRecord?> FindByPrincipalAsync(PrincipalId principalId, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<AuthenticatedPrincipal?> CreateAsync(TenantId tenantId, string normalizedEmail, string displayName, string? passwordHash, CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<int> RevokeSessionsAsync(PrincipalId principalId, BrowserSessionId? except, CancellationToken cancellationToken) => throw new NotSupportedException();

        public DateTimeOffset? SessionCreatedAt { get; init; }

        public ValueTask<LocalSessionFacts?> FindSessionAsync(BrowserSessionId sessionId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(SessionCreatedAt is { } at ? new LocalSessionFacts(false, at) : null);

        public ValueTask<TenantId?> SetupTenantAsync(CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<LocalHashMix> HashMixAsync(CancellationToken cancellationToken) => ValueTask.FromResult(default(LocalHashMix));
    }
}
