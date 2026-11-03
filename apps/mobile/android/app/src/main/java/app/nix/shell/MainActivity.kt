package app.nix.shell

import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.OnBackPressedCallback
import androidx.core.content.ContextCompat
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(NixShellPlugin::class.java)
        super.onCreate(savedInstanceState)
        paintBackground()
        // Capacitor installs no back handling without its App plugin. Go back within the server's
        // pages, never to the picker (which would also be a dead end for Android's gesture); with
        // nothing left, send the app to the background like a launcher-started app.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val webView = bridge.webView
                val plugin = bridge.getPlugin("NixShell").instance as NixShellPlugin
                if (webView.canGoBack() && plugin.canGoBackToServer(webView)) webView.goBack()
                else moveTaskToBack(true)
            }
        })
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        paintBackground()
    }

    /** No white flash in dark mode: the WebView ground follows the system theme (values-night). */
    private fun paintBackground() {
        bridge.webView.setBackgroundColor(ContextCompat.getColor(this, R.color.nix_background))
    }
}
