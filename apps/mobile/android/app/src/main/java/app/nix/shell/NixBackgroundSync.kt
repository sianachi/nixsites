package app.nix.shell

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Background sync, with the contract of the iOS background-refresh task: the system wakes the app,
 * which asks the page that is already open to run one sync pass (the page listens for
 * `nix:background-sync`), and the pass ends when the page reports `keepAwake(false)`, when no pass
 * starts within a few seconds, or at the limit. It syncs only while the app process is alive with a
 * saved server's page loaded; with no page it ends at once. The page is the one that signs in and
 * holds the data, so the native side never syncs by itself.
 */
object NixBackgroundSync {
    const val EVENT_SCRIPT = "window.dispatchEvent(new Event('nix:background-sync'))"
    const val WORK = "nix.background-sync"
    const val START_WAIT_MS = 3_000L
    const val PASS_LIMIT_MS = 25_000L

    private class Pass {
        val started = CountDownLatch(1)
        val finished = CountDownLatch(1)
    }

    @Volatile private var pass: Pass? = null

    /** Asks the open server page to run a pass; set by the shell while its activity lives, null otherwise. */
    @Volatile var dispatcher: (() -> Boolean)? = null

    /** The page's `keepAwake` message: its pass started (true) or ended (false). Only a waiting background pass reacts. */
    fun keepAwake(on: Boolean) {
        pass?.let {
            it.started.countDown()
            if (!on) it.finished.countDown()
        }
    }

    /** Runs one pass and returns whether the page ran it. Blocks; call off the main thread. */
    fun runPass(startWaitMs: Long = START_WAIT_MS, limitMs: Long = PASS_LIMIT_MS): Boolean {
        val ask = dispatcher ?: return false
        val mine = Pass()
        pass = mine
        try {
            if (!ask()) return false
            if (!mine.started.await(startWaitMs, TimeUnit.MILLISECONDS)) return false
            return mine.finished.await(limitMs, TimeUnit.MILLISECONDS)
        } finally {
            pass = null
        }
    }

    /** Periodic, on a network, at the system's minimum interval; cancelled when no server is saved. */
    fun schedule(context: Context, enabled: Boolean) {
        val work = WorkManager.getInstance(context)
        if (!enabled) {
            work.cancelUniqueWork(WORK)
            return
        }
        val request = PeriodicWorkRequest.Builder(NixSyncWorker::class.java, 15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        work.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }
}

class NixSyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        NixBackgroundSync.runPass()
        return Result.success()
    }
}
