package app.nix.shell

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

// The page-facing rules of NixStoreTests.swift (testPageSqlCannotReachOtherFilesOrTheTransactionGate,
// testOriginsAreIsolated, testValueRoundTripIncludingBlobs, testUnknownOpAndBadParams) that need no SQLite.
class NixStoreRulesTest {
    private fun refused(sql: String) {
        try {
            NixStoreRules.check(sql)
            fail("allowed: $sql")
        } catch (_: StoreError) {}
    }

    @Test fun refusesAttachDetachVacuumAndTransactionStatements() {
        for (sql in listOf(
            "ATTACH '/data/x.sqlite' AS v",
            "attach database ? as v",
            "  /* hi */ ATTACH '/x' AS v",
            "-- note\nATTACH '/x' AS v",
            "DETACH v",
            "VACUUM INTO '/x'",
            "VACUUM",
            "BEGIN",
            "BEGIN IMMEDIATE",
            "COMMIT",
            "END",
            "ROLLBACK",
            "SAVEPOINT s",
            "RELEASE s",
            "EXPLAIN SELECT 1",
            "ANALYZE",
            "REINDEX",
            "",
            "   ",
            "; ATTACH '/x' AS v",
        )) refused(sql)
    }

    @Test fun refusesASecondStatement() {
        refused("SELECT 1; ATTACH '/x' AS v")
        refused("CREATE TABLE secret(a); INSERT INTO secret VALUES ('b')")
        refused("SELECT 1; SELECT 2")
        refused("INSERT INTO t VALUES (1);ATTACH '/x' AS v")
        // A trailing semicolon and comment are one statement.
        assertEquals(0, NixStoreRules.check("SELECT 1; "))
        assertEquals(0, NixStoreRules.check("SELECT 1; -- done"))
    }

    @Test fun stringsAndCommentsDoNotFoolTheChecker() {
        assertEquals(0, NixStoreRules.check("SELECT 'a; ATTACH x', \"b;c\", [d;e] FROM t"))
        assertEquals(0, NixStoreRules.check("SELECT 'it''s; ATTACH'"))
        assertEquals(0, NixStoreRules.check("SELECT 1 /* ; ATTACH */"))
        assertEquals(1, NixStoreRules.check("SELECT * FROM t WHERE a = ? AND b = '?'"))
        assertEquals(2, NixStoreRules.check("INSERT INTO t(a,b) VALUES (?,?)"))
    }

    @Test fun refusesTheTokenizerFunctionInEveryQuoting() {
        for (sql in listOf(
            "SELECT fts3_tokenizer(?)",
            "SELECT FTS3_Tokenizer(?)",
            "SELECT \"fts3_tokenizer\"(?)",
            "SELECT `fts3_tokenizer`(?)",
            "SELECT [fts3_tokenizer](?)",
            "SELECT \"FTS3_TOKENIZER\" (?)",
            "SELECT fts3_tokenizer /* x */ (?, ?)",
            "SELECT fts3_tokenizer\n--c\n(?, ?)",
            "SELECT \"fts3_tokenizer\"\t(?,?)",
            "CREATE VIRTUAL TABLE t USING fts3(tokenize=fts3_tokenizer)",
            "WITH x AS (SELECT fts3_tokenizer(?)) SELECT * FROM x",
            "INSERT INTO t VALUES (fts3_tokenizer(?))",
            "SELECT load_extension(?)",
            "SELECT readfile(?)",
        )) refused(sql)
        // A string that only mentions it is data.
        assertEquals(0, NixStoreRules.check("SELECT 'fts3_tokenizer'"))
    }

    @Test fun quotedNamesAreNotKeywordsOrParameters() {
        refused("\"attach\" '/x' AS v")
        assertEquals(0, NixStoreRules.check("SELECT \"?\" FROM t"))
        assertEquals(0, NixStoreRules.check("SELECT \"a;b\", [c;d] FROM t"))
        assertEquals(0, NixStoreRules.check("SELECT \"it\"\"s\" FROM t"))
    }

    @Test fun refusesPragmaFunctionsOutsideTheAllowList() {
        for (sql in listOf(
            "SELECT * FROM pragma_database_list",
            "SELECT * FROM PRAGMA_DATABASE_LIST()",
            "SELECT * FROM \"pragma_database_list\"",
            "SELECT * FROM [pragma_table_info]('t')",
            "SELECT * FROM pragma_writable_schema",
        )) refused(sql)
        assertEquals(0, NixStoreRules.check("SELECT * FROM pragma_foreign_keys"))
    }

