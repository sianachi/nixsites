package app.nix.shell

import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Every SQL string literal in packages/sync-sqlite/src/mirror.ts must pass the store's filter, so a
 * statement the filter would refuse fails here instead of on a phone. The literals are read from the
 * source at test time (the repo root is four levels above the module directory); `${...}` pieces in
 * template literals become a plain word, which is enough for a check that looks at tokens. The text
 * filter is the only guard on Android: any new allowed statement or pragma is a security change.
 */
class NixMirrorStatementsTest {
    private val verbs = Regex("^\\s*(select|insert|update|delete|with|create|pragma|replace|drop|alter|values)\\b", RegexOption.IGNORE_CASE)

    private fun literals(source: String): List<String> {
        val out = ArrayList<String>()
        var i = 0
        while (i < source.length) {
            val c = source[i]
            when {
                source.startsWith("//", i) -> i = source.indexOf('\n', i).let { if (it < 0) source.length else it }
                source.startsWith("/*", i) -> i = source.indexOf("*/", i + 2).let { if (it < 0) source.length else it + 2 }
                c == '\'' || c == '"' || c == '`' -> {
                    val text = StringBuilder()
                    i++
                    while (i < source.length && source[i] != c) {
                        when {
                            source[i] == '\\' && i + 1 < source.length -> { text.append(source[i + 1]); i += 2 }
                            c == '`' && source.startsWith("\${", i) -> {
                                var depth = 0
                                do {
                                    if (source[i] == '{') depth++
                                    if (source[i] == '}') depth--
                                    i++
                                } while (i < source.length && depth > 0)
                                text.append("x")
                            }
                            else -> { text.append(source[i]); i++ }
                        }
                    }
                    i++
                    out.add(text.toString())
                }
                else -> i++
            }
        }
        return out
    }

    @Test fun everySqlLiteralInTheMirrorPassesTheFilter() {
        val file = File("../../../../packages/sync-sqlite/src/mirror.ts")
        assumeTrue("mirror.ts not found from ${File(".").absolutePath}", file.exists())
        val statements = literals(file.readText()).filter { verbs.containsMatchIn(it) && it.contains(' ') || it.startsWith("PRAGMA") }
        assertTrue("found ${statements.size}", statements.size > 100)
        val refused = statements.mapNotNull { sql ->
            try { NixStoreRules.check(sql); null } catch (e: StoreError) { "${e.message}: $sql" }
        }
        assertTrue(refused.joinToString("\n"), refused.isEmpty())
    }
}
