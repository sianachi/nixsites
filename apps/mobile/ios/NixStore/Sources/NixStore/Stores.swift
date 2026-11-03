import Foundation

/// The per-origin stores and the `nixStore` request dispatcher (see docs/plans/full-sync.md).
/// The caller has already bound `origin` to the frame that sent the request.
public actor Stores {
    public let baseDir: URL
    private let idleTimeout: TimeInterval
    /// Shared by every store; the app hands it the completion for background download events.
    public nonisolated let downloads: Downloads
    private var stores: [String: Store] = [:]

    public init(baseDir: URL? = nil, idleTimeout: TimeInterval = 30,
                downloadConfiguration: URLSessionConfiguration = .ephemeral) {
        let baseDir = baseDir ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("nix-store", isDirectory: true)
        self.baseDir = baseDir
        self.idleTimeout = idleTimeout
        downloads = Downloads(baseDir: baseDir, configuration: downloadConfiguration)
    }

    func store(_ origin: String) -> Store {
        if let s = stores[origin] { return s }
        let s = Store(origin: origin, baseDir: baseDir, idleTimeout: idleTimeout, downloads: downloads)
        stores[origin] = s
        return s
    }

    public func wipe(origin: String) async throws {
        try await store(origin).wipe()
    }

    public func handle(origin: String, request: [String: Any]) async throws -> [String: Any] {
        let s = store(origin)
        func string(_ k: String) throws -> String {
            guard let v = request[k] as? String, !v.isEmpty else { throw StoreError.invalid("Missing \(k).") }
            return v
        }
        func values(_ any: Any?) throws -> [Value] {
            guard let list = (any ?? [Any]()) as? [Any] else { throw StoreError.invalid("params must be an array.") }
            return try list.map(Value.init(json:))
        }
        switch try string("op") {
        case "begin":
            return ["tx": try await s.begin()]
        case "execute":
            let rows = try await s.execute(try string("sql"), try values(request["params"]), tx: request["tx"] as? String)
            return ["rows": rows.map { $0.mapValues(\.json) }]
        case "commit":
            try await s.commit(try string("tx")); return [:]
        case "rollback":
            try await s.rollback(try string("tx")); return [:]
        case "batch":
            guard let list = request["statements"] as? [[String: Any]] else { throw StoreError.invalid("Missing statements.") }
            let statements = try list.map { item -> (sql: String, params: [[Value]]) in
                guard let sql = item["sql"] as? String, let rows = item["params"] as? [Any] else { throw StoreError.invalid("Bad statement.") }
                return (sql, try rows.map { try values($0) })
            }
            try await s.batch(statements); return [:]
        case "fileDownload":
            guard let url = URL(string: try string("url")) else { throw StoreError.invalid("Bad url.") }
            let stored = try await s.fileDownload(key: try string("key"), url: url)
            return ["bytes": stored.bytes, "sha256": stored.sha256]
        case "fileGet":
            return ["data": try await s.fileGet(try string("key"))?.base64EncodedString() as Any? ?? NSNull()]
        case "fileDelete":
            try await s.fileDelete(try string("key")); return [:]
        case "usage":
            let u = await s.usage()
            return ["databaseBytes": u.databaseBytes, "fileBytes": u.fileBytes]
        case "wipe":
            try await s.wipe(); return [:]
        default:
            throw StoreError.invalid("Unknown op.")
        }
    }
}
