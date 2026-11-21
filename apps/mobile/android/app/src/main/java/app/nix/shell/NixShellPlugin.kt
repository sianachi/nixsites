package app.nix.shell

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.browser.customtabs.CustomTabsIntent
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.util.Collections
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** The origin rule and the server-list validation, free of Android types so JVM tests can run them. */
object NixServers {
    /** `https://host[:port]`, or plain http for `localhost` only (a dev stack seen from the emulator). */
    fun origin(url: String?): String? {
        val uri = try { URI(url ?: return null) } catch (_: Exception) { return null }
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        if (uri.rawUserInfo != null) return null
        if (scheme != "https" && !(scheme == "http" && host == "localhost")) return null
        // Default ports are dropped, as browsers do, so every comparison agrees.
        val port = uri.port.takeUnless { it == -1 || (it == 443 && scheme == "https") || (it == 80 && scheme == "http") }
        return if (port == null) "$scheme://$host" else "$scheme://$host:$port"
    }

    /**
     * Keeps entries whose origin is valid; loginOrigin is kept only when valid. `local` (the bundled
     * picker's own origin) is refused as a server: it would serve the app's assets with the bridge.
     */
    fun validate(entries: List<Map<String, Any?>>, local: String?): List<Map<String, String>> =
        entries.mapNotNull { entry ->
            val origin = origin(entry["origin"] as? String)?.takeIf { it != local } ?: return@mapNotNull null
            val login = origin(entry["loginOrigin"] as? String)?.takeIf { it != local }
            if (login == null) mapOf("origin" to origin) else mapOf("origin" to origin, "loginOrigin" to login)
        }

    fun allowed(servers: List<Map<String, String>>): Set<String> =
        servers.flatMap { listOfNotNull(it["origin"], it["loginOrigin"]) }.toSet()
}

/**
 * The saved Nix servers, and the rule for which pages may load in the WebView.
 *
 * Every page that loads in the WebView gets Capacitor's bridge, whose native HTTP plugin sends the
 * WebView's cookies without CORS. So only the saved servers and the sign-in origin each redirects
 * to may load here; any other navigation falls through to Capacitor's default and opens externally.
 */
@CapacitorPlugin(name = "NixShell")
class NixShellPlugin : Plugin() {
    private val prefs by lazy { context.getSharedPreferences("nix.shell", Context.MODE_PRIVATE) }
    private val localOrigin by lazy { NixServers.origin(bridge.localUrl) }

    private fun savedServers(): List<Map<String, String>> = try {
        val array = JSONArray(prefs.getString(KEY, "[]"))
        NixServers.validate((0 until array.length()).map { i ->
            array.getJSONObject(i).let { o -> o.keys().asSequence().associateWith { k -> o.opt(k) } }
        }, localOrigin)
    } catch (_: Exception) {
        emptyList()
    }

    private val main = Handler(Looper.getMainLooper())
    private val stores by lazy { NixStores(File(context.noBackupFilesDir, "nix-store")) }

    /** The servers' own origins (not their sign-in origins): the only ones whose pages get a store. */
    private fun savedOrigins(): Set<String> = savedServers().mapNotNull { it["origin"] }.toSet()

    override fun load() {
        NixDownload.ensureGuard()
        NixBackgroundSync.dispatcher = ::dispatchBackgroundSync
        // Registered before the first page loads. The picker's channel answers only the bundled page.
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        val local = localOrigin ?: return
        WebViewCompat.addWebMessageListener(bridge.webView, LISTENER, setOf(local)) { _, message, sourceOrigin, isMainFrame, reply ->
            // The sender's origin comes from WebView, never from the message body.
            if (isMainFrame && NixServers.origin(sourceOrigin.toString()) == local) handle(message, reply)
        }
        registerServerChannels()
    }

