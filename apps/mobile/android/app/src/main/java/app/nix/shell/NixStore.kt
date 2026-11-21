package app.nix.shell

import androidx.sqlite.SQLITE_DATA_BLOB
import androidx.sqlite.SQLITE_DATA_FLOAT
import androidx.sqlite.SQLITE_DATA_INTEGER
import androidx.sqlite.SQLITE_DATA_TEXT
import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteStatement
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import androidx.sqlite.execSQL
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/** Calls back with a reply object or an error string; may run on any thread. */
typealias StoreDone = (JSONObject?, String?) -> Unit

/**
 * The per-origin stores behind the page's `nixStore` channel; the port of apps/mobile/ios/NixStore.
 * The caller has already bound `origin` to the frame that sent the request (NixStoreRules.frameOrigin).
 * Each store runs its statements on its own thread, so they never interleave and one page's endless
 * query stalls only its own origin; a transaction gate decides which requests may run while one is open.
 */
class NixStores(val baseDir: File, private val idleMs: Long = 30_000) {
    private val net: ExecutorService = Executors.newCachedThreadPool { Thread(it, "nix-store-download").apply { isDaemon = true } }
    // Only wakes a store's own thread; it never runs a store's work, so a stuck store cannot stall the others' timers.
    private val timers = ScheduledThreadPoolExecutor(1) { Thread(it, "nix-store-timer").apply { isDaemon = true } }
    private val stores = ConcurrentHashMap<String, NixStore>()

    private fun store(origin: String) = stores.computeIfAbsent(origin) { NixStore(origin, baseDir, net, timers, idleMs) }

    fun handle(origin: String, request: JSONObject, done: StoreDone) {
        val store = store(origin)
        store.worker.execute {
            try {
                store.handle(request, done)
            } catch (e: Exception) {
                done(null, e.message ?: "The request failed.")
            }
        }
    }

    fun wipe(origin: String, done: StoreDone) {
        val store = store(origin)
        store.worker.execute {
            try { store.wipe(); done(JSONObject(), null) } catch (e: Exception) { done(null, e.message ?: "Could not delete local data.") }
        }
    }
}

