package app.nix.shell

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// Needs a device or emulator (SQLite is not in the JVM unit tests): ./gradlew connectedDebugAndroidTest.
// Ports apps/mobile/ios/NixStore/Tests/NixStoreTests; the statement rules without SQLite are in NixStoreRulesTest.
@RunWith(AndroidJUnit4::class)
class NixStoreInstrumentedTest {
    private lateinit var dir: File
    private lateinit var stores: NixStores
    private val a = "https://a.example"
    private val b = "https://b.example"

    @Before fun setUp() {
        dir = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "store-test-${System.nanoTime()}")
        stores = NixStores(dir, idleMs = 300)
    }

    @After fun tearDown() {
        dir.deleteRecursively()
    }

    private fun send(origin: String, request: JSONObject): Pair<JSONObject?, String?> {
        val latch = CountDownLatch(1)
        var out: Pair<JSONObject?, String?> = null to "no reply"
        stores.handle(origin, request) { result, error -> out = result to error; latch.countDown() }
        assertTrue("timed out: $request", latch.await(20, TimeUnit.SECONDS))
        return out
    }

    private fun call(origin: String, request: JSONObject) = send(origin, request).also { assertEquals(null, it.second) }.first!!

    private fun sql(origin: String, text: String, vararg params: Any?, tx: String? = null): JSONObject =
        call(origin, JSONObject().put("op", "execute").put("sql", text).put("params", JSONArray(params.toList())).also { if (tx != null) it.put("tx", tx) })

    private fun refused(origin: String, text: String) {
        val (_, error) = send(origin, JSONObject().put("op", "execute").put("sql", text))
        assertNotNull("allowed: $text", error)
    }

    private fun rows(result: JSONObject) = result.getJSONArray("rows")

    @Test fun valuesRoundTripIncludingBlobs() {
        sql(a, "CREATE TABLE t(i INTEGER, f REAL, s TEXT, b BLOB, n)")
        sql(a, "INSERT INTO t VALUES (?,?,?,?,?)", 42, 1.5, "héllo", JSONObject().put("\$b64", "AAEC/w=="), JSONObject.NULL)
        val row = rows(sql(a, "SELECT * FROM t")).getJSONObject(0)
        assertEquals(42, row.getLong("i"))
        assertEquals(1.5, row.getDouble("f"), 0.0)
        assertEquals("héllo", row.getString("s"))
        assertEquals("AAEC/w==", row.getJSONObject("b").getString("\$b64"))
        assertTrue(row.isNull("n"))
        // An integer bound as an integer stays one in an untyped column.
        sql(a, "INSERT INTO t(n) VALUES (?)", 7)
        assertEquals("integer", rows(sql(a, "SELECT typeof(n) AS k FROM t WHERE i IS NULL")).getJSONObject(0).getString("k"))
    }

    @Test fun jsonFunctionsInsertReturningAndTriggersWork() {
        sql(a, "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
        val inserted = rows(sql(a, "INSERT INTO t(v) VALUES (?) RETURNING id", "x"))
        assertEquals(1, inserted.length())
        assertEquals("1", rows(sql(a, "SELECT json_extract(value,'$.a') AS first FROM json_each(?)", "[{\"a\":1},{\"a\":2}]")).getJSONObject(0).get("first").toString())
        val deleted = rows(sql(a, "DELETE FROM t WHERE id=? RETURNING id", 1))
        assertEquals(1, deleted.length())
    }

    // The statements packages/sync-sqlite/src/mirror.ts issues, copied from it: nothing legitimate may be refused.
    private val mirrorSchema = listOf(
        "CREATE TABLE IF NOT EXISTS mirror_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS mirror_workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS mirror_checkpoint (workspace_id TEXT PRIMARY KEY, cursor TEXT, boundary TEXT, next_cursor TEXT, sealed INTEGER NOT NULL DEFAULT 0)",
        "CREATE TABLE IF NOT EXISTS mirror_lease (workspace_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at REAL NOT NULL)",
        "CREATE TABLE IF NOT EXISTS mirror_item (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, snapshot TEXT NOT NULL, expires_at REAL, local INTEGER NOT NULL DEFAULT 0)",
        "CREATE INDEX IF NOT EXISTS mirror_item_workspace ON mirror_item (workspace_id, id)",
        "CREATE INDEX IF NOT EXISTS mirror_item_parent ON mirror_item (parent_id)",
        "CREATE INDEX IF NOT EXISTS mirror_item_expiry ON mirror_item (expires_at)",
        "CREATE TABLE IF NOT EXISTS mirror_stage (workspace_id TEXT NOT NULL, id TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(workspace_id, id))",
        "CREATE TABLE IF NOT EXISTS mirror_body (item_id TEXT PRIMARY KEY REFERENCES mirror_item(id) ON DELETE CASCADE ON UPDATE CASCADE, doc_id TEXT NOT NULL, confirmed_update BLOB NOT NULL, state_vector BLOB NOT NULL, head_seq TEXT, schema_version INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS mirror_body_request (item_id TEXT PRIMARY KEY REFERENCES mirror_item(id) ON DELETE CASCADE ON UPDATE CASCADE)",
        "CREATE TABLE IF NOT EXISTS mirror_pending (seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES mirror_item(id) ON DELETE CASCADE ON UPDATE CASCADE, doc_id TEXT, client_id TEXT NOT NULL UNIQUE, update_blob BLOB NOT NULL)",
        "CREATE INDEX IF NOT EXISTS mirror_pending_item ON mirror_pending (item_id, seq)",
        "CREATE TABLE IF NOT EXISTS mirror_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES mirror_item(id) ON DELETE CASCADE ON UPDATE CASCADE, operation_json TEXT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS mirror_outbox_item ON mirror_outbox (workspace_id,item_id)",
        "CREATE TABLE IF NOT EXISTS mirror_conflict (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES mirror_item(id) ON DELETE CASCADE ON UPDATE CASCADE, kind TEXT NOT NULL, code TEXT NOT NULL, operation_json TEXT, created_at TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS mirror_conflict_recovery (conflict_id TEXT PRIMARY KEY REFERENCES mirror_conflict(id) ON DELETE CASCADE, update_blob BLOB NOT NULL)",
        "CREATE TABLE IF NOT EXISTS mirror_alias (local_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, server_id TEXT NOT NULL REFERENCES mirror_item(id) ON DELETE CASCADE ON UPDATE CASCADE)",
        "CREATE TABLE IF NOT EXISTS mirror_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "CREATE VIRTUAL TABLE IF NOT EXISTS mirror_search USING fts5(item_id UNINDEXED, title, body_text)",
        "CREATE TRIGGER IF NOT EXISTS mirror_item_deleted AFTER DELETE ON mirror_item BEGIN DELETE FROM mirror_search WHERE item_id=old.id; END",
    )

    @Test fun theMirrorsOwnSchemaAndWritesAreNotRefused() {
        for (pragma in listOf("PRAGMA foreign_keys=ON", "PRAGMA journal_mode=WAL", "PRAGMA synchronous=FULL", "PRAGMA secure_delete=ON")) sql(a, pragma)
        val tx = call(a, JSONObject().put("op", "begin")).getString("tx")
        for (statement in mirrorSchema) sql(a, statement, tx = tx)
        sql(a, "INSERT INTO mirror_search(mirror_search,rank) VALUES('secure-delete',1)", tx = tx)
        sql(a, "INSERT INTO mirror_meta(key,value) VALUES('account',?) ON CONFLICT(key) DO NOTHING", "acct", tx = tx)
        sql(a, "INSERT INTO mirror_meta(key,value) VALUES('schema','1') ON CONFLICT(key) DO NOTHING", tx = tx)
        sql(a, "INSERT INTO mirror_item(id, workspace_id, parent_id, title, snapshot, expires_at, local) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id, parent_id=excluded.parent_id, title=excluded.title, snapshot=excluded.snapshot, expires_at=excluded.expires_at, local=excluded.local", "i1", "w", JSONObject.NULL, "Hello", "{\"canPersistBody\":1}", JSONObject.NULL, 0, tx = tx)
        sql(a, "INSERT INTO mirror_search(item_id,title,body_text) VALUES(?,?,?)", "i1", "Hello", "world of notes", tx = tx)
        sql(a, "UPDATE mirror_search SET body_text=? WHERE item_id=?", "new body text", "i1", tx = tx)
        sql(a, "INSERT INTO mirror_conflict(id,workspace_id,item_id,kind,code,operation_json,created_at) VALUES(?,?,?,'body','document_changed',NULL,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code", "c1", "w", "i1", "now", tx = tx)
        sql(a, "INSERT INTO mirror_stage(workspace_id,id,snapshot) SELECT ?, json_extract(value,'\$[0]'), json_extract(value,'\$[1]') FROM json_each(?) WHERE true ON CONFLICT(workspace_id,id) DO UPDATE SET snapshot=excluded.snapshot", "w", "[[\"a\",\"b\"]]", tx = tx)
        sql(a, "INSERT INTO mirror_checkpoint(workspace_id,cursor,boundary,next_cursor) VALUES(?,?,NULL,NULL) ON CONFLICT(workspace_id) DO UPDATE SET cursor=excluded.cursor,boundary=NULL,next_cursor=NULL", "w", "c", tx = tx)
        sql(a, "WITH RECURSIVE expired(id) AS (SELECT id FROM mirror_item WHERE expires_at<=? UNION SELECT item.id FROM mirror_item item JOIN expired ON item.parent_id=expired.id) DELETE FROM mirror_item WHERE id IN (SELECT id FROM expired) RETURNING id", 1, tx = tx)
        call(a, JSONObject().put("op", "commit").put("tx", tx))
        assertEquals("i1", rows(sql(a, "SELECT item_id FROM mirror_search WHERE mirror_search MATCH 'body'")).getJSONObject(0).getString("item_id"))
        assertEquals(1, rows(sql(a, "SELECT t FROM (SELECT body_text AS t FROM mirror_search WHERE item_id=?)", "i1")).length())
        sql(a, "DELETE FROM mirror_item WHERE id=?", "i1")
        assertEquals(0, rows(sql(a, "SELECT item_id FROM mirror_search WHERE mirror_search MATCH 'body'")).length())
    }

    @Test fun shadowTablesAndPragmaFunctionsAreRefusedAgainstTheRealIndex() {
        sql(a, "CREATE VIRTUAL TABLE ft USING fts5(a)")
        for (text in listOf(
            "INSERT INTO 'ft_data' VALUES(99, x'00')",
            "DELETE FROM 'ft_config'",
            "DROP TABLE 'ft_data'",
            "CREATE TABLE x_data AS SELECT 1 AS id, x'ffff' AS block",
            "SELECT * FROM 'pragma_database_list'",
            "SELECT * FROM 'pragma_function_list'",
        )) refused(a, text)
        sql(a, "INSERT INTO ft(a) VALUES ('ok')")
        assertEquals(1, rows(sql(a, "SELECT a FROM ft WHERE ft MATCH 'ok'")).length())
    }

    @Test fun theBundledSqliteIsNewEnoughForTheKnownMemorySafetyFixes() {
        // CVE-2025-6965 is fixed in 3.50.2; a downgrade of androidx.sqlite must fail here.
        val version = rows(sql(a, "SELECT sqlite_version() AS v")).getJSONObject(0).getString("v")
        val parts = version.split('.').map { it.toInt() }
        assertTrue("SQLite $version", (parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2]) >= 3_050_002)
    }

    @Test fun thePageCannotReachTheTokenizerPointerFunction() {
        for (text in listOf("SELECT fts3_tokenizer(?)", "SELECT \"fts3_tokenizer\"(?)", "SELECT [FTS3_TOKENIZER](?)"))
            assertNotNull(text, send(a, JSONObject().put("op", "execute").put("sql", text).put("params", JSONArray("[\"simple\"]"))).second)
        assertNotNull(send(a, JSONObject().put("op", "execute").put("sql", "SELECT * FROM pragma_database_list")).second)
    }

    @Test fun fullTextIndexAndItsTriggerRun() {
        sql(a, "CREATE VIRTUAL TABLE s USING fts5(t)")
        sql(a, "INSERT INTO s(s,rank) VALUES('secure-delete',1)")
        sql(a, "INSERT INTO s(t) VALUES ('hello')")
        assertEquals(1, rows(sql(a, "SELECT t FROM s WHERE s MATCH 'hello'")).length())
        sql(a, "CREATE TABLE m(id)")
        sql(a, "CREATE TRIGGER IF NOT EXISTS m_del AFTER DELETE ON m BEGIN DELETE FROM s WHERE rowid=old.id; END")
        sql(a, "INSERT INTO m VALUES (1)")
        sql(a, "DELETE FROM m")
    }

    @Test fun transactionsCommitRollbackAndRefuseAWrongId() {
        sql(a, "CREATE TABLE t(a)")
        val tx = call(a, JSONObject().put("op", "begin")).getString("tx")
        sql(a, "INSERT INTO t VALUES (1)", tx = tx)
        call(a, JSONObject().put("op", "commit").put("tx", tx))
        assertEquals(1, rows(sql(a, "SELECT * FROM t")).length())
        val tx2 = call(a, JSONObject().put("op", "begin")).getString("tx")
        sql(a, "INSERT INTO t VALUES (2)", tx = tx2)
        call(a, JSONObject().put("op", "rollback").put("tx", tx2))
        assertEquals(1, rows(sql(a, "SELECT * FROM t")).length())
        assertNotNull(send(a, JSONObject().put("op", "commit").put("tx", "nope")).second)
        assertNotNull(send(a, JSONObject().put("op", "execute").put("sql", "SELECT 1").put("tx", "nope")).second)
    }

    @Test fun requestsWithoutATransactionWaitForTheOpenOneInOrder() {
        sql(a, "CREATE TABLE t(a)")
        val tx = call(a, JSONObject().put("op", "begin")).getString("tx")
        val order = java.util.Collections.synchronizedList(ArrayList<String>())
        val done = CountDownLatch(2)
        stores.handle(a, JSONObject().put("op", "execute").put("sql", "INSERT INTO t VALUES ('outside')").put("params", JSONArray())) { _, _ -> order.add("outside"); done.countDown() }
        stores.handle(a, JSONObject().put("op", "begin")) { result, _ ->
            order.add("second begin")
            stores.handle(a, JSONObject().put("op", "rollback").put("tx", result!!.getString("tx"))) { _, _ -> done.countDown() }
        }
        sql(a, "INSERT INTO t VALUES ('inside')", tx = tx)
        assertTrue(order.isEmpty())
        call(a, JSONObject().put("op", "commit").put("tx", tx))
        assertTrue(done.await(20, TimeUnit.SECONDS))
        assertEquals(listOf("outside", "second begin"), order.toList())
        assertEquals(listOf("inside", "outside"), (0 until 2).map { rows(sql(a, "SELECT a FROM t ORDER BY rowid")).getJSONObject(it).getString("a") })
    }

    @Test fun anIdleTransactionRollsBackAndItsIdIsRefused() {
        sql(a, "CREATE TABLE t(a)")
        val tx = call(a, JSONObject().put("op", "begin")).getString("tx")
        sql(a, "INSERT INTO t VALUES (1)", tx = tx)
        Thread.sleep(900)
        assertNotNull(send(a, JSONObject().put("op", "commit").put("tx", tx)).second)
        assertEquals(0, rows(sql(a, "SELECT * FROM t")).length())
    }

    @Test fun aBatchIsAtomic() {
        sql(a, "CREATE TABLE t(a UNIQUE)")
        val statements = { second: Int ->
            JSONArray().put(JSONObject().put("sql", "INSERT INTO t VALUES (?)").put("params", JSONArray("[[1],[2]]")))
                .put(JSONObject().put("sql", "INSERT INTO t VALUES (?)").put("params", JSONArray("[[3],[$second]]")))
        }
        assertNotNull(send(a, JSONObject().put("op", "batch").put("statements", statements(3))).second)
        assertEquals(0, rows(sql(a, "SELECT * FROM t")).length())
        call(a, JSONObject().put("op", "batch").put("statements", statements(4)))
        assertEquals(4, rows(sql(a, "SELECT * FROM t")).length())
    }

    @Test fun originsAreIsolated() {
        sql(a, "CREATE TABLE t(a)")
        sql(a, "INSERT INTO t VALUES ('a')")
        assertNotNull(send(b, JSONObject().put("op", "execute").put("sql", "SELECT * FROM t")).second)
        assertEquals(1, rows(sql(a, "SELECT * FROM t")).length())
    }

    @Test fun pageSqlCannotReachOtherFilesOrTheTransactionGate() {
        sql(b, "CREATE TABLE secret(a)")
        sql(b, "INSERT INTO secret VALUES ('b')")
        val other = File(dir, "${NixStoreRules.storeId(b)}.sqlite").path
        for (text in listOf(
            "ATTACH '$other' AS v",
            "VACUUM INTO '${File(dir, "copy.sqlite").path}'",
            "PRAGMA database_list",
            "PRAGMA writable_schema = ON",
            "BEGIN",
            "SAVEPOINT s",
            "COMMIT",
        )) refused(a, text)
        assertFalse(File(dir, "copy.sqlite").exists())
        refused(a, "SELECT * FROM v.secret")
        for (text in listOf("PRAGMA foreign_keys=ON", "PRAGMA journal_mode=WAL", "PRAGMA synchronous=FULL", "PRAGMA secure_delete=ON")) sql(a, text)
        // The store's own transactions still work.
        val tx = call(a, JSONObject().put("op", "begin")).getString("tx")
        sql(a, "CREATE TABLE t(a)", tx = tx)
        call(a, JSONObject().put("op", "commit").put("tx", tx))
    }

    @Test fun filesUsageAndWipe() {
        sql(a, "CREATE TABLE t(a)")
        assertTrue(call(a, JSONObject().put("op", "fileGet").put("key", "k")).isNull("data"))
        File(dir, "${NixStoreRules.storeId(a)}-files").mkdirs()
        File(dir, "${NixStoreRules.storeId(a)}-files/${NixStoreRules.storeId("k")}").writeBytes(byteArrayOf(1, 2, 3))
        assertEquals("AQID", call(a, JSONObject().put("op", "fileGet").put("key", "k")).getString("data"))
        val usage = call(a, JSONObject().put("op", "usage"))
        assertEquals(3, usage.getLong("fileBytes"))
        assertTrue(usage.getLong("databaseBytes") > 0)
        call(a, JSONObject().put("op", "fileDelete").put("key", "k"))
        assertTrue(call(a, JSONObject().put("op", "fileGet").put("key", "k")).isNull("data"))
        File(dir, "${NixStoreRules.storeId(a)}-files/x").writeBytes(byteArrayOf(9))
        call(a, JSONObject().put("op", "wipe"))
        assertTrue(dir.listFiles().isNullOrEmpty())
        assertEquals(0, call(a, JSONObject().put("op", "usage")).getLong("fileBytes"))
    }

    @Test fun downloadsRefuseNonHttpsAndFailWithoutStoringAnything() {
        for (url in listOf("http://a.example/x", "ftp://a.example/x", "file:///etc/passwd", "not a url"))
            assertNotNull(url, send(a, JSONObject().put("op", "fileDownload").put("key", "k").put("url", url)).second)
        // A host that does not resolve (the .invalid TLD never does): an error, and no file.
        assertNotNull(send(a, JSONObject().put("op", "fileDownload").put("key", "k").put("url", "https://nix-test.invalid/x")).second)
        assertTrue(call(a, JSONObject().put("op", "fileGet").put("key", "k")).isNull("data"))
        assertTrue(File(dir, "${NixStoreRules.storeId(a)}-files").listFiles().orEmpty().isEmpty())
    }

    @Test fun unknownOpsAndBadParamsAreErrors() {
        assertNotNull(send(a, JSONObject().put("op", "nope")).second)
        assertNotNull(send(a, JSONObject()).second)
        assertNotNull(send(a, JSONObject().put("op", "execute").put("sql", "SELECT ?").put("params", JSONArray())).second)
        assertNotNull(send(a, JSONObject().put("op", "execute").put("sql", "SELECT 1").put("params", JSONArray("[1]"))).second)
        assertNotNull(send(a, JSONObject().put("op", "execute").put("sql", "SELECT ?").put("params", JSONArray("[[1]]"))).second)
        assertNotNull(send(a, JSONObject().put("op", "execute").put("sql", "SELECT 1; SELECT 2")).second)
    }
}