    /**
     * The `nixStore` and `nixSignIn` channels exist only in the saved servers' pages: the allowed-origin
     * rules decide where WebView injects them (at the next navigation), and each message is checked
     * again against the saved list, by the origin WebView reports. Re-registered when the list changes.
     */
    private fun registerServerChannels() {
        val view = bridge.webView
        for (name in listOf(STORE, SIGN_IN)) try { WebViewCompat.removeWebMessageListener(view, name) } catch (_: Exception) {}
        val origins = savedOrigins()
        NixBackgroundSync.schedule(context, origins.isNotEmpty())
        if (origins.isEmpty()) return
        addServerChannel(STORE, origins) { origin, request, respond -> stores.handle(origin, request, respond) }
        addServerChannel(SIGN_IN, origins) { origin, request, respond -> signIn(origin, request, respond) }
    }

    private fun addServerChannel(name: String, origins: Set<String>, serve: (String, JSONObject, StoreDone) -> Unit) {
        val view = bridge.webView
        fun add(listenerName: String, rules: Set<String>) {
            WebViewCompat.addWebMessageListener(view, listenerName, rules) { _, message, sourceOrigin, isMainFrame, reply ->
                val request = try { JSONObject(message.data ?: return@addWebMessageListener) } catch (_: Exception) { return@addWebMessageListener }
                val id = request.opt("id")
                val respond: StoreDone = { result, error ->
                    val response = JSONObject().put("id", id)
                    if (error != null) response.put("error", error) else response.put("result", result ?: JSONObject())
                    main.post { reply.postMessage(response.toString()) }
                }
                val origin = NixStoreRules.frameOrigin(sourceOrigin.toString(), isMainFrame, savedOrigins())
                if (origin == null) respond(null, "Not allowed.") else serve(origin, request, respond)
            }
        }
        try {
            add(name, origins)
        } catch (_: Exception) {
            // One origin WebView rejects must not cost the others their channel: keep those it accepts.
            val usable = origins.filter { origin ->
                val probe = "${name}Probe"
                try { WebViewCompat.addWebMessageListener(view, probe, setOf(origin)) { _, _, _, _, _ -> }; true } catch (_: Exception) { false }
                    .also { try { WebViewCompat.removeWebMessageListener(view, probe) } catch (_: Exception) {} }
            }.toSet()
            if (usable.isNotEmpty()) try { add(name, usable) } catch (_: Exception) {}
        }
    }

    // Sign-in handoff: passkeys do not work in the WebView for an arbitrary server domain, so the
    // server's sign-in runs in a Custom Tab and the page redeems a one-time code for its cookie.

    private val signInFlow = NixSignInFlow()

    /** Opens the server's sign-in in an ephemeral Custom Tab where the browser has them; answers `{code, verifier}`, or an error string (`cancelled` when the person closes the tab). */
    private fun signIn(origin: String, request: JSONObject, respond: StoreDone) {
        main.post {
            val (verifier, challenge) = NixSignIn.newVerifier()
            val answer = NixSignInFlow.Respond { code, v, error ->
                if (code != null) respond(JSONObject().put("code", code).put("verifier", v), null) else respond(null, error)
            }
            val waiting = signInFlow.start(origin, verifier, answer)
                ?: return@post respond(null, "Sign-in is not available from this page.")
            val returnTo = NixSignIn.safeReturnTo(request.optString("returnTo").takeIf { it.isNotEmpty() })
            try {
                // A browser without ephemeral tabs ignores the flag and opens a normal one.
                CustomTabsIntent.Builder().setEphemeralBrowsingEnabled(true).build()
                    .launchUrl(activity, Uri.parse(NixSignIn.loginUrl(origin, challenge, returnTo)))
                // If the app never pauses the browser may not have opened; do not leave sign-in blocked for good.
                main.postDelayed({ signInFlow.expire(waiting, "Sign-in could not be started.") }, LAUNCH_TIMEOUT_MS)
            } catch (_: Exception) {
                signInFlow.expire(waiting, "Sign-in could not be started.")
            }
        }
    }

    /**
     * Asks the page to run one sync pass, if the WebView shows a saved server's page. Called by the
     * background worker; the event runs on the main thread, as the page's own code does.
     */
    private fun dispatchBackgroundSync(): Boolean {
        val task = FutureTask<Boolean> {
            val view = bridge.webView
            if (NixServers.origin(view.url) in savedOrigins()) {
                view.evaluateJavascript(NixBackgroundSync.EVENT_SCRIPT, null)
                true
            } else false
        }
        main.post(task)
        return try { task.get(5, TimeUnit.SECONDS) } catch (_: Exception) { false }
    }