@OptIn(ExperimentalEncodingApi::class)
class NixStore(
    origin: String,
    baseDir: File,
    private val net: ExecutorService,
    private val timers: ScheduledThreadPoolExecutor,
    private val idleMs: Long,
) {
    val worker: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "nix-store").apply { isDaemon = true } }
    /** Bumped by every wipe; a download that started before one must not land after it. */
    @Volatile private var wipes = 0
    private val id = NixStoreRules.storeId(origin)
    private val dbFile = File(baseDir, "$id.sqlite")
    private val filesDir = File(baseDir, "$id-files")
    private var db: SQLiteConnection? = null

    // Gate state, touched only on the worker thread.
    private var activeTx: String? = null
    private var timer: ScheduledFuture<*>? = null
    private var generation = 0
    private val waiting = ArrayDeque<() -> Unit>()

    // Downloads run on `net`; guarded by `downloads`.
    private val downloads = HashMap<String, Download>()

    private class Download(val future: Future<Pair<Long, String>>, val connection: () -> HttpURLConnection?)

    // region database

    /**
     * The platform's SQLite has no FTS5 (the mirror's search index needs it) and no authorizer, so the
     * store links its own SQLite (androidx.sqlite bundled) and checks the page's statements on the text.
     */
    private fun open(): SQLiteConnection {
        db?.let { return it }
        dbFile.parentFile?.mkdirs()
        val connection = BundledSQLiteDriver().open(dbFile.path)
        try {
            connection.execSQL("PRAGMA journal_mode = WAL")
            connection.execSQL("PRAGMA foreign_keys = ON")
        } catch (e: Exception) {
            connection.close()
            throw e
        }
        db = connection
        return connection
    }

    /** Rows of the statement, if it produces any. The page's SQL was checked by NixStoreRules; binding is typed. */
    private fun query(sql: String, params: List<Any?>): List<Map<String, Any?>> {
        if (NixStoreRules.check(sql) != params.size) throw StoreError("Parameter count does not match.")
        val statement = open().prepare(sql)
        try {
            params.forEachIndexed { i, value -> bind(statement, i + 1, value) }
            val names = (0 until statement.getColumnCount()).map { statement.getColumnName(it) }
            val rows = ArrayList<Map<String, Any?>>()
            while (statement.step()) {
                val row = HashMap<String, Any?>()
                for (i in names.indices) {
                    row[names[i]] = when (statement.getColumnType(i)) {
                        SQLITE_DATA_INTEGER -> statement.getLong(i)
                        SQLITE_DATA_FLOAT -> statement.getDouble(i)
                        SQLITE_DATA_TEXT -> statement.getText(i)
                        SQLITE_DATA_BLOB -> statement.getBlob(i)
                        else -> null
                    }
                }
                rows.add(row)
            }
            return rows
        } finally {
            statement.close()
        }
    }

    private fun bind(statement: SQLiteStatement, i: Int, value: Any?) {
        when (value) {
            null -> statement.bindNull(i)
            is Long -> statement.bindLong(i, value)
            is Double -> statement.bindDouble(i, value)
            is String -> statement.bindText(i, value)
            is ByteArray -> statement.bindBlob(i, value)
        }
    }

    private fun values(any: Any?): List<Any?> {
        val list = any as? JSONArray ?: if (any == null) return emptyList() else throw StoreError("params must be an array.")
        return (0 until list.length()).map { NixStoreRules.fromWire(fromJson(list.get(it))) }
    }

    private fun fromJson(value: Any?): Any? = when (value) {
        JSONObject.NULL -> null
        is JSONObject -> value.keys().asSequence().associateWith { fromJson(value.get(it)) }
        else -> value
    }

    private fun rowsJson(rows: List<Map<String, Any?>>) = JSONArray(rows.map { row ->
        JSONObject().also { o -> row.forEach { (k, v) -> o.put(k, toJson(v)) } }
    })

    private fun toJson(value: Any?): Any? = when (val wire = NixStoreRules.toWire(value)) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject(wire)
        else -> wire
    }

    // endregion

    // region transactions

    /** Runs `job` now, or once the open transaction ends (requests keep their arrival order). */
    private fun whenFree(job: () -> Unit) {
        if (activeTx != null) waiting.add(job) else job()
    }

    private fun release() {
        activeTx = null
        timer?.cancel(false)
        timer = null
        generation++
        val pending = waiting.toList()
        waiting.clear()
        for (job in pending) whenFree(job)
    }

    private fun armIdleTimer() {
        val mine = ++generation
        timer?.cancel(false)
        // One timer, not one task per statement: a first sync runs tens of thousands.
        timer = timers.schedule({
            worker.execute {
                if (activeTx != null && mine == generation) {
                    try { db?.execSQL("ROLLBACK") } catch (_: Exception) {}
                    release()
                }
            }
        }, idleMs, TimeUnit.MILLISECONDS)
    }

    private fun requireTx(tx: String) {
        if (tx != activeTx) throw StoreError("Transaction is not open (it may have timed out).")
    }

    private fun begin(): String {
        open().execSQL("BEGIN IMMEDIATE")
        val tx = UUID.randomUUID().toString()
        activeTx = tx
        armIdleTimer()
        return tx
    }

    private fun end(tx: String, commit: Boolean) {
        requireTx(tx)
        try {
            val handle = open()
            try {
                handle.execSQL(if (commit) "COMMIT" else "ROLLBACK")
            } catch (e: Exception) {
                if (commit) try { handle.execSQL("ROLLBACK") } catch (_: Exception) {}
                throw e
            }
        } finally {
            release()
        }
    }

    // endregion

    /** On the worker thread. Replies through `done`, now or once the gate is free. */
    fun handle(request: JSONObject, done: StoreDone) {
        fun string(key: String) = request.optString(key).takeIf { it.isNotEmpty() } ?: throw StoreError("Missing $key.")
        fun reply(build: JSONObject.() -> Unit) = done(JSONObject().apply(build), null)
        fun guarded(job: () -> Unit) = whenFree {
            try { job() } catch (e: Exception) { done(null, e.message ?: "The request failed.") }
        }
        when (string("op")) {
            "begin" -> guarded { val tx = begin(); reply { put("tx", tx) } }
            "execute" -> {
                val sql = string("sql")
                val params = values(request.opt("params"))
                val tx = request.optString("tx").takeIf { it.isNotEmpty() }
                if (tx != null) {
                    requireTx(tx)
                    armIdleTimer()
                    reply { put("rows", rowsJson(query(sql, params))) }
                } else {
                    guarded { reply { put("rows", rowsJson(query(sql, params))) } }
                }
            }
            "commit" -> { end(string("tx"), true); reply {} }
            "rollback" -> { end(string("tx"), false); reply {} }
            "batch" -> {
                val list = request.optJSONArray("statements") ?: throw StoreError("Missing statements.")
                val statements = (0 until list.length()).map {
                    val item = list.optJSONObject(it) ?: throw StoreError("Bad statement.")
                    val rows = item.optJSONArray("params") ?: throw StoreError("Bad statement.")
                    val sql = item.optString("sql").takeIf { s -> s.isNotEmpty() } ?: throw StoreError("Bad statement.")
                    sql to (0 until rows.length()).map { r -> values(rows.get(r)) }
                }
                guarded {
                    // Free gate, one thread: nothing interleaves.
                    val handle = open()
                    handle.execSQL("BEGIN IMMEDIATE")
                    try {
                        for ((sql, rows) in statements) for (row in rows) query(sql, row)
                        handle.execSQL("COMMIT")
                    } catch (e: Exception) {
                        try { handle.execSQL("ROLLBACK") } catch (_: Exception) {}
                        throw e
                    }
                    reply {}
                }
            }
            "fileGet" -> reply { put("data", fileGet(string("key"))?.let { Base64.encode(it) } ?: JSONObject.NULL) }
            "fileDelete" -> { fileOf(string("key")).delete(); reply {} }
            "fileDownload" -> fileDownload(string("key"), string("url"), request.optLong("bytes", 0), done)
            "usage" -> reply { usage().let { (d, f) -> put("databaseBytes", d); put("fileBytes", f) } }
            "wipe" -> { wipe(); reply {} }
            "keepAwake" -> { NixBackgroundSync.keepAwake(request.optBoolean("running")); reply {} }
            // No notification of its own yet; the page ignores the difference.
            "notify" -> reply {}
            else -> throw StoreError("Unknown op.")
        }
    }

    // region files

    private fun fileOf(key: String) = File(filesDir, NixStoreRules.storeId(key))

    private fun fileGet(key: String): ByteArray? = try { fileOf(key).readBytes() } catch (_: Exception) { null }

    /**
     * GET an object-store capability URL: no cookies, no credentials, never a Core token, and every
     * hop must be https. Replies with the stored size and the hex SHA-256 of the stored file, so the
     * page can verify the bytes. A download already going for the key is joined; a file already there
     * is reused. Runs off the worker thread: a large file must not hold up the database.
     */
    private fun fileDownload(key: String, url: String, expected: Long, done: StoreDone) {
        val target = try { URL(url) } catch (_: Exception) { null }
        if (target == null || target.protocol.lowercase() != "https" || target.host.isNullOrEmpty()) throw StoreError("Downloads must use https.")
        val dest = fileOf(key)
        val started = wipes
        val job = synchronized(downloads) {
            downloads.getOrPut(dest.name) {
                val connection = AtomicReference<HttpURLConnection?>(null)
                Download(net.submit(Callable {
                    try {
                        download(target, dest, if (expected > 0) expected else NixDownload.MAX_FILE_BYTES, started) { connection.set(it) }
                    } finally {
                        synchronized(downloads) { downloads.remove(dest.name) }
                    }
                }), { connection.get() })
            }
        }
        net.execute {
            try {
                val (bytes, sha) = job.future.get()
                done(JSONObject().put("bytes", bytes).put("sha256", sha), null)
            } catch (e: Exception) {
                // Never the cause's own message: a signed URL can end up in a network error's text.
                done(null, (e.cause as? StoreError)?.message ?: "Download failed.")
            }
        }
    }

    internal fun download(first: URL, dest: File, maxBytes: Long, started: Int, track: (HttpURLConnection?) -> Unit): Pair<Long, String> {
        if (!dest.exists()) {
            // A wipe since this download began removed the directory on purpose; it is not made again.
            if (wipes != started) throw StoreError("Download failed.")
            filesDir.mkdirs()
            val part = File(filesDir, dest.name + ".part")
            try {
                NixDownload.fetch(first, part, maxBytes, { wipes == started }, track)
                if (wipes != started || !part.renameTo(dest)) throw StoreError("Download failed.")
            } finally {
                part.delete()
            }
        }
        return dest.length() to sha256Hex(dest)
    }

    private fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    // endregion

    private fun usage(): Pair<Long, Long> {
        val database = listOf("", "-wal", "-shm").sumOf { File(dbFile.path + it).length() }
        return database to (filesDir.listFiles()?.sumOf { it.length() } ?: 0L)
    }

    /**
     * Closes the database and deletes it and the files. Throws if anything remains, so the caller can
     * keep admission closed. Downloads into this store stop first, so none lands afterwards.
     */
    fun wipe() {
        wipes++
        val running = synchronized(downloads) { downloads.values.toList() }
        for (d in running) { d.connection()?.disconnect(); d.future.cancel(true) }
        for (d in running) try { d.future.get(10, TimeUnit.SECONDS) } catch (_: Exception) {}
        if (activeTx != null) try { db?.execSQL("ROLLBACK") } catch (_: Exception) {}
        db?.close()
        db = null
        release()
        val gone = listOf("", "-wal", "-shm", "-journal").map { File(dbFile.path + it) }.all { !it.exists() || it.delete() } &&
            (!filesDir.exists() || filesDir.deleteRecursively())
        if (!gone) throw StoreError("Could not delete local data.")
    }

}
