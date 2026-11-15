using Nix.Authentication;

namespace Nix.Tests.Authentication;

/// <summary>Known vectors for every hash format an imported account may carry, plus the new Argon2id format.</summary>
public sealed class PasswordHasherTests
{
    private readonly PasswordHasher _hasher = new();

    [Fact]
    public void A_new_hash_is_argon2id_verifies_and_needs_no_rehash()
    {
        var hash = _hasher.Hash("correct horse battery");

        Assert.StartsWith("$argon2id$v=19$m=19456,t=2,p=1$", hash, StringComparison.Ordinal);
        Assert.Equal(new PasswordCheck(true, false), _hasher.Verify("correct horse battery", hash));
        Assert.Equal(default, _hasher.Verify("correct horse batterz", hash));
    }

    [Theory]
    [InlineData("$pbkdf2-sha256$1000$c2FsdHNhbHQ$")]
    [InlineData("$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$")]
    public void A_stored_hash_with_an_empty_digest_matches_no_password(string stored)
    {
        Assert.False(_hasher.Verify("any password at all", stored).Ok);
        Assert.False(_hasher.Verify(string.Empty, stored).Ok);
    }

    [Fact]
    public void Two_hashes_of_one_password_differ_by_salt()
    {
        Assert.NotEqual(_hasher.Hash("same password!"), _hasher.Hash("same password!"));
    }

    [Fact]
    public void An_argon2i_reference_vector_verifies_and_is_marked_for_rehash()
    {
        // From the Argon2 reference implementation's README: password "password", salt "somesalt", t=2, m=65536, p=4.
        const string Encoded = "$argon2i$v=19$m=65536,t=2,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG";

        Assert.Equal(new PasswordCheck(true, true), _hasher.Verify("password", Encoded));
        Assert.False(_hasher.Verify("passwore", Encoded).Ok);
    }

    [Fact]
    public void A_bcrypt_vector_verifies_and_is_marked_for_rehash()
    {
        // crypt_blowfish's published vector for the password "U*U".
        const string Encoded = "$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW";

        Assert.Equal(new PasswordCheck(true, true), _hasher.Verify("U*U", Encoded));
        Assert.False(_hasher.Verify("U*V", Encoded).Ok);
    }

    [Theory]
    [InlineData("$pbkdf2-sha1$2$c2FsdA$6mwBTcctb4zNHtkqzh1B8NjeiVc")] // RFC 6070, c=2, passlib-style unpadded base64
    [InlineData("$pbkdf2-sha1$i=2,l=20$c2FsdA==$6mwBTcctb4zNHtkqzh1B8NjeiVc=")] // parameterised form, padded
    public void A_pbkdf2_rfc_6070_vector_verifies(string encoded)
    {
        Assert.Equal(new PasswordCheck(true, true), _hasher.Verify("password", encoded));
        Assert.False(_hasher.Verify("Password", encoded).Ok);
    }

    [Fact]
    public void A_pbkdf2_sha256_vector_with_dot_for_plus_encoding_verifies()
    {
        // PBKDF2-HMAC-SHA256("password", "salt", 1, 32); the hash bytes contain '+', which passlib writes as '.'.
        var hashBytes = Convert.FromHexString("120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b");
        var encoded = "$pbkdf2-sha256$1$c2FsdA$" + Convert.ToBase64String(hashBytes).TrimEnd('=').Replace('+', '.');

        Assert.True(_hasher.Verify("password", encoded).Ok);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("plaintext")]
    [InlineData("$argon2id$v=19$m=x,t=2,p=1$c2FsdA$AAAA")]
    [InlineData("$2a$garbage")]
    [InlineData("$pbkdf2-md5$1$c2FsdA$AAAA")]
    [InlineData("$unknown$1$2$3")]
    public void A_missing_or_malformed_hash_is_a_wrong_password_not_an_error(string? stored)
    {
        Assert.Equal(default, _hasher.Verify("password-long-enough", stored));
    }

    [Fact]
    public void Dummy_verification_never_throws()
    {
        _hasher.VerifyDummy("whatever password");
    }

    [Theory]
    [InlineData("123456789", false)]
    [InlineData("1234567890", true)]
    [InlineData(null, false)]
    public void Passwords_need_at_least_ten_characters(string? password, bool expected) =>
        Assert.Equal(expected, PasswordHasher.IsAcceptable(password));

    [Fact]
    public void Passwords_over_256_characters_are_refused()
    {
        Assert.True(PasswordHasher.IsAcceptable(new string('a', 256)));
        Assert.False(PasswordHasher.IsAcceptable(new string('a', 257)));
        Assert.False(_hasher.Verify(new string('a', 257), _hasher.Hash("something long")).Ok);
    }
}
