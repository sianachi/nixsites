import CryptoKit
import Foundation
import SQLite3

private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Pragmas the page's SQL may run (packages/sync-sqlite opens with these); every other pragma is
/// refused, as are ATTACH/DETACH (another origin's database is a file next to this one) and raw
/// transaction statements (the store's begin/commit gate owns transactions).
private let pagePragmas: Set<String> = ["foreign_keys", "journal_mode", "synchronous", "secure_delete"]

/// Set while the page's SQL is being prepared; the store's own statements run with it unset.
final class PageGate { var active = false }

private let authorize: @convention(c) (UnsafeMutableRawPointer?, Int32, UnsafePointer<CChar>?, UnsafePointer<CChar>?,
                                       UnsafePointer<CChar>?, UnsafePointer<CChar>?) -> Int32 = { context, action, first, _, _, _ in
    guard let context, Unmanaged<PageGate>.fromOpaque(context).takeUnretainedValue().active else { return SQLITE_OK }
    switch action {
    case SQLITE_ATTACH, SQLITE_DETACH, SQLITE_TRANSACTION, SQLITE_SAVEPOINT:
        return SQLITE_DENY
    case SQLITE_PRAGMA:
        return pagePragmas.contains(first.map { String(cString: $0).lowercased() } ?? "") ? SQLITE_OK : SQLITE_DENY
    default:
        return SQLITE_OK
    }
}

func sha256Hex(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}

