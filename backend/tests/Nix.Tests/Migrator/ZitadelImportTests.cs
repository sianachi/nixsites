using System.Text;
using System.Text.Json;
using Nix.Migrator.ZitadelImport;
using Xunit;

namespace Nix.Tests.Migrator;

public sealed class ZitadelImportTests
{
    private static readonly byte[] Key = Convert.FromHexString("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    private static readonly Guid Tenant = Guid.Parse("11111111-1111-1111-1111-111111111111");

    // JBSWY3DPEHPK3PXP encrypted with openssl enc -aes-256-cfb under Key and this IV, IV first.
    private static readonly byte[] Encrypted = Convert.FromHexString(
        "0f0e0d0c0b0a09080706050403020100" + "38f3b06f15400b7b36e29481b912ddf1");

    [Fact]
    public void Decrypts_what_openssl_encrypted_with_aes_cfb()
    {
        Assert.Equal("JBSWY3DPEHPK3PXP", Encoding.ASCII.GetString(ZitadelCrypto.Decrypt(Encrypted, Key)));
    }

    [Fact]
    public void Turns_the_stored_base32_into_the_raw_secret()
    {
        Assert.Equal("Hello!Þ­¾ï", Encoding.Latin1.GetString(ZitadelCrypto.OtpSecret(Encrypted, Key)));
        Assert.Equal("foobar", Encoding.ASCII.GetString(ZitadelCrypto.Base32Decode("mzxw6ytboi======")));
    }

    [Fact]
    public void Wraps_a_masterkey_unwrap_in_url_safe_base64()
    {
        var masterKey = Encoding.UTF8.GetString(Key[..32].Select(static b => (byte)(b + 65)).ToArray());
        var stored = Convert.ToBase64String(EncryptWith(Encoding.UTF8.GetBytes(masterKey), Key)).Replace('+', '-').Replace('/', '_');
        Assert.Equal(Key, ZitadelCrypto.DecryptKey(stored, masterKey));
    }

    [Fact]
    public void Folds_the_latest_hash_and_only_a_verified_authenticator()
    {
        var secret = $$$"""{"otpSecret":{"CryptoType":0,"Algorithm":"AES","KeyID":"otpKey","Crypted":"{{{Convert.ToBase64String(Encrypted)}}}"}}""";
        var folded = ZitadelEventFold.Fold(
        [
            Event("u1", "user.human.added", """{"encodedHash":"$2a$14$old"}"""),
            Event("u1", "user.human.password.changed", """{"encodedHash":"$2a$14$new"}"""),
            Event("u1", "user.human.mfa.otp.added", secret),
            Event("u2", "user.human.mfa.otp.added", secret),
            Event("u2", "user.human.mfa.otp.verified", "{}"),
            Event("u2", "user.human.mfa.otp.sms.added", "{}"),
            Event("u3", "user.human.mfa.otp.added", secret),
            Event("u3", "user.human.mfa.otp.verified", "{}"),
            Event("u3", "user.human.mfa.otp.removed", "{}"),
        ]);

        Assert.Equal("$2a$14$new", folded["u1"].PasswordHash);
        Assert.False(folded["u1"].OtpVerified);
        Assert.True(folded["u2"].OtpVerified);
        Assert.True(folded["u2"].Sms);
        Assert.Equal("otpKey", folded["u2"].Otp!.Value.KeyId);
        Assert.Equal(Encrypted, folded["u2"].Otp!.Value.Crypted);
        Assert.Null(folded["u3"].Otp);
    }

    [Fact]
    public void Folds_passkeys_and_security_keys_with_counters_and_removal()
    {
        var verified = """{"webAuthNTokenId":"t1","keyId":"3mfozXWV+nC4","publicKey":"pQECAyYgASFY","signCount":1,"aaguid":"AQIDBAUGBwgBAgMEBQYHCA==","webAuthNTokenName":"Laptop"}""";
        var folded = ZitadelEventFold.Fold(
        [
            Event("u1", "user.human.passwordless.token.added", """{"webAuthNTokenId":"t1"}"""),
            Event("u1", "user.human.passwordless.token.verified", verified),
            Event("u1", "user.human.passwordless.token.signcount.changed", """{"webAuthNTokenId":"t1","signCount":7}"""),
            Event("u1", "user.human.u2f.token.verified", verified.Replace("t1", "t2", StringComparison.Ordinal)),
            Event("u1", "user.human.u2f.token.removed", """{"webAuthNTokenId":"t2"}"""),
            Event("u1", "user.human.u2f.token.verified", verified.Replace("t1", "t3", StringComparison.Ordinal)),
        ]);

        var tokens = folded["u1"].WebAuthn;
        Assert.Equal(["t1", "t3"], [.. tokens.Keys.Order(StringComparer.Ordinal)]);
        Assert.False(tokens["t1"].SecurityKey);
        Assert.Equal(7, tokens["t1"].SignCount);
        Assert.True(tokens["t3"].SecurityKey);
        Assert.Equal("Laptop", tokens["t1"].Name);
        Assert.Equal(Convert.FromBase64String("3mfozXWV+nC4"), tokens["t1"].CredentialId);
        Assert.NotNull(tokens["t1"].Aaguid);
    }

    [Fact]
    public void Lists_every_clash_and_writes_no_account_for_a_blocked_run()
    {
        var plan = Plan(
            [User("a", "Sam@Example.com"), User("b", "sam@example.com "), User("c", "kim@example.com")],
            new NixState(new Dictionary<string, ExistingPrincipal>(), new Dictionary<string, Guid>(), (Tenant, "https://idp")));

        var clash = Assert.Single(plan.Clashes);
        Assert.Equal("sam@example.com", clash.Email);
        Assert.Equal(["a", "b"], clash.Owners);
    }

    [Fact]
    public void Attaches_to_the_existing_principal_and_creates_one_for_a_person_who_never_signed_in()
    {
        var existing = Guid.NewGuid();
        var plan = Plan(
            [User("a", "a@example.com"), User("b", "b@example.com")],
            new NixState(new Dictionary<string, ExistingPrincipal> { ["a"] = new(existing, Tenant) }, new Dictionary<string, Guid>(), (Tenant, "https://idp")));

        Assert.Equal(existing, plan.Accounts[0].PrincipalId);
        Assert.False(plan.Accounts[0].NewPrincipal);
        Assert.True(plan.Accounts[1].NewPrincipal);
    }

    [Fact]
    public void Is_a_no_clash_on_rerun_but_refuses_an_email_another_person_already_holds()
    {
        var existing = Guid.NewGuid();
        var principals = new Dictionary<string, ExistingPrincipal> { ["a"] = new(existing, Tenant) };

        var again = Plan([User("a", "a@example.com")], new NixState(principals, new Dictionary<string, Guid> { ["a@example.com"] = existing }, null));
        Assert.Empty(again.Clashes);

        var taken = Plan([User("a", "a@example.com")], new NixState(principals, new Dictionary<string, Guid> { ["a@example.com"] = Guid.NewGuid() }, null));
        Assert.Single(taken.Clashes);
        Assert.Empty(taken.Accounts);
    }

    [Fact]
    public void Reports_what_it_cannot_carry()
    {
        var credentials = new Dictionary<string, ZitadelCredentials>
        {
            ["a"] = new() { PasswordHash = "$scrypt$ln=15$abc", Sms = true, EmailCodes = true, OutsideLogin = true },
            ["b"] = new() { PasswordHash = "$2a$14$abcdefghijklmnopqrstuv" },
        };
        var plan = ZitadelImportPlanner.Plan(
            [User("a", "a@example.com"), User("b", "b@example.com"), User("c", "c@example.com", state: 2)],
            credentials,
            machineUsers: 2,
            new NixState(new Dictionary<string, ExistingPrincipal>(), new Dictionary<string, Guid>(), (Tenant, "https://idp")),
            _ => null,
            (_, _) => Guid.NewGuid());

        Assert.Null(plan.Accounts[0].PasswordHash);
        Assert.NotNull(plan.Accounts[1].PasswordHash);
        Assert.Equal(2, plan.NotCarriedCounts["machine user"]);
        Assert.Equal(1, plan.NotCarriedCounts["password hash"]);
        Assert.Equal(1, plan.NotCarriedCounts["inactive user"]);
        Assert.Equal(1, plan.NotCarriedCounts["SMS codes"]);
        Assert.Equal(1, plan.NotCarriedCounts["outside login link"]);
        Assert.Equal(2, plan.Accounts.Count);
    }

    [Fact]
    public void Blocks_the_run_when_an_authenticator_secret_cannot_be_decrypted()
    {
        var credentials = new Dictionary<string, ZitadelCredentials>
        {
            ["a"] = new() { OtpVerified = true, Otp = ("otpKey", Encrypted) },
        };
        State(credentials, _ => null, out var missing);
        State(credentials, _ => new byte[32], out var wrong);

        Assert.Single(missing.Blockers);
        Assert.Single(wrong.Blockers);
        Assert.NotNull(State(credentials, _ => Key, out var ok));
        Assert.Empty(ok.Blockers);
        Assert.NotNull(ok.Accounts[0].TotpSecret);
    }

    [Fact]
    public void Blocks_the_run_when_a_second_factor_cannot_be_read_from_the_events()
    {
        var folded = ZitadelEventFold.Fold(
        [
            Event("a", "user.human.mfa.otp.added", """{"secret":"shape nobody expected"}"""),
            Event("a", "user.human.mfa.otp.verified", "{}"),
            Event("a", "user.human.u2f.token.verified", """{"webAuthNTokenId":"t1","key":"shape nobody expected"}"""),
        ]);

        State(folded, _ => Key, out var plan);

        Assert.Equal(2, plan.Blockers.Count);
    }

    [Fact]
    public void Blocks_a_person_who_never_signed_in_when_no_single_provider_exists()
    {
        var plan = Plan([User("a", "a@example.com")], new NixState(new Dictionary<string, ExistingPrincipal>(), new Dictionary<string, Guid>(), null));
        Assert.Single(plan.Blockers);
    }

    [Fact]
    public void Accepts_a_postgres_url_and_always_asks_for_a_read_only_session()
    {
        var connection = ZitadelSource.ConnectionString("postgres://zit:p%40ss@db.internal:5433/zitadel?sslmode=require");
        Assert.Contains("Host=db.internal", connection, StringComparison.Ordinal);
        Assert.Contains("Port=5433", connection, StringComparison.Ordinal);
        Assert.Contains("Password=p@ss", connection, StringComparison.Ordinal);
        Assert.Contains("default_transaction_read_only=on", connection, StringComparison.Ordinal);
        Assert.Contains("default_transaction_read_only=on", ZitadelSource.ConnectionString("Host=x;Database=y"), StringComparison.Ordinal);
    }

    [Fact]
    public void Names_an_unnamed_or_overlong_credential()
    {
        var key = new ZitadelWebAuthn("t", false, [1], [2], 0, null, "  ", DateTimeOffset.UnixEpoch);
        Assert.Equal("Imported passkey", NixStore.DisplayName(key));
        Assert.Equal("Imported security key", NixStore.DisplayName(key with { SecurityKey = true }));
        Assert.Equal(100, NixStore.DisplayName(key with { Name = new string('x', 300) }).Length);
    }

    private static ImportPlan Plan(IReadOnlyList<ZitadelUser> users, NixState state) =>
        ZitadelImportPlanner.Plan(users, new Dictionary<string, ZitadelCredentials>(), 0, state, _ => null, (_, _) => Guid.NewGuid());

    private static ImportPlan State(Dictionary<string, ZitadelCredentials> credentials, Func<string, byte[]?> keys, out ImportPlan plan) =>
        plan = ZitadelImportPlanner.Plan(
            [User("a", "a@example.com")], credentials, 0,
            new NixState(new Dictionary<string, ExistingPrincipal>(), new Dictionary<string, Guid>(), (Tenant, "https://idp")), keys, (_, _) => Guid.NewGuid());

    private static ZitadelUser User(string id, string email, short state = 1) => new(id, state, email, true, id);

    private static ZitadelEvent Event(string user, string type, string payload) =>
        new(user, type, DateTimeOffset.UnixEpoch, JsonElement.Parse(payload));

    private static byte[] EncryptWith(byte[] key, byte[] plain)
    {
        var iv = new byte[16];
        using var aes = System.Security.Cryptography.Aes.Create();
        aes.Key = key;
        return [.. iv, .. aes.EncryptCfb(plain, iv, System.Security.Cryptography.PaddingMode.None, 128)];
    }
}
