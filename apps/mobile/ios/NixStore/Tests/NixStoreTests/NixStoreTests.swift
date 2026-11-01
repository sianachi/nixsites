import Foundation
import XCTest
@testable import NixStore

final class NixStoreTests: XCTestCase {
    var dir: URL!

    override func setUp() {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("nix-store-test-\(UUID().uuidString)")
    }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    func call(_ stores: Stores, _ origin: String, _ request: [String: Any]) async throws -> [String: Any] {
        try await stores.handle(origin: origin, request: request)
    }
    func call(_ stores: Stores, _ request: [String: Any]) async throws -> [String: Any] {
        try await call(stores, "https://a.example", request)
    }

    func testValueRoundTripIncludingBlobs() async throws {
        let stores = Stores(baseDir: dir)
        _ = try await call(stores, ["op": "execute", "sql": "CREATE TABLE t(a, b, c, d, e)"])
        let blob = Data([0, 1, 2, 255])
        _ = try await call(stores, ["op": "execute", "sql": "INSERT INTO t VALUES (?,?,?,?,?)",
                                    "params": [NSNull(), 42, 1.5, "héllo", ["$b64": blob.base64EncodedString()]]])
        let rows = try await call(stores, ["op": "execute", "sql": "SELECT * FROM t"])["rows"] as! [[String: Any]]
        XCTAssertEqual(rows.count, 1)
        XCTAssertTrue(rows[0]["a"] is NSNull)
        XCTAssertEqual(rows[0]["b"] as? Int64, 42)
        XCTAssertEqual(rows[0]["c"] as? Double, 1.5)
        XCTAssertEqual(rows[0]["d"] as? String, "héllo")
        XCTAssertEqual((rows[0]["e"] as? [String: String])?["$b64"], blob.base64EncodedString())
    }

    func testTransactionCommitRollbackAndWrongId() async throws {
        let s = Store(origin: "https://a.example", baseDir: dir)
        _ = try await s.execute("CREATE TABLE t(a)")
        let tx = try await s.begin()
        _ = try await s.execute("INSERT INTO t VALUES (1)", tx: tx)
        try await s.rollback(tx)
        let n = try await s.execute("SELECT count(*) AS n FROM t")
        XCTAssertEqual(n[0]["n"], .int(0))
        do { _ = try await s.execute("SELECT 1", tx: tx); XCTFail("stale tx accepted") } catch {}
        let tx2 = try await s.begin()
        _ = try await s.execute("INSERT INTO t VALUES (2)", tx: tx2)
        try await s.commit(tx2)
        let m = try await s.execute("SELECT count(*) AS n FROM t")
        XCTAssertEqual(m[0]["n"], .int(1))
    }

