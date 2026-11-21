package app.nix.shell

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.concurrent.thread

class NixBackgroundSyncTest {
    @After fun reset() {
        NixBackgroundSync.dispatcher = null
        NixBackgroundSync.keepAwake(false)
    }

    @Test fun withNoPageItEndsAtOnce() {
        assertFalse(NixBackgroundSync.runPass(startWaitMs = 10_000, limitMs = 10_000))
    }

    @Test fun aPageThatDeclinesEndsAtOnce() {
        NixBackgroundSync.dispatcher = { false }
        assertFalse(NixBackgroundSync.runPass(startWaitMs = 10_000, limitMs = 10_000))
    }

    @Test fun endsWhenThePageSaysItIsDone() {
        var dispatched = 0
        NixBackgroundSync.dispatcher = {
            dispatched++
            thread { NixBackgroundSync.keepAwake(true); Thread.sleep(50); NixBackgroundSync.keepAwake(false) }
            true
        }
        assertTrue(NixBackgroundSync.runPass(startWaitMs = 5_000, limitMs = 5_000))
        assertEquals(1, dispatched)
    }

    @Test fun endsWhenNoPassStartsInTime() {
        NixBackgroundSync.dispatcher = { true }
        val began = System.nanoTime()
        assertFalse(NixBackgroundSync.runPass(startWaitMs = 100, limitMs = 10_000))
        assertTrue((System.nanoTime() - began) / 1_000_000 < 5_000)
    }

    @Test fun endsAtTheLimitWhenThePassNeverFinishes() {
        NixBackgroundSync.dispatcher = { thread { NixBackgroundSync.keepAwake(true) }; true }
        assertFalse(NixBackgroundSync.runPass(startWaitMs = 5_000, limitMs = 150))
    }

    @Test fun aMessageWithNoPassWaitingChangesNothing() {
        NixBackgroundSync.keepAwake(true)
        NixBackgroundSync.keepAwake(false)
        NixBackgroundSync.dispatcher = { true }
        // The earlier messages did not leave a pass started or finished.
        assertFalse(NixBackgroundSync.runPass(startWaitMs = 100, limitMs = 100))
    }
}