    @Test fun refusesTheRtreeFunctionsAndPragmaFunctionsNamedAsStrings() {
        for (fn in listOf("rtreenode", "rtreedepth", "rtreecheck", "RTREENODE", "\"rtreecheck\""))
            refused("SELECT $fn(2, ?)")
        for (name in listOf("pragma_database_list", "pragma_table_info", "pragma_function_list", "PRAGMA_Database_List"))
            for (quoted in listOf("'$name'", "\"$name\"", "`$name`", "[$name]"))
                refused("SELECT * FROM $quoted")
        refused("SELECT * FROM 'pragma_table_info'('t')")
        NixStoreRules.check("SELECT * FROM 'pragma_foreign_keys'")
    }

    @Test fun anIndexOrTriggerMayDeclareANameThatEndsLikeAShadowTable() {
        // The mirror's own index.
        assertEquals(0, NixStoreRules.check("CREATE INDEX IF NOT EXISTS mirror_item_parent ON mirror_item (parent_id)"))
        NixStoreRules.check("CREATE UNIQUE INDEX x_data ON t(a)")
        NixStoreRules.check("CREATE TRIGGER IF NOT EXISTS t_config AFTER DELETE ON m BEGIN DELETE FROM s WHERE rowid=old.id; END")
        // But it cannot index or write a shadow table.
        refused("CREATE INDEX i ON mirror_search_data (a)")
        refused("CREATE INDEX i ON 'mirror_search_idx' (a)")
    }

    @Test fun theDownloadCeilingCannotBeRaisedByThePage() {
        assertEquals(NixDownload.MAX_FILE_BYTES, NixDownload.limit(0))
        assertEquals(NixDownload.MAX_FILE_BYTES, NixDownload.limit(-5))
        assertEquals(NixDownload.MAX_FILE_BYTES, NixDownload.limit(Long.MAX_VALUE))
        assertEquals(NixDownload.MAX_FILE_BYTES, NixDownload.limit(NixDownload.MAX_FILE_BYTES + 1))
        assertEquals(1234L, NixDownload.limit(1234))
    }

    @Test fun refusesWritesToFullTextShadowTables() {
        for (suffix in listOf("data", "idx", "content", "docsize", "config", "segments", "segdir", "stat", "node", "parent", "rowid")) {
            // A string literal is accepted by SQLite as a table name.
            refused("INSERT INTO 'mirror_search_$suffix' VALUES (99, x'00')")
            refused("DELETE FROM 'mirror_search_$suffix'")
            refused("UPDATE 'MIRROR_SEARCH_${suffix.uppercase()}' SET v=99")
            refused("DROP TABLE 'mirror_search_$suffix'")
            refused("CREATE TABLE mirror_search_$suffix AS SELECT 1 AS id, x'ffff' AS block")
            refused("CREATE TABLE 'mirror_search_$suffix'(a)")
            refused("CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE 'x_$suffix' SET v=99; END")
            refused("CREATE TRIGGER t AFTER INSERT ON a BEGIN DELETE FROM [x_$suffix]; END")
            refused("INSERT INTO mirror_search_$suffix VALUES (1)")
            refused("UPDATE mirror_search_$suffix SET a=1")
            refused("DELETE FROM \"mirror_search_$suffix\"")
            refused("DROP TABLE [mirror_search_$suffix]")
            refused("ALTER TABLE `mirror_search_$suffix` RENAME TO x")
            refused("REPLACE INTO MIRROR_SEARCH_${suffix.uppercase()} VALUES (1)")
            refused("WITH c AS (SELECT 1) DELETE FROM mirror_search_$suffix")
            // Reading is the page's own data.
            NixStoreRules.check("SELECT * FROM mirror_search_$suffix")
        }
        // The mirror's own tables and its writes to the index through the virtual table stay allowed.
        for (sql in listOf(
            "INSERT INTO mirror_search(item_id,title,body_text) VALUES(?,?,?)",
            "UPDATE mirror_search SET body_text='' WHERE item_id=?",
            "DELETE FROM mirror_search WHERE item_id=?",
            "INSERT INTO s(s,rank) VALUES('secure-delete',1)",
            "INSERT INTO mirror_setting(key,value) VALUES(?,?)",
        )) NixStoreRules.check(sql)
    }

    @Test fun pragmasAreAllowListed() {
        for (sql in listOf("PRAGMA foreign_keys=ON", "PRAGMA journal_mode=WAL", "PRAGMA synchronous=FULL", "pragma secure_delete = ON", "PRAGMA journal_mode"))
            NixStoreRules.check(sql)
        for (sql in listOf("PRAGMA database_list", "PRAGMA writable_schema = ON", "PRAGMA data_version", "PRAGMA main.journal_mode", "PRAGMA", "PRAGMA 'foreign_keys'", "PRAGMA user_version = 3"))
            refused(sql)
    }

