import AuthenticationServices
import Capacitor
import CryptoKit
import WebKit

/// Registers the shell plugin on the bridge the scene creates.
class ShellViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NixShellPlugin())
        configureWebView()
        let controller = bridge?.webView?.configuration.userContentController
        controller?.addScriptMessageHandler(NixStoreHandler(), contentWorld: .page, name: NixStoreHandler.name)
        if let localURL = bridge?.config.localURL {
            controller?.addScriptMessageHandler(NixPickerHandler(localURL: localURL), contentWorld: .page, name: NixPickerHandler.name)
        }
    }

    /// Native feel: no link previews and no white flash in dark mode. The edge swipe stays with the
    /// page, which opens its drawers from the screen edges; back and forward are on its navbar.
    /// The form accessory bar is already hidden: @capacitor/keyboard sets it hidden at load, by
    /// swizzling the WebKit content view class, so it holds across navigations.
    private func configureWebView() {
        guard let webView = bridge?.webView else { return }
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.underPageBackgroundColor = .systemBackground
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
        CAPPluginMethod(name: "showPicker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise)
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

    // MARK: Sign-in handoff
    //
    // Passkeys do not work in the WebView for an arbitrary server domain, so sign-in runs in the
    // system's web authentication session and the page redeems a one-time code for its cookie.
    // The verifier stays in this process until it is handed back to the calling page; neither it
    // nor the code is logged.

    static let callbackScheme = "app.nix.shell"
    private var authSession: ASWebAuthenticationSession?
    private let authAnchor = AuthAnchor()

    /// The origin to sign in to, only when it is a saved server and is the page asking.
    static func signInOrigin(_ requested: String?, saved: Set<String>, page: URL?) -> String? {
        guard let origin = origin(URL(string: requested ?? "")), saved.contains(origin),
              origin == Self.origin(page) else { return nil }
        return origin
    }

    /// A same-origin path; anything else (absolute, protocol-relative, backslashes, control characters) becomes "/".
    static func safeReturnTo(_ path: String?) -> String {
        guard let path, path.hasPrefix("/"), !path.hasPrefix("//"), path.count <= 2048, !path.contains("\\"),
              !path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) else { return "/" }
        return path
    }

    static func base64URL(_ data: some DataProtocol) -> String {
        Data(data).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// 32 random bytes as 43 base64url characters, and the SHA-256 challenge sent in its place.
    static func newVerifier() -> (verifier: String, challenge: String)? {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        let verifier = base64URL(bytes)
        return (verifier, base64URL(Array(SHA256.hash(data: Data(verifier.utf8)))))
    }

    static func loginURL(origin: String, challenge: String, returnTo: String) -> URL? {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        guard let encoded = returnTo.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "\(origin)/auth/login?native=\(challenge)&returnTo=\(encoded)")
    }

    /// The code from `app.nix.shell://auth?code=...`, only for exactly that shape.
    static func handoffCode(_ url: URL?) -> String? {
        guard let url, url.scheme?.lowercased() == callbackScheme, url.host?.lowercased() == "auth",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              items.count == 1, items[0].name == "code", let code = items[0].value, !code.isEmpty else { return nil }
        return code
    }

    @objc func signIn(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [self] in
            guard let bridge, let webView = bridge.webView else { return call.reject("No bridge.") }
            guard let origin = Self.signInOrigin(call.getString("origin"), saved: Self.savedOrigins, page: webView.url),
                  authSession == nil, let pair = Self.newVerifier(),
                  let url = Self.loginURL(origin: origin, challenge: pair.challenge,
                                          returnTo: Self.safeReturnTo(call.getString("returnTo")))
            else { return call.reject("Sign-in is not available from this page.") }
            authAnchor.window = webView.window
            let finish: (URL?, Error?) -> Void = { [weak self] callback, error in
                DispatchQueue.main.async {
                    self?.authSession = nil
                    if let code = Self.handoffCode(callback) {
                        call.resolve(["code": code, "verifier": pair.verifier])
                    } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                        call.reject("Sign-in was cancelled.", "cancelled")
                    } else {
                        call.reject("Sign-in could not be completed.")
                    }
                }
            }
            let session: ASWebAuthenticationSession
            if #available(iOS 17.4, *) {
                session = ASWebAuthenticationSession(url: url, callback: .customScheme(Self.callbackScheme), completionHandler: finish)
            } else {
                session = ASWebAuthenticationSession(url: url, callbackURLScheme: Self.callbackScheme, completionHandler: finish)
            }
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = authAnchor
            authSession = session
            if !session.start() {
                authSession = nil
                call.reject("Sign-in could not be started.")
            }
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

/// Where the system sign-in sheet presents: the WebView's window.
private final class AuthAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    weak var window: UIWindow?
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { window ?? ASPresentationAnchor() }
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
