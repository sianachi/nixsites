import Capacitor
import WebKit

/// Registers the shell plugin on the bridge the scene creates.
class ShellViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NixShellPlugin())
    }

    /// WebKit runs service workers (the web app's offline shell) only for app-bound domains, and
    /// only when navigation is limited to them; a build without a list opens any server online.
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        configuration.limitsNavigationsToAppBoundDomains = !NixShellPlugin.boundDomains.isEmpty
        return configuration
    }
}

/// The saved Nix servers, and the rule for which pages may load in the WebView.
///
/// Every page that loads in the WebView gets Capacitor's bridge, and the bridge's native HTTP
/// plugin sends the WebView's cookies (HttpOnly session included) without CORS. So only the saved
/// servers and the sign-in origin each one redirects to may load here; any other top-level page
/// falls through to Capacitor's default and opens in Safari.
@objc(NixShellPlugin)
public class NixShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NixShellPlugin"
    public let jsName = "NixShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getServers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setServers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showPicker", returnType: CAPPluginReturnPromise)
    ]

    private static let key = "nix.servers"
    /// Written into Info.generated.plist by scripts/app-bound-domains.mjs; empty when the build has none.
    static let boundDomains = Bundle.main.object(forInfoDictionaryKey: "WKAppBoundDomains") as? [String] ?? []

    /// `https://host[:port]`, or plain http for `localhost` only (a dev stack seen from the simulator).
    static func origin(_ url: URL?) -> String? {
        guard let url, let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty,
              url.user == nil, url.password == nil,
              scheme == "https" || (scheme == "http" && host == "localhost") else { return nil }
        return url.port.map { "\(scheme)://\(host):\($0)" } ?? "\(scheme)://\(host)"
    }

    private var servers: [[String: String]] {
        UserDefaults.standard.array(forKey: Self.key) as? [[String: String]] ?? []
    }

    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard navigationAction.targetFrame?.isMainFrame == true,
              let origin = Self.origin(navigationAction.request.url) else { return nil }
        let allowed = servers.flatMap { [$0["origin"], $0["loginOrigin"]].compactMap { $0 } }
        return allowed.contains(origin) ? false : nil
    }

    @objc func getServers(_ call: CAPPluginCall) {
        call.resolve(["servers": servers, "boundDomains": Self.boundDomains])
    }

    /// Only the bundled picker may change the list: a server page that could would widen the
    /// allowlist above to any origin it liked.
    @objc func setServers(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [self] in
            guard let bridge, bridge.webView?.url?.scheme == bridge.config.localURL.scheme else {
                call.reject("Servers can only be changed from the server picker.")
                return
            }
            let entries = (call.getArray("servers") as? [[String: Any]] ?? []).compactMap { entry -> [String: String]? in
                guard let origin = Self.origin(URL(string: entry["origin"] as? String ?? "")) else { return nil }
                var saved = ["origin": origin]
                saved["loginOrigin"] = Self.origin(URL(string: entry["loginOrigin"] as? String ?? ""))
                return saved
            }
            UserDefaults.standard.set(entries, forKey: Self.key)
            call.resolve(["servers": entries])
        }
    }

    @objc func showPicker(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [self] in
            guard let bridge else { return call.reject("No bridge.") }
            bridge.webView?.load(URLRequest(url: bridge.config.localURL))
            call.resolve()
        }
    }
}
