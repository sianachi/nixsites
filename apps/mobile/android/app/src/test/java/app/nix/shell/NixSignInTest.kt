package app.nix.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The cases of NixShell.swift's handoffCode and apps/desktop/src/shell-rules.test.mjs.
class NixSignInTest {
    private val issuer = "https://nix.example.com"
    private fun code(url: String?, from: String = issuer) = NixSignIn.handoffCode(url, from)

    @Test fun acceptsTheCodeFromTheServerSignInStartedOn() {
        assertEquals("abc", code("app.nix.shell://auth?code=abc&iss=https%3A%2F%2Fnix.example.com"))
        assertEquals("abc", code("app.nix.shell://auth?iss=https%3A%2F%2Fnix.example.com&code=abc"))
        // The issuer is compared as an origin: default port and path do not matter.
        assertEquals("abc", code("app.nix.shell://auth?code=abc&iss=https%3A%2F%2FNix.Example.com%3A443%2Fsomething"))
    }

    @Test fun toleratesHarmlessVariations() {
        assertEquals("abc", code("APP.NIX.SHELL://AUTH?code=abc&iss=https%3A%2F%2Fnix.example.com"))
        assertEquals("abc", code("app.nix.shell://auth/?code=abc&iss=https%3A%2F%2Fnix.example.com#frag"))
        // A parameter this build does not know is ignored.
        assertEquals("abc", code("app.nix.shell://auth?code=abc&iss=https%3A%2F%2Fnix.example.com&state=x&extra=1"))
        assertEquals("a b", code("app.nix.shell://auth?code=a%20b&iss=https%3A%2F%2Fnix.example.com"))
    }

    @Test fun refusesAnotherIssuer() {
        assertNull(code("app.nix.shell://auth?code=abc&iss=https%3A%2F%2Fevil.example.com"))
        assertNull(code("app.nix.shell://auth?code=abc&iss=https%3A%2F%2Fnix.example.com.evil.example"))
        assertNull(code("app.nix.shell://auth?code=abc&iss=http%3A%2F%2Fnix.example.com"))
        assertNull(code("app.nix.shell://auth?code=abc&iss=https%3A%2F%2Fnix.example.com", "https://other.example.com"))
    }

    @Test fun refusesMissingOrRepeatedParameters() {
        assertNull(code("app.nix.shell://auth?iss=https%3A%2F%2Fnix.example.com"))
        assertNull(code("app.nix.shell://auth?code=abc"))
        assertNull(code("app.nix.shell://auth?code=&iss=https%3A%2F%2Fnix.example.com"))
        assertNull(code("app.nix.shell://auth"))
        assertNull(code("app.nix.shell://auth?code=a&code=b&iss=https%3A%2F%2Fnix.example.com"))
        assertNull(code("app.nix.shell://auth?code=a&iss=https%3A%2F%2Fnix.example.com&iss=https%3A%2F%2Fnix.example.com"))
    }

    @Test fun refusesAnotherSchemeHostOrGarbage() {
        assertNull(code("https://auth?code=abc&iss=https%3A%2F%2Fnix.example.com"))
        assertNull(code("app.nix.other://auth?code=abc&iss=https%3A%2F%2Fnix.example.com"))
        assertNull(code("app.nix.shell://other?code=abc&iss=https%3A%2F%2Fnix.example.com"))
        assertNull(code("app.nix.shell://auth.evil.example?code=abc&iss=https%3A%2F%2Fnix.example.com"))
        assertNull(code("app.nix.shell:///auth?code=abc&iss=https%3A%2F%2Fnix.example.com"))
        assertNull(code("not a url"))
        assertNull(code("app.nix.shell://auth?code=%zz&iss=https%3A%2F%2Fnix.example.com"))
        assertNull(code(null))
    }

    @Test fun returnToStaysOnTheOrigin() {
        assertEquals("/w/1?x=2", NixSignIn.safeReturnTo("/w/1?x=2"))
        for (bad in listOf(null, "", "https://evil.example/", "//evil.example", "/a\\b", "/a\nb", "x", "/" + "a".repeat(2048)))
            assertEquals("/", NixSignIn.safeReturnTo(bad))
    }

    @Test fun verifierIsFortyThreeBase64UrlCharactersAndTheChallengeIsItsHash() {
        val (verifier, challenge) = NixSignIn.newVerifier()
        assertEquals(43, verifier.length)
        assertEquals(43, challenge.length)
        assert(Regex("[A-Za-z0-9_-]{43}").matches(verifier))
        // RFC 7636 appendix B.
        val java = java.security.MessageDigest.getInstance("SHA-256").digest("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".toByteArray())
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", java.let {
            kotlin.io.encoding.Base64.UrlSafe.withPadding(kotlin.io.encoding.Base64.PaddingOption.ABSENT).encode(it)
        })
    }

    @Test fun loginUrlEncodesReturnTo() {
        assertEquals(
            "https://nix.example.com/auth/login?native=ch&returnTo=%2Fw%2F1%3Fa%3Db%20c~",
            NixSignIn.loginUrl(issuer, "ch", "/w/1?a=b c~"),
        )
    }
}