    @Test fun allowsTheMirrorsOwnStatements() {
        for (sql in listOf(
            "CREATE VIRTUAL TABLE IF NOT EXISTS mirror_search USING fts5(item_id UNINDEXED, title, body_text)",
            "CREATE TRIGGER IF NOT EXISTS mirror_item_deleted AFTER DELETE ON mirror_item BEGIN DELETE FROM mirror_search WHERE item_id=old.id; END",
            "WITH RECURSIVE expired(id) AS (SELECT id FROM mirror_item WHERE expires_at<=?) DELETE FROM mirror_item WHERE id IN (SELECT id FROM expired) RETURNING id",
            "INSERT INTO s(s,rank) VALUES('secure-delete',1)",
            "SELECT json_extract(snapshot,'\$.file') FROM mirror_item WHERE id IN (SELECT value FROM json_each(?))",
            "ALTER TABLE t ADD COLUMN c TEXT",
            "DROP TABLE t",
            "INSERT OR REPLACE INTO t VALUES (?)",
        )) NixStoreRules.check(sql)
    }

    @Test fun aTriggerBodyMayHoldSemicolonsAndCaseButNotAnotherStatement() {
        assertEquals(0, NixStoreRules.check("CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET c = CASE WHEN 1 THEN 2 END; DELETE FROM d; END;"))
        refused("CREATE TRIGGER t AFTER INSERT ON a BEGIN DELETE FROM d; END; ATTACH '/x' AS v")
        refused("CREATE TRIGGER t AFTER INSERT ON a BEGIN DELETE FROM d; END; SELECT 1")
    }

    @Test fun valuesRoundTrip() {
        assertNull(NixStoreRules.fromWire(null))
        assertEquals(42L, NixStoreRules.fromWire(42))
        assertEquals(42L, NixStoreRules.fromWire(42L))
        assertEquals(1.5, NixStoreRules.fromWire(1.5))
        assertEquals(1L, NixStoreRules.fromWire(true))
        assertEquals("x", NixStoreRules.fromWire("x"))
        assertArrayEquals(byteArrayOf(0, 1, 2, -1), NixStoreRules.fromWire(mapOf("\$b64" to "AAEC/w==")) as ByteArray)
        assertEquals(mapOf("\$b64" to "AAEC/w=="), NixStoreRules.toWire(byteArrayOf(0, 1, 2, -1)))
        assertEquals(7L, NixStoreRules.toWire(7L))
        assertArrayEquals(ByteArray(0), NixStoreRules.fromWire(mapOf("\$b64" to "")) as ByteArray)
    }

    @Test fun badValuesAreRefused() {
        for (bad in listOf<Any>(mapOf("\$b64" to "!!!"), mapOf("\$b64" to 5), mapOf("a" to "b"), mapOf("\$b64" to "AA==", "x" to 1), listOf(1), Any()))
            try { NixStoreRules.fromWire(bad); fail("accepted $bad") } catch (_: StoreError) {}
    }

    @Test fun aStoreIsNamedByTheHashOfItsOriginAsOnIos() {
        // sha256("https://a.example"), the file stem NixStore.swift and sql-store.mjs use.
        assertEquals("38612c965a9c4c35d713439919804ad960eb54d0ad41b4362ffd85343d4bbb4f", NixStoreRules.storeId("https://a.example"))
        assert(NixStoreRules.storeId("https://a.example") != NixStoreRules.storeId("https://b.example"))
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", NixStoreRules.storeId(""))
    }

    @Test fun aFrameGetsTheStoreOfItsOwnSavedOriginOnly() {
        val saved = setOf("https://a.example", "http://localhost:5391")
        assertEquals("https://a.example", NixStoreRules.frameOrigin("https://a.example", true, saved))
        assertEquals("https://a.example", NixStoreRules.frameOrigin("https://A.example:443", true, saved))
        assertEquals("http://localhost:5391", NixStoreRules.frameOrigin("http://localhost:5391", true, saved))
        assertNull(NixStoreRules.frameOrigin("https://b.example", true, saved))
        assertNull(NixStoreRules.frameOrigin("https://a.example", false, saved))
        assertNull(NixStoreRules.frameOrigin("https://a.example.evil.example", true, saved))
        assertNull(NixStoreRules.frameOrigin("https://id.example", true, saved))
        assertNull(NixStoreRules.frameOrigin("null", true, saved))
        assertNull(NixStoreRules.frameOrigin(null, true, saved))
        assertNull(NixStoreRules.frameOrigin("https://a.example", true, emptySet()))
    }
}