/// One origin's database and files. An actor, so statements never interleave; the transaction
/// gate below decides which callers may run while a transaction is open.
public actor Store {
    let dbURL: URL
    let filesURL: URL
    private let idleTimeout: TimeInterval
    private let downloadConfiguration: () -> URLSessionConfiguration
    private var db: OpaquePointer?
    private let pageGate = PageGate()

    private var activeTx: String?
    private var txGeneration = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init(origin: String, baseDir: URL, idleTimeout: TimeInterval = 30,
                downloadConfiguration: @escaping () -> URLSessionConfiguration = { .ephemeral }) {
        let id = sha256Hex(origin)
        dbURL = baseDir.appendingPathComponent("\(id).sqlite")
        filesURL = baseDir.appendingPathComponent("\(id)-files", isDirectory: true)
        self.idleTimeout = idleTimeout
        self.downloadConfiguration = downloadConfiguration
    }

    // MARK: database

    private func open() throws -> OpaquePointer {
        if let db { return db }
        try Self.prepareDirectory(dbURL.deletingLastPathComponent())
        var handle: OpaquePointer?
        guard sqlite3_open_v2(dbURL.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            sqlite3_close(handle)
            throw StoreError.sqlite(message)
        }
        db = handle
        sqlite3_limit(handle, SQLITE_LIMIT_ATTACHED, 0)
        sqlite3_set_authorizer(handle, authorize, Unmanaged.passUnretained(pageGate).toOpaque())
        do {
            try run("PRAGMA journal_mode = WAL", on: handle)
            try run("PRAGMA foreign_keys = ON", on: handle)
        } catch {
            sqlite3_close(handle)
            db = nil
            throw error
        }
        Self.protect(dbURL)
        return handle
    }

    private func run(_ sql: String, on handle: OpaquePointer) throws {
        if sqlite3_exec(handle, sql, nil, nil, nil) != SQLITE_OK { throw StoreError.sqlite(String(cString: sqlite3_errmsg(handle))) }
    }

    /// Runs `sql` (possibly several statements; each takes the next `params` it needs) and returns
    /// the rows of the last statement that produced any.
    private func query(_ sql: String, _ params: [Value]) throws -> [Row] {
        let handle = try open()
        var rows: [Row] = []
        var used = 0
        var tail = sql
        while !tail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            var stmt: OpaquePointer?
            var rest: UnsafePointer<CChar>?
            pageGate.active = true
            defer { pageGate.active = false }
            let rc = tail.withCString { c -> Int32 in
                let r = sqlite3_prepare_v2(handle, c, -1, &stmt, &rest)
                if let rest { tail = String(cString: rest) } else { tail = "" }
                return r
            }
            guard rc == SQLITE_OK else { throw StoreError.sqlite(String(cString: sqlite3_errmsg(handle))) }
            guard let stmt else { continue }
            defer { sqlite3_finalize(stmt) }
            let count = Int(sqlite3_bind_parameter_count(stmt))
            guard used + count <= params.count else { throw StoreError.invalid("Too few parameters.") }
            for i in 0..<count { try bind(params[used + i], at: Int32(i + 1), in: stmt, handle) }
            used += count
            var current: [Row] = []
            while true {
                let step = sqlite3_step(stmt)
                if step == SQLITE_DONE { break }
                guard step == SQLITE_ROW else { throw StoreError.sqlite(String(cString: sqlite3_errmsg(handle))) }
                var row: Row = [:]
                for c in 0..<sqlite3_column_count(stmt) {
                    row[String(cString: sqlite3_column_name(stmt, c))] = Self.column(stmt, c)
                }
                current.append(row)
            }
            if sqlite3_column_count(stmt) > 0 { rows = current }
        }
        guard used == params.count else { throw StoreError.invalid("Too many parameters.") }
        return rows
    }

    private func bind(_ v: Value, at i: Int32, in stmt: OpaquePointer, _ handle: OpaquePointer) throws {
        let rc: Int32
        switch v {
        case .null: rc = sqlite3_bind_null(stmt, i)
        case .int(let n): rc = sqlite3_bind_int64(stmt, i, n)
        case .double(let d): rc = sqlite3_bind_double(stmt, i, d)
        case .text(let s): rc = sqlite3_bind_text(stmt, i, s, -1, transient)
        case .blob(let d): rc = d.withUnsafeBytes { sqlite3_bind_blob(stmt, i, $0.baseAddress, Int32(d.count), transient) }
        }
        if rc != SQLITE_OK { throw StoreError.sqlite(String(cString: sqlite3_errmsg(handle))) }
    }

    private static func column(_ stmt: OpaquePointer, _ c: Int32) -> Value {
        switch sqlite3_column_type(stmt, c) {
        case SQLITE_INTEGER: return .int(sqlite3_column_int64(stmt, c))
        case SQLITE_FLOAT: return .double(sqlite3_column_double(stmt, c))
        case SQLITE_TEXT: return .text(String(cString: sqlite3_column_text(stmt, c)))
        case SQLITE_BLOB:
            let n = Int(sqlite3_column_bytes(stmt, c))
            return .blob(n == 0 ? Data() : Data(bytes: sqlite3_column_blob(stmt, c), count: n))
        default: return .null
        }
    }

    // MARK: transactions

    /// Waits while a transaction is open. Resumed in arrival order; each caller re-checks.
    private func awaitGateFree() async {
        while activeTx != nil { await withCheckedContinuation { waiters.append($0) } }
    }

    private func releaseGate() {
        activeTx = nil
        txGeneration += 1
        let pending = waiters
        waiters = []
        pending.forEach { $0.resume() }
    }

    public func begin() async throws -> String {
        await awaitGateFree()
        let handle = try open()
        try run("BEGIN IMMEDIATE", on: handle)
        let id = UUID().uuidString
        activeTx = id
        armIdleTimer()
        return id
    }

    private func armIdleTimer() {
        txGeneration += 1
        let generation = txGeneration
        let nanos = UInt64(idleTimeout * 1_000_000_000)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: nanos)
            await self?.expire(generation)
        }
    }

    private func expire(_ generation: Int) {
        guard activeTx != nil, generation == txGeneration else { return }
        if let db { try? run("ROLLBACK", on: db) }
        releaseGate()
    }

    private func requireTx(_ tx: String) throws {
        guard tx == activeTx else { throw StoreError.transaction("Transaction is not open (it may have timed out).") }
    }

    public func commit(_ tx: String) throws {
        try requireTx(tx)
        defer { releaseGate() }
        do { try run("COMMIT", on: try open()) } catch {
            if let db { try? run("ROLLBACK", on: db) }
            throw error
        }
    }

    public func rollback(_ tx: String) throws {
        try requireTx(tx)
        defer { releaseGate() }
        try run("ROLLBACK", on: try open())
    }

    public func execute(_ sql: String, _ params: [Value] = [], tx: String? = nil) async throws -> [Row] {
        if let tx {
            try requireTx(tx)
            armIdleTimer()
        } else {
            await awaitGateFree()
        }
        return try query(sql, params)
    }

    /// Each statement once per parameter row, all in one transaction; any failure rolls back all.
    public func batch(_ statements: [(sql: String, params: [[Value]])]) async throws {
        let tx = try await begin()
        do {
            for s in statements { for row in s.params { _ = try await execute(s.sql, row, tx: tx) } }
            try commit(tx)
        } catch {
            try? rollback(tx)
            throw error
        }
    }

    // MARK: files

    private func fileURL(_ key: String) -> URL { filesURL.appendingPathComponent(sha256Hex(key)) }

    public func fileGet(_ key: String) throws -> Data? {
        try? Data(contentsOf: fileURL(key))
    }

    public func filePut(_ key: String, data: Data) throws {
        try Self.prepareDirectory(filesURL)
        try data.write(to: fileURL(key), options: .atomic)
        Self.protect(fileURL(key))
    }

    public func fileDelete(_ key: String) throws {
        try? FileManager.default.removeItem(at: fileURL(key))
    }

    /// GET an object-store capability URL. Ephemeral session: no cookies, no credentials, and no
    /// Core token is ever attached. Redirects off https are refused. Returns the stored size and the
    /// hex SHA-256 of the stored file, read back in chunks so the page can verify the bytes.
    public func fileDownload(key: String, url: URL) async throws -> (bytes: Int64, sha256: String) {
        guard url.scheme?.lowercased() == "https", url.host != nil else { throw StoreError.invalid("Downloads must use https.") }
        let configuration = downloadConfiguration()
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        let (temp, response) = try await session.download(for: request, delegate: HTTPSOnlyRedirects())
        defer { try? FileManager.default.removeItem(at: temp) }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw StoreError.io("Download failed.")
        }
        try Self.prepareDirectory(filesURL)
        let dest = fileURL(key)
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: temp, to: dest)
        Self.protect(dest)
        let size = (try? FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? Int64) ?? 0
        return (size, try Self.fileSha256Hex(dest))
    }

    private static func fileSha256Hex(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // MARK: usage and wipe

    public func usage() -> (databaseBytes: Int64, fileBytes: Int64) {
        let fm = FileManager.default
        func size(_ url: URL) -> Int64 { ((try? fm.attributesOfItem(atPath: url.path)[.size]) as? Int64) ?? 0 }
        let database = ["", "-wal", "-shm"].reduce(Int64(0)) { $0 + size(URL(fileURLWithPath: dbURL.path + $1)) }
        let files = (try? fm.contentsOfDirectory(at: filesURL, includingPropertiesForKeys: nil)) ?? []
        return (database, files.reduce(0) { $0 + size($1) })
    }

    /// Closes the database and deletes it and the files. Throws if anything remains, so the caller
    /// can keep admission closed.
    public func wipe() throws {
        if activeTx != nil, let db { try? run("ROLLBACK", on: db) }
        if let db { sqlite3_close(db); self.db = nil }
        releaseGate()
        let fm = FileManager.default
        for url in ["", "-wal", "-shm", "-journal"].map({ URL(fileURLWithPath: dbURL.path + $0) }) + [filesURL]
        where fm.fileExists(atPath: url.path) {
            do { try fm.removeItem(at: url) } catch { throw StoreError.io("Could not delete local data.") }
        }
    }

    // MARK: protection

    /// Creates `dir` (the `nix-store` base, or a files dir inside it) and keeps the base out of backups.
    static func prepareDirectory(_ dir: URL) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var base = dir
        if dir.lastPathComponent.hasSuffix("-files") { base = dir.deletingLastPathComponent() }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try base.setResourceValues(values)
        protect(dir)
    }

    static func protect(_ url: URL) {
        #if os(iOS)
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        #endif
    }
}

private final class HTTPSOnlyRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        request.url?.scheme?.lowercased() == "https" ? request : nil
    }
}
