package app.nix.shell

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/**
 * The one sign-in that may wait for its browser callback: single use, answered by the first callback
 * (valid or not), and closed by a return to the app without one. Main thread only. A Custom Tab
 * reports no cancel, so the pause that opens it and the resume that follows without a callback
 * stand in for one.
 */
class NixSignInFlow {
    /** Exactly one of `code` (with `verifier`) or `error`. */
    fun interface Respond { fun answer(code: String?, verifier: String?, error: String?) }

    class Pending(val issuer: String, val verifier: String, val respond: Respond) {
        var left = false
    }

    private var pending: Pending? = null

    fun waiting(): Boolean = pending != null

    /** Registers a sign-in; null when one is already waiting. */
    fun start(issuer: String, verifier: String, respond: Respond): Pending? =
        if (pending != null) null else Pending(issuer, verifier, respond).also { pending = it }

    /** The browser's redirect. Ignored when nothing waits; otherwise answers the waiting sign-in once. */
    fun callback(url: String?): Boolean {
        val waiting = pending ?: return false
        pending = null
        val code = NixSignIn.handoffCode(url, waiting.issuer)
        if (code != null) waiting.respond.answer(code, waiting.verifier, null)
        else waiting.respond.answer(null, null, "Sign-in could not be completed.")
        return true
    }

    fun paused() { pending?.left = true }

    fun resumed() {
        val waiting = pending?.takeIf { it.left } ?: return
        pending = null
        waiting.respond.answer(null, null, "cancelled")
    }

    /** The tab was launched but the app never paused (the browser did not open): give up. */
    fun expire(p: Pending, message: String) {
        if (pending !== p || p.left) return
        pending = null
        p.respond.answer(null, null, message)
    }
}

/**
 * The pure half of the sign-in handoff (NixShellPlugin does the Custom Tab and the intent). Mirrors
 * NixShell.swift and apps/desktop/src/shell-rules.mjs: passkeys do not work in the WebView for an
 * arbitrary server domain, so sign-in runs in the browser and the page redeems a one-time code, with
 * the verifier that only this app holds, for its cookie.
 */
@OptIn(ExperimentalEncodingApi::class)
object NixSignIn {
    const val SCHEME = "app.nix.shell"

    /** A same-origin path; anything else (absolute, protocol-relative, backslashes, control characters) becomes "/". */
    fun safeReturnTo(path: String?): String =
        if (path != null && path.startsWith("/") && !path.startsWith("//") && path.length <= 2048 &&
            !path.contains('\\') && path.none { it.code < 0x20 || it.code == 0x7f }
        ) path else "/"

    private fun base64Url(bytes: ByteArray) = Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT).encode(bytes)

    /** 32 random bytes as 43 base64url characters, and the SHA-256 challenge sent in its place. */
    fun newVerifier(random: SecureRandom = SecureRandom()): Pair<String, String> {
        val verifier = base64Url(ByteArray(32).also(random::nextBytes))
        return verifier to base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
    }

    fun loginUrl(origin: String, challenge: String, returnTo: String): String {
        // URLEncoder is form encoding; RFC 3986 leaves alphanumerics and -._~ unescaped.
        val encoded = URLEncoder.encode(returnTo, "UTF-8").replace("+", "%20").replace("*", "%2A").replace("%7E", "~")
        return "$origin/auth/login?native=$challenge&returnTo=$encoded"
    }

    /**
     * The code from `app.nix.shell://auth?code=...&iss=...`, only from the server the sign-in started
     * on (RFC 9207). Otherwise a malicious saved server could redirect the browser to another
     * server's login and be handed the code and the verifier for it. `code` and `iss` must each
     * appear once; a parameter this build does not know is ignored, so a newer server that adds one
     * does not lock every installed app out of sign-in. Scheme and host compare case-insensitively;
     * the path and fragment are ignored, as on iOS.
     */
    fun handoffCode(callback: String?, issuer: String): String? {
        val uri = try { URI(callback ?: return null) } catch (_: Exception) { return null }
        if (uri.scheme?.lowercase() != SCHEME || uri.host?.lowercase() != "auth") return null
        val items = try {
            (uri.rawQuery ?: return null).split('&').filter { it.isNotEmpty() }.map {
                val i = it.indexOf('=')
                val name = URLDecoder.decode(if (i < 0) it else it.substring(0, i), "UTF-8")
                name to if (i < 0) "" else URLDecoder.decode(it.substring(i + 1), "UTF-8")
            }
        } catch (_: Exception) {
            return null
        }
        val codes = items.filter { it.first == "code" }
        val issuers = items.filter { it.first == "iss" }
        if (codes.size != 1 || issuers.size != 1 || codes[0].second.isEmpty()) return null
        return codes[0].second.takeIf { NixServers.origin(issuers[0].second) == issuer }
    }
}
