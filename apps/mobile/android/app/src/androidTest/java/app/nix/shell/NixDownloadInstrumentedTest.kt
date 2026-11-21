package app.nix.shell

import android.webkit.CookieManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.CookieHandler
import java.net.ServerSocket
import java.net.URI
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/**
 * Downloads against a local server (cleartext to localhost is allowed in debug builds). The `fetch`
 * seam takes http so the redirect and cookie rules can be seen without a TLS server; the production
 * entry point accepts https only.
 */
@RunWith(AndroidJUnit4::class)
class NixDownloadInstrumentedTest {
    private lateinit var dir: File
    private lateinit var server: ServerSocket
    private val requests = CopyOnWriteArrayList<String>()
    private var respond: (path: String) -> String = { "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi" }
    private var previous: CookieHandler? = null
    private val cookies = CookieManager.getInstance()

    private val base get() = "http://localhost:${server.localPort}"

    /** What Capacitor's CapacitorCookieManager does: the WebView jar, for any URL. */
    private val jarHandler = object : CookieHandler() {
        override fun get(uri: URI?, headers: MutableMap<String, MutableList<String>>?): MutableMap<String, MutableList<String>> {
            val cookie = cookies.getCookie(uri.toString())
            return if (cookie.isNullOrEmpty()) HashMap() else hashMapOf("Cookie" to mutableListOf(cookie))
        }

        override fun put(uri: URI?, headers: MutableMap<String, MutableList<String>>?) {
            headers?.get("Set-Cookie")?.forEach { cookies.setCookie(uri.toString(), it) }
        }
    }

    @Before fun setUp() {
        dir = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "dl-test-${System.nanoTime()}").also { it.mkdirs() }
        server = ServerSocket(0)
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (_: Exception) { return@thread }
                thread(isDaemon = true) {
                    socket.use {
                        val head = it.getInputStream().bufferedReader().let { r -> generateSequence { r.readLine() }.takeWhile { line -> line.isNotEmpty() }.toList() }
                        requests.add(head.joinToString("\n"))
                        val path = head.firstOrNull()?.split(' ')?.getOrNull(1) ?: "/"
                        it.getOutputStream().write(respond(path).toByteArray())
                    }
                }
            }
        }
        previous = CookieHandler.getDefault()
        CookieHandler.setDefault(jarHandler)
        cookies.setAcceptCookie(true)
        NixDownload.ensureGuard()
    }

    @After fun tearDown() {
        server.close()
        CookieHandler.setDefault(previous)
        cookies.removeAllCookies(null)
        dir.deleteRecursively()
    }

    private fun fetch(path: String, max: Long = 1000, wanted: () -> Boolean = { true }, schemes: Set<String> = setOf("http", "https")): Long =
        NixDownload.fetch(URL("$base$path"), File(dir, "part"), max, wanted, {}, schemes)

    @Test fun aDownloadSendsNoCookiesAndStoresNone() {
        cookies.setCookie("$base/", "session=secret")
        respond = { "HTTP/1.1 200 OK\r\nSet-Cookie: leaked=1\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi" }
        assertEquals(2, fetch("/auth/session"))
        assertFalse(requests.single(), requests.single().contains("Cookie", ignoreCase = true))
        assertFalse(cookies.getCookie("$base/").contains("leaked"))
    }

    @Test fun theSameRequestOnAnyOtherThreadStillCarriesTheJar() {
        // Proves the test sees the leak: without the download marker the WebView's cookie goes out.
        cookies.setCookie("$base/", "session=secret")
        val connection = URL("$base/x").openConnection() as java.net.HttpURLConnection
        assertEquals(200, connection.responseCode)
        connection.disconnect()
        assertTrue(requests.single(), requests.single().contains("Cookie: session=secret"))
    }

    @Test fun aHandlerInstalledLaterIsWrappedBeforeTheNextDownload() {
        cookies.setCookie("$base/", "session=secret")
        CookieHandler.setDefault(jarHandler)
        fetch("/a")
        assertFalse(requests.single(), requests.single().contains("Cookie", ignoreCase = true))
        assertTrue(CookieHandler.getDefault() is DownloadCookieGuard)
    }

    @Test fun aRedirectToHttpIsRefusedWhenOnlyHttpsIsAllowed() {
        respond = { "HTTP/1.1 302 Found\r\nLocation: http://localhost:${server.localPort}/b\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" }
        try { fetch("/a", schemes = setOf("https")); fail("followed") } catch (_: StoreError) {}
        assertEquals(1, requests.size)
    }

    @Test fun redirectsStopAtTheHopLimit() {
        respond = { "HTTP/1.1 302 Found\r\nLocation: $base/again\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" }
        try { fetch("/a"); fail("followed forever") } catch (_: StoreError) {}
        assertEquals(NixDownload.MAX_REDIRECTS + 1, requests.size)
    }

    @Test fun aFileOverTheCeilingIsStoppedAndDeleted() {
        respond = { "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + "x".repeat(5000) }
        try { fetch("/big", max = 1000); fail("stored") } catch (_: StoreError) {}
        assertFalse(File(dir, "part").exists())
        respond = { "HTTP/1.1 200 OK\r\nContent-Length: 5000\r\nConnection: close\r\n\r\n" + "x".repeat(5000) }
        try { fetch("/declared", max = 1000); fail("stored") } catch (_: StoreError) {}
        assertFalse(File(dir, "part").exists())
    }

    @Test fun noFileLandsOnceTheStoreIsNoLongerWanted() {
        try { fetch("/a", wanted = { false }); fail("stored") } catch (_: StoreError) {}
        assertFalse(File(dir, "part").exists())
    }

    @Test fun aDownloadThatFinishesAfterAWipeLeavesNothingBehind() {
        val stores = NixStores(dir, idleMs = 300)
        val origin = "https://a.example"
        val store = NixStore(origin, dir, java.util.concurrent.Executors.newCachedThreadPool(), java.util.concurrent.ScheduledThreadPoolExecutor(1), 300)
        // A wipe after the download began: the generation it captured is stale.
        store.wipe()
        try {
            store.download(URL("$base/a"), File(dir, "${NixStoreRules.storeId(origin)}-files/${NixStoreRules.storeId("k")}"), 1000, started = -1) {}
            fail("landed")
        } catch (_: StoreError) {}
        assertFalse(File(dir, "${NixStoreRules.storeId(origin)}-files").exists())
        assertTrue(requests.isEmpty())
        stores.wipe(origin) { _, _ -> }
    }
}
