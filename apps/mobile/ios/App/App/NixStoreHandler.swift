import NixStore
import UIKit
import UserNotifications
import WebKit

/// The `nixStore` message handler: the page-side driver for the on-device mirror. The handler is
/// the security boundary, so it answers only the top frame of a saved server, and each request is
/// bound to that frame's origin; one server's page can never name another server's store.
final class NixStoreHandler: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "nixStore"
    /// A background session: a file download that has started finishes while the app is suspended.
    static let stores = Stores(downloadConfiguration: .background(withIdentifier: "app.nix.shell.files"))

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
        switch request["op"] as? String {
        case "keepAwake":
            SyncKeepAwake.set(request["running"] as? Bool == true)
            return replyHandler([:], nil)
        case "notify":
            Self.notify(title: request["title"] as? String, body: request["body"] as? String)
            return replyHandler([:], nil)
        default:
            break
        }
        Task {
            // WebKit expects the reply on the main thread.
            do {
                let reply = try await Self.stores.handle(origin: origin, request: request)
                await MainActor.run { replyHandler(reply, nil) }
            } catch {
                let message = error.localizedDescription
                await MainActor.run { replyHandler(nil, message) }
            }
        }
    }

    /// Asks for permission (iOS prompts once), then posts the message, if any. A newer message
    /// replaces the last. Shown only while the app is off screen: in the app the page says it itself.
    static func notify(title: String?, body: String?) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted, let title, let body else { return }
            let content = UNMutableNotificationContent()
            content.title = String(title.prefix(100))
            content.body = String(body.prefix(300))
            center.add(UNNotificationRequest(identifier: "nix.sync", content: content, trigger: nil))
        }
    }
}

/// While the page's sync pass runs, a background task keeps the app going for the short time iOS
/// allows once it leaves the screen (about 30 seconds), so the pass can finish rather than freeze.
@MainActor enum SyncKeepAwake {
    private static var task = UIBackgroundTaskIdentifier.invalid

    static func set(_ running: Bool) {
        if running, task == .invalid {
            task = UIApplication.shared.beginBackgroundTask(withName: "Nix sync") { set(false) }
        } else if !running, task != .invalid {
            UIApplication.shared.endBackgroundTask(task)
            task = .invalid
        }
    }
}
