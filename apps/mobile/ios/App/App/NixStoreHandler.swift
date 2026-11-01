import NixStore
import WebKit

/// The `nixStore` message handler: the page-side driver for the on-device mirror. The handler is
/// the security boundary, so it answers only the top frame of a saved server, and each request is
/// bound to that frame's origin; one server's page can never name another server's store.
final class NixStoreHandler: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "nixStore"
    static let stores = Stores()

    /// `scheme://host[:port]` of a frame, lowercase, default ports omitted.
    static func origin(of origin: WKSecurityOrigin) -> String? {
        let isDefault = origin.port == 0 || (origin.protocol == "https" && origin.port == 443) || (origin.protocol == "http" && origin.port == 80)
        let authority = isDefault ? origin.host : "\(origin.host):\(origin.port)"
        return NixShellPlugin.origin(URL(string: "\(origin.protocol)://\(authority)"))
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame,
              let origin = Self.origin(of: message.frameInfo.securityOrigin),
              NixShellPlugin.savedOrigins.contains(origin),
              let request = message.body as? [String: Any] else {
            replyHandler(nil, "Not allowed.")
            return
        }
        Task {
            do {
                replyHandler(try await Self.stores.handle(origin: origin, request: request), nil)
            } catch {
                replyHandler(nil, error.localizedDescription)
            }
        }
    }
}
