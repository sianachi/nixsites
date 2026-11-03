package app.nix.shell

import android.content.Context
import android.net.Uri
import android.webkit.WebView
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
import java.net.URI

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

    override fun load() {
        // Registered before the first page loads, restricted to the bundled picker's origin.
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        val local = localOrigin ?: return
        WebViewCompat.addWebMessageListener(bridge.webView, LISTENER, setOf(local)) { _, message, sourceOrigin, isMainFrame, reply ->
            // The sender's origin comes from WebView, never from the message body.
            if (isMainFrame && NixServers.origin(sourceOrigin.toString()) == local) handle(message, reply)
        }
    }

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
                    prefs.edit().putString(KEY, JSONArray(valid.map(::JSONObject)).toString()).apply()
                    response.put("result", JSONObject().put("servers", JSONArray(valid.map(::JSONObject))))
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
    }
}
