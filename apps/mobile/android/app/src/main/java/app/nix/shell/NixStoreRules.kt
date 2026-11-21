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
    /**
     * The pragmas the page may run, with the only values it may set (packages/sync-sqlite sends exactly
     * `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=FULL`, `secure_delete=ON`). A pragma with no value
     * is a read. Anything else is refused: `journal_mode=OFF` or `MEMORY` would let a rollback leave pages
     * the page wrote behind, which defeats the shadow-table rule.
     */
    private val pragmaValues = mapOf(
        "journal_mode" to setOf("wal"),
        "synchronous" to setOf("full", "normal", "2", "1"),
        "secure_delete" to setOf("on", "1"),
        "foreign_keys" to setOf("on", "off", "1", "0"),
    )
    private val pagePragmas = pragmaValues.keys

    /**
     * Statement classes the page may run. Everything else is refused: ATTACH/DETACH (another origin's
     * database is a file next to this one), VACUUM (INTO writes a file), raw transaction statements
     * (the store's begin/commit gate owns transactions), EXPLAIN, ANALYZE, REINDEX.
     */
    private val allowed = setOf("select", "values", "with", "insert", "replace", "update", "delete", "create", "drop", "alter", "pragma")

    /**
     * Functions that hand the page a pointer or run native code: `fts3_tokenizer` returns a module's
     * address and, with a blob, registers an arbitrary one that a later FTS3 table calls.
     */
    private val bannedNames = setOf("fts3_tokenizer", "load_extension", "readfile", "writefile", "edit", "rtreenode", "rtreedepth", "rtreecheck")
    private val writes = setOf("insert", "replace", "update", "delete", "drop", "alter", "create")

    /** The tables SQLite keeps behind an FTS3/4/5 or R-tree virtual table. */
    private val shadow = Regex("_(data|idx|content|docsize|config|segments|segdir|stat|node|parent|rowid)$")

    /**
     * Words (lowercase) and punctuation of `sql`, a comment nothing. A quoted name keeps its lowercase
     * text behind a `"`, a string behind a `'` (SQLite accepts a string where a table name goes), so
     * neither is ever a keyword, `;` or `?`.
     */
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
                    val text = StringBuilder()
                    i++
                    while (i < sql.length) {
                        if (sql[i] == close) {
                            if (c != '[' && sql.startsWith("$close$close", i)) { text.append(close); i += 2; continue }
                            break
                        }
                        text.append(sql[i])
                        i++
                    }
                    i++
                    out.add((if (c == '\'') "'" else "\"") + text.toString().lowercase())
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
        if (first == "pragma") checkPragma(t)
        // Function names are words or quoted names; a string is never one, but it can name a table.
        val names = t.map { if (it.startsWith("\"") || it.startsWith("'")) it.drop(1) else it }
        val isString = t.map { it.startsWith("'") }
        if (names.indices.any { i ->
                val n = names[i]
                (!isString[i] && n in bannedNames) || (n.startsWith("pragma_") && n.removePrefix("pragma_") !in pagePragmas)
            }) throw StoreError("Function not allowed.")
        // The tables behind a virtual table are SQLite's own; writing or creating one corrupts the index.
        // The name an index or trigger declares for itself is not a table (the mirror has `..._parent`).
        val declared = t.take(5).indexOfFirst { it == "index" || it == "trigger" }.let { p ->
            val name = if (p < 0) -1 else (p + 1..p + 4).firstOrNull { it < t.size && t[it] !in setOf("if", "not", "exists") } ?: -1
            // `main.name`: the declared name is the part after the schema.
            if (name >= 0 && t.getOrNull(name + 1) == ".") name + 2 else name
        }
        // `replace(...)` is the SQL function, not REPLACE INTO. A name followed by `=` is an option such as
        // FTS5's `content_rowid='id'`; no table is ever named there.
        val writing = t.indices.any { t[it] in writes && !(t[it] == "replace" && t.getOrNull(it + 1) == "(") }
        if (writing && names.indices.any { it != declared && t.getOrNull(it + 1) != "=" && shadow.containsMatchIn(names[it]) })
            throw StoreError("Table not allowed.")
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

    /** `pragma <name>` or `pragma <name> = <value>`, with a name and value from `pragmaValues`, and nothing after. */
    private fun checkPragma(t: List<String>) {
        val body = if (t.last() == ";") t.dropLast(1) else t
        val values = pragmaValues[body.getOrNull(1)] ?: throw StoreError("Pragma not allowed.")
        if (body.size == 2) return
        val value = body.getOrNull(3)?.let { if (it.startsWith("\"") || it.startsWith("'")) it.drop(1) else it }
        if (body.size != 4 || body[2] != "=" || value !in values) throw StoreError("Pragma value not allowed.")
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
