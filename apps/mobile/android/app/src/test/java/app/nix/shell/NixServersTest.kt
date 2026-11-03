package app.nix.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NixServersTest {
    @Test fun httpsOriginDropsDefaultPortAndLowercases() {
        assertEquals("https://nix.example.com", NixServers.origin("HTTPS://Nix.Example.com:443/path?q=1"))
        assertEquals("https://nix.example.com:8443", NixServers.origin("https://nix.example.com:8443/"))
    }

    @Test fun httpOnlyForLocalhost() {
        assertEquals("http://localhost:5391", NixServers.origin("http://localhost:5391/x"))
        assertEquals("http://localhost", NixServers.origin("http://localhost:80"))
        assertNull(NixServers.origin("http://nix.example.com"))
    }

    @Test fun rejectsUserinfoOtherSchemesAndGarbage() {
        assertNull(NixServers.origin("https://user:pw@nix.example.com"))
        assertNull(NixServers.origin("https://user@nix.example.com"))
        assertNull(NixServers.origin("file:///etc/passwd"))
        assertNull(NixServers.origin("javascript:alert(1)"))
        assertNull(NixServers.origin("not a url"))
        assertNull(NixServers.origin(null))
    }

    @Test fun validateKeepsGoodEntriesAndNormalises() {
        val out = NixServers.validate(
            listOf(
                mapOf("origin" to "https://a.example.com:443/", "loginOrigin" to "https://id.example.com/login"),
                mapOf("origin" to "http://evil.example.com"),
                mapOf("origin" to 5),
                mapOf("origin" to "https://b.example.com", "loginOrigin" to "http://id.example.com"),
            ),
            "https://localhost",
        )
        assertEquals(
            listOf(
                mapOf("origin" to "https://a.example.com", "loginOrigin" to "https://id.example.com"),
                mapOf("origin" to "https://b.example.com"),
            ),
            out,
        )
    }

    @Test fun validateRefusesThePickersOwnOrigin() {
        assertEquals(emptyList<Map<String, String>>(), NixServers.validate(listOf(mapOf("origin" to "https://localhost")), "https://localhost"))
    }

    @Test fun allowedIsServersAndLoginOrigins() {
        val servers = listOf(mapOf("origin" to "https://a.example.com", "loginOrigin" to "https://id.example.com"))
        assertEquals(setOf("https://a.example.com", "https://id.example.com"), NixServers.allowed(servers))
    }
}
