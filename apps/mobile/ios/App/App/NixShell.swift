import Capacitor
import WebKit

/// Registers the shell plugin on the bridge the scene creates.
class ShellViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NixShellPlugin())
        let controller = bridge?.webView?.configuration.userContentController
        controller?.addScriptMessageHandler(NixStoreHandler(), contentWorld: .page, name: NixStoreHandler.name)
        if let localURL = bridge?.config.localURL {
            controller?.addScriptMessageHandler(NixPickerHandler(localURL: localURL), contentWorld: .page, name: NixPickerHandler.name)
        }
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
        CAPPluginMethod(name: "showPicker", returnType: CAPPluginReturnPromise)
    ]

    static let key = "nix.servers"
    /// Written into Info.generated.plist by scripts/app-bound-domains.mjs; empty when the build has none.
    static let boundDomains = Bundle.main.object(forInfoDictionaryKey: "WKAppBoundDomains") as? [String] ?? []

    /// `https://host[:port]`, or plain http for `localhost` only (a dev stack seen from the simulator).
    static func origin(_ url: URL?) -> String? {
        guard let url, let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty,
              url.user == nil, url.password == nil,
              scheme == "https" || (scheme == "http" && host == "localhost") else { return nil }
        // Default ports are dropped, as browsers and NixStoreHandler.origin(of:) do, so both agree.
        let port = url.port.flatMap { ($0 == 443 && scheme == "https") || ($0 == 80 && scheme == "http") ? nil : $0 }
        return port.map { "\(scheme)://\(host):\($0)" } ?? "\(scheme)://\(host)"
    }

    private var servers: [[String: String]] { Self.savedServers }

    static var savedServers: [[String: String]] {
        UserDefaults.standard.array(forKey: key) as? [[String: String]] ?? []
    }

    /// The servers' own origins (not their sign-in origins): the only ones whose pages get a store.
    static var savedOrigins: Set<String> { Set(savedServers.compactMap { $0["origin"] }) }

    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard navigationAction.targetFrame?.isMainFrame == true,
              let origin = Self.origin(navigationAction.request.url) else { return nil }
        let allowed = servers.flatMap { [$0["origin"], $0["loginOrigin"]].compactMap { $0 } }
        return allowed.contains(origin) ? false : nil
    }

    @objc func showPicker(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [self] in
            guard let bridge else { return call.reject("No bridge.") }
            bridge.webView?.load(URLRequest(url: bridge.config.localURL))
            call.resolve()
        }
    }
}

/// The picker's channel for reading and changing the saved servers. A message handler, not a plugin
/// method, so the check uses the sending frame's own origin: `webView.url` already reports a pending
/// navigation, so a server page could call showPicker and then change the list before it loads.
/// Only the bundled picker may change the list, since it is the navigation allowlist above and the
/// set of origins that get a store.
final class NixPickerHandler: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "nixPicker"
    private let localURL: URL

    init(localURL: URL) { self.localURL = localURL }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let frame = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, frame.protocol == localURL.scheme, frame.host == localURL.host,
              let body = message.body as? [String: Any] else {
            return replyHandler(nil, "Servers can only be changed from the server picker.")
        }
        switch body["op"] as? String {
        case "getServers":
            replyHandler(["servers": NixShellPlugin.savedServers, "boundDomains": NixShellPlugin.boundDomains], nil)
        case "setServers":
            let entries = (body["servers"] as? [[String: Any]] ?? []).compactMap { entry -> [String: String]? in
                guard let origin = NixShellPlugin.origin(URL(string: entry["origin"] as? String ?? "")) else { return nil }
                var saved = ["origin": origin]
                saved["loginOrigin"] = NixShellPlugin.origin(URL(string: entry["loginOrigin"] as? String ?? ""))
                return saved
            }
            let dropped = NixShellPlugin.savedOrigins.subtracting(entries.compactMap { $0["origin"] })
            UserDefaults.standard.set(entries, forKey: NixShellPlugin.key)
            Task { @MainActor in
                // A removed server's offline copy goes with it; say so if any of it stays behind.
                var failed: [String] = []
                for origin in dropped {
                    do { try await NixStoreHandler.stores.wipe(origin: origin) } catch { failed.append(origin) }
                }
                if failed.isEmpty {
                    replyHandler(["servers": entries], nil)
                } else {
                    replyHandler(nil, "Removed, but the offline copy of \(failed.joined(separator: ", ")) could not be deleted.")
                }
            }
        default:
            replyHandler(nil, "Unknown request.")
        }
    }
}
