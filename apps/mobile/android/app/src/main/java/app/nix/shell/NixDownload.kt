package app.nix.shell

import java.io.File
import java.net.CookieHandler
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/**
 * A download thread's requests carry no cookies and store none. Capacitor installs a VM-wide
 * `CookieHandler` that reads and writes the WebView's cookie jar (HttpOnly session cookies
 * included) for any URL, and `HttpURLConnection` consults it, so without this a page on one saved
 * server could download another server's session endpoint with that server's cookies and read the
 * answer back. iOS gets the same from `httpCookieStorage = nil` on the download session.
 * Every other thread still goes through the handler it wrapped.
 */
class DownloadCookieGuard(private val inner: CookieHandler?) : CookieHandler() {
    override fun get(uri: URI?, requestHeaders: MutableMap<String, MutableList<String>>?): MutableMap<String, MutableList<String>> =
        if (NixDownload.onDownloadThread()) HashMap() else inner?.get(uri, requestHeaders) ?: HashMap()

    override fun put(uri: URI?, responseHeaders: MutableMap<String, MutableList<String>>?) {
        if (!NixDownload.onDownloadThread()) inner?.put(uri, responseHeaders)
    }
}

object NixDownload {
    /** The most a download may store when the page names no size; the same ceiling as the web side's offline file limit. */
    const val MAX_FILE_BYTES = 100L * 1024 * 1024
    const val MAX_REDIRECTS = 5

    private val downloading = ThreadLocal<Boolean>()

    /** The page may name a smaller size than the ceiling, never a larger one. */
    fun limit(expected: Long): Long = if (expected > 0) minOf(expected, MAX_FILE_BYTES) else MAX_FILE_BYTES

    fun onDownloadThread(): Boolean = downloading.get() == true

    /**
     * Wraps the current default handler, unless it is already wrapped. Called when the shell loads and
     * before every hop, so a handler another plugin installs later is wrapped again.
     */
    @Synchronized
    fun ensureGuard() {
        if (CookieHandler.getDefault() !is DownloadCookieGuard) CookieHandler.setDefault(DownloadCookieGuard(CookieHandler.getDefault()))
    }

    /**
     * GETs `first` into `part`, following redirects only to `schemes` (https unless a test says
     * otherwise), and returns the byte count. Stops and deletes `part` past `maxBytes`, and does not
     * leave the file when `wanted` turns false (the store was wiped meanwhile). `track` receives the
     * live connection so a wipe can cut it. No URL is logged or put in an error.
     */
    internal fun fetch(
        first: URL,
        part: File,
        maxBytes: Long,
        wanted: () -> Boolean,
        track: (HttpURLConnection?) -> Unit,
        schemes: Set<String> = setOf("https"),
    ): Long {
        downloading.set(true)
        try {
            var url = first
            for (hop in 0..MAX_REDIRECTS) {
                ensureGuard()
                val connection = (url.openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = false
                    useCaches = false
                    connectTimeout = 30_000
                    readTimeout = 60_000
                }
                track(connection)
                try {
                    val status = connection.responseCode
                    if (status in 300..399) {
                        val next = connection.getHeaderField("Location")?.let { URL(url, it) }
                        if (next == null || next.protocol.lowercase() !in schemes || hop == MAX_REDIRECTS) throw StoreError("Download failed.")
                        url = next
                        continue
                    }
                    if (status !in 200..299) throw StoreError("Download failed.")
                    if (connection.contentLengthLong > maxBytes) throw StoreError("Download too large.")
                    if (!wanted()) throw StoreError("Download failed.")
                    var total = 0L
                    try {
                        connection.inputStream.use { input ->
                            part.outputStream().use { output ->
                                val buffer = ByteArray(1 shl 16)
                                while (true) {
                                    val n = input.read(buffer)
                                    if (n < 0) break
                                    total += n
                                    if (total > maxBytes) throw StoreError("Download too large.")
                                    output.write(buffer, 0, n)
                                }
                            }
                        }
                    } catch (e: Exception) {
                        part.delete()
                        throw e
                    }
                    return total
                } finally {
                    connection.disconnect()
                    track(null)
                }
            }
            throw StoreError("Download failed.")
        } finally {
            downloading.remove()
        }
    }
}