    func testRequestsWithoutTxWaitInOrder() async throws {
        let s = Store(origin: "https://a.example", baseDir: dir)
        _ = try await s.execute("CREATE TABLE t(a)")
        let tx = try await s.begin()
        let order = Order()
        let second = Task { // queued behind the open transaction
            try await s.begin().tap { await order.add("begin2"); try await s.commit($0) }
        }
        let reader = Task {
            let rows = try await s.execute("SELECT count(*) AS n FROM t")
            await order.add("read")
            return rows
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        let early = await order.items
        XCTAssertEqual(early, [])
        _ = try await s.execute("INSERT INTO t VALUES (1)", tx: tx)
        try await s.commit(tx)
        _ = try await second.value
        let rows = try await reader.value
        XCTAssertEqual(rows[0]["n"], .int(1)) // saw the committed row, never the open tx's state early
        let done = await order.items
        XCTAssertEqual(Set(done), ["begin2", "read"])
    }

    func testIdleTransactionRollsBackAndIdIsRefused() async throws {
        let s = Store(origin: "https://a.example", baseDir: dir, idleTimeout: 0.2)
        _ = try await s.execute("CREATE TABLE t(a)")
        let tx = try await s.begin()
        _ = try await s.execute("INSERT INTO t VALUES (1)", tx: tx)
        let rows = try await s.execute("SELECT count(*) AS n FROM t") // waits for the timeout
        XCTAssertEqual(rows[0]["n"], .int(0))
        do { try await s.commit(tx); XCTFail("commit after timeout") } catch {}
    }

    func testBatchIsAtomic() async throws {
        let s = Store(origin: "https://a.example", baseDir: dir)
        _ = try await s.execute("CREATE TABLE t(a INTEGER PRIMARY KEY)")
        try await s.batch([("INSERT INTO t VALUES (?)", [[.int(1)], [.int(2)]])])
        do {
            try await s.batch([("INSERT INTO t VALUES (?)", [[.int(3)], [.int(1)]])]) // duplicate key
            XCTFail("expected failure")
        } catch {}
        let rows = try await s.execute("SELECT count(*) AS n FROM t")
        XCTAssertEqual(rows[0]["n"], .int(2))
        let tx = try await s.begin() // the gate was released
        try await s.rollback(tx)
    }

    func testOriginsAreIsolated() async throws {
        let stores = Stores(baseDir: dir)
        _ = try await call(stores, "https://a.example", ["op": "execute", "sql": "CREATE TABLE t(a)"])
        _ = try await call(stores, "https://a.example", ["op": "execute", "sql": "INSERT INTO t VALUES (1)"])
        do {
            _ = try await call(stores, "https://b.example", ["op": "execute", "sql": "SELECT * FROM t"])
            XCTFail("b saw a's table")
        } catch {}
        try await stores.wipe(origin: "https://b.example")
        let rows = try await call(stores, "https://a.example", ["op": "execute", "sql": "SELECT * FROM t"])["rows"] as! [Any]
        XCTAssertEqual(rows.count, 1)
    }

    func testPageSqlCannotReachOtherFilesOrTheTransactionGate() async throws {
        let stores = Stores(baseDir: dir)
        _ = try await call(stores, "https://b.example", ["op": "execute", "sql": "CREATE TABLE secret(a); INSERT INTO secret VALUES ('b')"])
        let other = dir.appendingPathComponent("\(sha256Hex("https://b.example")).sqlite").path
        let refused = [
            "ATTACH '\(other)' AS v",
            "VACUUM INTO '\(dir.appendingPathComponent("copy.sqlite").path)'",
            "PRAGMA database_list",
            "PRAGMA writable_schema = ON",
            "BEGIN",
            "SAVEPOINT s",
        ]
        for sql in refused {
            do {
                _ = try await call(stores, "https://a.example", ["op": "execute", "sql": sql])
                XCTFail("allowed: \(sql)")
            } catch {}
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("copy.sqlite").path))
        for sql in ["PRAGMA foreign_keys=ON", "PRAGMA journal_mode=WAL", "PRAGMA synchronous=FULL", "PRAGMA secure_delete=ON"] {
            _ = try await call(stores, "https://a.example", ["op": "execute", "sql": sql])
        }
        // The store's own transactions still work.
        let tx = try await call(stores, "https://a.example", ["op": "begin"])["tx"] as! String
        _ = try await call(stores, "https://a.example", ["op": "execute", "sql": "CREATE TABLE t(a)", "tx": tx])
        _ = try await call(stores, "https://a.example", ["op": "commit", "tx": tx])
    }

    func testFilesUsageAndWipe() async throws {
        let stores = Stores(baseDir: dir)
        let s = await stores.store("https://a.example")
        _ = try await call(stores, ["op": "execute", "sql": "CREATE TABLE t(a)"])
        try await s.filePut("../weird/key", data: Data(repeating: 7, count: 1000))
        let got = try await call(stores, ["op": "fileGet", "key": "../weird/key"])
        XCTAssertEqual(Data(base64Encoded: got["data"] as! String)?.count, 1000)
        let missing = try await call(stores, ["op": "fileGet", "key": "nope"])
        XCTAssertTrue(missing["data"] is NSNull)
        let u = try await call(stores, ["op": "usage"])
        XCTAssertEqual(u["fileBytes"] as? Int64, 1000)
        XCTAssertGreaterThan(u["databaseBytes"] as! Int64, 0)
        _ = try await call(stores, ["op": "fileDelete", "key": "../weird/key"])
        let after = try await call(stores, ["op": "usage"])
        XCTAssertEqual(after["fileBytes"] as? Int64, 0)
        try await s.filePut("k", data: Data([1]))
        _ = try await call(stores, ["op": "wipe"])
        let left = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        XCTAssertEqual(left, [])
    }

    func testDownloadRefusesNonHttps() async throws {
        let stores = Stores(baseDir: dir)
        do {
            _ = try await call(stores, ["op": "fileDownload", "key": "k", "url": "http://example.com/x"])
            XCTFail("http accepted")
        } catch {}
    }

    func testDownloadStreamsToFileWithoutCredentials() async throws {
        StubProtocol.seen = nil
        let stores = Stores(baseDir: dir, downloadConfiguration: {
            let c = URLSessionConfiguration.ephemeral
            c.protocolClasses = [StubProtocol.self]
            return c
        })
        let r = try await call(stores, ["op": "fileDownload", "key": "k", "url": "https://cdn.example/obj?sig=1"])
        XCTAssertEqual(r["bytes"] as? Int64, 5)
        // SHA-256 of "hello".
        XCTAssertEqual(r["sha256"] as? String, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
        XCTAssertNil(StubProtocol.seen?.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(StubProtocol.seen?.value(forHTTPHeaderField: "Cookie"))
        let got = try await call(stores, ["op": "fileGet", "key": "k"])
        XCTAssertEqual(Data(base64Encoded: got["data"] as! String), Data("hello".utf8))
    }

    func testUnknownOpAndBadParams() async throws {
        let stores = Stores(baseDir: dir)
        do { _ = try await call(stores, ["op": "nope"]); XCTFail() } catch {}
        do { _ = try await call(stores, ["op": "execute", "sql": "SELECT ?"]); XCTFail() } catch {}
    }
}

actor Order { var items: [String] = []; func add(_ s: String) { items.append(s) } }
extension String { func tap(_ f: (String) async throws -> Void) async throws -> String { try await f(self); return self } }

final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var seen: URLRequest?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.seen = request
        let r = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("hello".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
