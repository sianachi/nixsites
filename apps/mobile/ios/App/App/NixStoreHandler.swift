import BackgroundTasks
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

    static var running: Bool { task != .invalid }

    static func set(_ running: Bool) {
        if running, task == .invalid {
            task = UIApplication.shared.beginBackgroundTask(withName: "Nix sync") { set(false) }
        } else if !running, task != .invalid {
            UIApplication.shared.endBackgroundTask(task)
            task = .invalid
            BackgroundSync.passEnded()
        }
    }
}

/// Background refresh: when iOS grants the suspended app some time, the open page is asked for one
/// sync pass and the time is handed back as soon as that pass ends. The sync itself stays in the
/// page, with the page's own session, so nothing here holds a credential or talks to a server.
// shortcut: syncs only while the app is still in memory with a signed-in page; a launch from
// terminated has no page and ends at once. Upgrade to a native sync engine if that is not enough.
@MainActor enum BackgroundSync {
    static let identifier = "app.nix.shell.sync"
    static weak var webView: WKWebView?
    private static var current: BGTask?

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            MainActor.assumeIsolated { run(task) }
        }
    }

    /// Asks for the next wake; iOS decides when, never sooner than 15 minutes.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private static func run(_ task: BGTask) {
        schedule()
        // Only a saved server's page is asked; the picker and a page mid-sign-in are left alone.
        guard let webView, let origin = NixShellPlugin.origin(webView.url),
              NixShellPlugin.savedOrigins.contains(origin) else {
            return task.setTaskCompleted(success: false)
        }
        current = task
        // iOS does not say which queue it calls this on.
        task.expirationHandler = { DispatchQueue.main.async { finish(false) } }
        webView.evaluateJavaScript("window.dispatchEvent(new Event('nix:background-sync'))") { _, _ in
            // A page with nothing to do (signed out, offline) never starts a pass: stop waiting.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                if !SyncKeepAwake.running { finish(false) }
            }
        }
    }

    static func passEnded() { finish(true) }

    private static func finish(_ success: Bool) {
        current?.setTaskCompleted(success: success)
        current = nil
    }
}
