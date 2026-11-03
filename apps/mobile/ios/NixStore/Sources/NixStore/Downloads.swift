import Foundation

/// File downloads for every store, through one delegate session. The app passes a background
/// configuration, so a download that has started finishes while the app is suspended, or after the
/// system closed it; the file lands under its key, and the next request for that key returns it
/// without downloading again. A task's description is its destination relative to the base
/// directory, so a task that outlives the process still knows where its file goes.
public final class Downloads: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let baseDir: URL
    private let queue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        return queue
    }()
    private var session: URLSession!
    private let lock = NSLock()
    private var running: [String: URLSessionDownloadTask] = [:]
    private var waiters: [Int: [CheckedContinuation<Void, Error>]] = [:]
    private var moved: Set<Int> = []
    /// Main thread only: the completion iOS hands the app when it relaunches it for background events.
    public var eventsFinished: (() -> Void)?

    init(baseDir: URL, configuration: URLSessionConfiguration) {
        self.baseDir = baseDir
        super.init()
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    }

    /// Downloads `url` to `relative` under the base directory, or joins the download already going
    /// there. Returns at once when the file is already there (a download that finished while nobody
    /// waited); the caller checks its digest either way.
    func download(_ url: URL, to relative: String) async throws {
        try await withCheckedThrowingContinuation { (waiter: CheckedContinuation<Void, Error>) in
            lock.lock()
            defer { lock.unlock() }
            if let task = running[relative] {
                waiters[task.taskIdentifier, default: []].append(waiter)
            } else if FileManager.default.fileExists(atPath: baseDir.appendingPathComponent(relative).path) {
                waiter.resume()
            } else {
                var request = URLRequest(url: url)
                request.httpShouldHandleCookies = false
                let task = session.downloadTask(with: request)
                task.taskDescription = relative
                running[relative] = task
                waiters[task.taskIdentifier] = [waiter]
                task.resume()
            }
        }
    }

    /// Cancels every download into `prefix` (one store's files directory, with its trailing slash) and
    /// waits until no completion can still be moving a file there, so a wipe that follows leaves
    /// nothing behind. Completions never create a directory, so one that arrives later finds none.
    func cancel(under prefix: String) async {
        for task in await session.allTasks where task.taskDescription?.hasPrefix(prefix) == true { task.cancel() }
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in queue.addOperation { done.resume() } }
    }

    // MARK: URLSessionDownloadDelegate (on `queue`)

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let relative = downloadTask.taskDescription,
              let http = downloadTask.response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return }
        let dest = baseDir.appendingPathComponent(relative)
        let fm = FileManager.default
        guard fm.fileExists(atPath: dest.deletingLastPathComponent().path) else { return }
        try? fm.removeItem(at: dest)
        guard (try? fm.moveItem(at: location, to: dest)) != nil else { return }
        Store.protect(dest)
        lock.withLock { _ = moved.insert(downloadTask.taskIdentifier) }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let (done, ok) = lock.withLock {
            if let relative = task.taskDescription, running[relative] === task { running[relative] = nil }
            return (waiters.removeValue(forKey: task.taskIdentifier) ?? [], moved.remove(task.taskIdentifier) != nil)
        }
        for waiter in done {
            if ok { waiter.resume() } else { waiter.resume(throwing: error ?? StoreError.io("Download failed.")) }
        }
    }

    /// Only plain https hops. A background session follows redirects by itself while the app is
    /// suspended; App Transport Security still refuses plain http there.
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(request.url?.scheme?.lowercased() == "https" ? request : nil)
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async { [self] in
            let finished = eventsFinished
            eventsFinished = nil
            finished?()
        }
    }
}
