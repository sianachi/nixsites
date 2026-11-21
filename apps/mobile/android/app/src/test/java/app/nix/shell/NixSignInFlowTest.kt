package app.nix.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NixSignInFlowTest {
    private val issuer = "https://nix.example.com"
    private val good = "app.nix.shell://auth?code=abc&iss=https%3A%2F%2Fnix.example.com"

    private class Answers {
        val list = ArrayList<Triple<String?, String?, String?>>()
        val respond = NixSignInFlow.Respond { code, verifier, error -> list.add(Triple(code, verifier, error)) }
    }

    @Test fun aCallbackWithNoSignInWaitingIsIgnored() {
        val flow = NixSignInFlow()
        assertFalse(flow.callback(good))
        assertFalse(flow.waiting())
    }

    @Test fun theMatchingCallbackAnswersOnceAndIsSingleUse() {
        val flow = NixSignInFlow()
        val a = Answers()
        assertNotNull(flow.start(issuer, "verifier", a.respond))
        assertTrue(flow.callback(good))
        assertEquals(listOf(Triple<String?, String?, String?>("abc", "verifier", null)), a.list)
        // A replay of the same callback finds nothing waiting.
        assertFalse(flow.callback(good))
        assertEquals(1, a.list.size)
    }

    @Test fun aForgedCallbackFailsTheWaitingSignInAndFreesIt() {
        val flow = NixSignInFlow()
        val a = Answers()
        flow.start(issuer, "verifier", a.respond)
        assertTrue(flow.callback("app.nix.shell://auth?code=abc&iss=https%3A%2F%2Fevil.example.com"))
        assertEquals(listOf(Triple<String?, String?, String?>(null, null, "Sign-in could not be completed.")), a.list)
        // The genuine one that follows is too late: single use.
        assertFalse(flow.callback(good))
        assertFalse(flow.waiting())
        assertNotNull(flow.start(issuer, "v2", Answers().respond))
    }

    @Test fun onlyOneSignInWaitsAtATime() {
        val flow = NixSignInFlow()
        assertNotNull(flow.start(issuer, "v", Answers().respond))
        assertNull(flow.start(issuer, "v2", Answers().respond))
    }

    @Test fun returningWithoutACallbackAfterLeavingIsACancel() {
        val flow = NixSignInFlow()
        val a = Answers()
        flow.start(issuer, "v", a.respond)
        flow.paused()
        flow.resumed()
        assertEquals(listOf(Triple<String?, String?, String?>(null, null, "cancelled")), a.list)
        assertFalse(flow.waiting())
    }

    @Test fun aResumeThatNeverFollowedAPauseIsNotACancel() {
        val flow = NixSignInFlow()
        val a = Answers()
        flow.start(issuer, "v", a.respond)
        flow.resumed()
        assertTrue(a.list.isEmpty())
        assertTrue(flow.waiting())
    }

    @Test fun theCallbackThatArrivesBeforeTheResumeWins() {
        val flow = NixSignInFlow()
        val a = Answers()
        flow.start(issuer, "v", a.respond)
        flow.paused()
        flow.callback(good)
        flow.resumed()
        assertEquals(1, a.list.size)
        assertEquals("abc", a.list[0].first)
    }

    @Test fun aTabThatNeverOpenedTimesOutButAnOpenOneDoesNot() {
        val flow = NixSignInFlow()
        val a = Answers()
        val waiting = flow.start(issuer, "v", a.respond)!!
        flow.expire(waiting, "gave up")
        assertEquals(listOf(Triple<String?, String?, String?>(null, null, "gave up")), a.list)
        assertFalse(flow.waiting())

        val b = Answers()
        val opened = flow.start(issuer, "v", b.respond)!!
        flow.paused()
        flow.expire(opened, "gave up")
        assertTrue(b.list.isEmpty())
        assertTrue(flow.waiting())
        // A timeout for an earlier sign-in never ends a later one.
        flow.resumed()
        val later = flow.start(issuer, "v", Answers().respond)!!
        flow.expire(waiting, "gave up")
        assertTrue(flow.waiting())
        assertNotNull(later)
    }
}