    override fun handleOnDestroy() {
        NixBackgroundSync.dispatcher = null
    }

    /** The browser's redirect to `app.nix.shell://auth`. */
    override fun handleOnNewIntent(intent: Intent) {
        intent.data?.takeIf { it.scheme.equals(NixSignIn.SCHEME, ignoreCase = true) }?.let { signInFlow.callback(it.toString()) }
    }

    override fun handleOnPause() = signInFlow.paused()

    override fun handleOnResume() = signInFlow.resumed()

    private fun handle(message: WebMessageCompat, reply: JavaScriptReplyProxy) {
        val request = try { JSONObject(message.data ?: return) } catch (_: Exception) { return }
        val response = JSONObject().put("id", request.opt("id"))
        try {
            when (request.optString("op")) {
                "getServers" -> response.put("result", JSONObject().put("servers", JSONArray(savedServers().map(::JSONObject))))
                "setServers" -> {
                    val array = request.optJSONArray("servers") ?: JSONArray()
                    val entries = (0 until array.length()).mapNotNull { array.optJSONObject(it) }
                        .map { o -> o.keys().asSequence().associateWith { k -> o.opt(k) } }
                    val valid = NixServers.validate(entries, localOrigin)
                    val dropped = savedOrigins() - valid.mapNotNull { it["origin"] }.toSet()
                    prefs.edit().putString(KEY, JSONArray(valid.map(::JSONObject)).toString()).apply()
                    registerServerChannels()
                    // A removed server's offline copy goes with it; say so if any of it stays behind.
                    val failed = Collections.synchronizedList(ArrayList<String>())
                    val left = AtomicInteger(dropped.size)
                    val unanswered = Collections.synchronizedSet(HashSet(dropped))
                    val replied = AtomicBoolean(false)
                    fun finish() {
                        if (!replied.compareAndSet(false, true)) return
                        if (failed.isEmpty()) response.put("result", JSONObject().put("servers", JSONArray(valid.map(::JSONObject))))
                        else response.put("error", "Removed, but the offline copy of ${failed.joinToString(", ")} could not be deleted.")
                        main.post { reply.postMessage(response.toString()) }
                    }
                    if (dropped.isEmpty()) return finish()
                    for (origin in dropped) stores.wipe(origin) { _, error ->
                        unanswered.remove(origin)
                        if (error != null) failed.add(origin)
                        if (left.decrementAndGet() == 0) finish()
                    }
                    // A store whose thread is stuck must not hold the picker: answer without it, naming it.
                    main.postDelayed({
                        failed.addAll(unanswered)
                        finish()
                    }, WIPE_TIMEOUT_MS)
                    return
                }
                else -> response.put("error", "Unknown request.")
            }
        } catch (_: Exception) {
            response.put("error", "The request failed.")
        }
        reply.postMessage(response.toString())
    }

    override fun shouldOverrideLoad(url: Uri): Boolean? =
        if (NixServers.origin(url.toString()) in NixServers.allowed(savedServers())) false else null

    /** Back to the bundled picker, from a server page's Switch server. */
    @PluginMethod
    fun showPicker(call: PluginCall) {
        activity.runOnUiThread {
            bridge.webView.loadUrl(bridge.localUrl)
            call.resolve(JSObject())
        }
    }

    /** True when the page behind the current one is a server page, not the picker. */
    fun canGoBackToServer(webView: WebView): Boolean {
        val list = webView.copyBackForwardList()
        val previous = list.getItemAtIndex(list.currentIndex - 1)?.url
        return previous != null && NixServers.origin(previous) != localOrigin
    }

    private companion object {
        const val KEY = "servers"
        const val LISTENER = "nixPickerAndroid"
        const val STORE = "nixStoreAndroid"
        const val SIGN_IN = "nixSignInAndroid"
        // No reliable signal that the tab opened (in multi-window mode the app is never paused), so a sign-in the browser never opened is given up only after a real one could have finished.
        const val LAUNCH_TIMEOUT_MS = 5 * 60_000L
        const val WIPE_TIMEOUT_MS = 15_000L
    }
}
