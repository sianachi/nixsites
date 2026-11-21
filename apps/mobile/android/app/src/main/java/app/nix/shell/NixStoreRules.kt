package app.nix.shell

import java.security.MessageDigest
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

class StoreError(message: String) : Exception(message)

/**
 * The rules of the `nixStore` channel that need no Android: which statements the page may run, how
 * values cross the boundary, and which frame may talk to a store. NixStore.kt applies them.
 * `android.database.sqlite` has no authorizer hook, so unlike iOS and desktop the statement
 * classes are checked on the text, before SQLite sees it.
 */
object NixStoreRules {
    /** Pragmas the page's SQL may run (packages/sync-sqlite opens with these); every other pragma is refused. */
    private val pagePragmas = setOf("foreign_keys", "journal_mode", "synchronous", "secure_delete")

    /**
     * Statement classes the page may run. Everything else is refused: ATTACH/DETACH (another origin's
     * database is a file next to this one), VACUUM (INTO writes a file), raw transaction statements
     * (the store's begin/commit gate owns transactions), EXPLAIN, ANALYZE, REINDEX.
     */
    private val allowed = setOf("select", "values", "with", "insert", "replace", "update", "delete", "create", "drop", "alter", "pragma")

    /** Words (lowercase) and punctuation of `sql`; strings, quoted names and comments become a lone "'". */
    internal fun tokens(sql: String): List<String> {
        val out = ArrayList<String>()
        var i = 0
        while (i < sql.length) {
            val c = sql[i]
            when {
                c.isWhitespace() -> i++
                c == '-' && sql.startsWith("--", i) -> i = sql.indexOf('\n', i).let { if (it < 0) sql.length else it + 1 }
                c == '/' && sql.startsWith("/*", i) -> i = sql.indexOf("*/", i + 2).let { if (it < 0) sql.length else it + 2 }
                c == '\'' || c == '"' || c == '`' || c == '[' -> {
                    val close = if (c == '[') ']' else c
                    i++
                    while (i < sql.length) {
                        if (sql[i] == close) {
                            if (c != '[' && sql.startsWith("$close$close", i)) { i += 2; continue }
                            break
                        }
                        i++
                    }
                    i++
                    out.add("'")
                }
                c.isLetter() || c == '_' -> {
                    val start = i
                    while (i < sql.length && (sql[i].isLetterOrDigit() || sql[i] == '_' || sql[i] == '$')) i++
                    out.add(sql.substring(start, i).lowercase())
                }
                else -> { out.add(c.toString()); i++ }
            }
        }
        return out
    }

    /** Throws if the page may not run `sql`; returns how many `?` parameters it takes. One statement per request. */
    fun check(sql: String): Int {
        val t = tokens(sql)
        val first = t.firstOrNull() ?: throw StoreError("Empty statement.")
        if (first !in allowed) throw StoreError("Statement not allowed.")
        if (first == "pragma" && t.getOrNull(1) !in pagePragmas) throw StoreError("Pragma not allowed.")
        // A trigger body holds its own semicolons and ends at the END that closes it (CASE ... END nests).
        val trigger = first == "create" && t.take(4).contains("trigger")
        var cases = 0
        var closedCase = false
        for ((i, token) in t.withIndex()) {
            if (trigger && token == "case") cases++
            if (token == "end") closedCase = trigger && cases > 0
            if (closedCase && token == "end") cases--
            if (token == ";" && (!trigger || (t[i - 1] == "end" && !closedCase))) {
                if (i != t.lastIndex) throw StoreError("One statement per request.")
                break
            }
        }
        return t.count { it == "?" }
    }

    /** null, number, string, or a blob as `{ "$b64": "..." }`; a boolean is 0 or 1. Yields null, Long, Double, String or ByteArray. */
    @OptIn(ExperimentalEncodingApi::class)
    fun fromWire(value: Any?): Any? = when (value) {
        null, is String -> value
        is Boolean -> if (value) 1L else 0L
        is Int, is Long, is Short, is Byte -> (value as Number).toLong()
        is Number -> value.toDouble()
        is Map<*, *> -> {
            val b64 = value["\$b64"] as? String
            if (value.size != 1 || b64 == null) throw StoreError("Bad blob value.")
            try { Base64.decode(b64) } catch (_: IllegalArgumentException) { throw StoreError("Bad blob value.") }
        }
        else -> throw StoreError("Unsupported parameter type.")
    }

    @OptIn(ExperimentalEncodingApi::class)
    fun toWire(value: Any?): Any? = if (value is ByteArray) mapOf("\$b64" to Base64.encode(value)) else value

    /** The file name stem of an origin's database and files; the same hash as iOS and desktop. */
    fun storeId(origin: String): String =
        MessageDigest.getInstance("SHA-256").digest(origin.toByteArray()).joinToString("") { "%02x".format(it) }

    /** The store a frame may use: its own origin, and only when that is a saved server (never a sign-in origin). */
    fun frameOrigin(sourceOrigin: String?, isMainFrame: Boolean, saved: Set<String>): String? =
        NixServers.origin(sourceOrigin)?.takeIf { isMainFrame && it in saved }
}
