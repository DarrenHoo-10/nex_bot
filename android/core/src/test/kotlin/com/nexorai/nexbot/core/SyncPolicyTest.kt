package com.nexorai.nexbot.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SyncPolicyTest {
    private fun task(status: String, tool: String? = null) = TaskRow(status = status, activeTool = tool)

    @Test
    fun `backoff doubles and stops at ten seconds`() {
        assertEquals(500, SyncPolicy.backoffMs(0))
        assertEquals(1_000, SyncPolicy.backoffMs(1))
        assertEquals(2_000, SyncPolicy.backoffMs(2))
        assertEquals(4_000, SyncPolicy.backoffMs(3))
        assertEquals(8_000, SyncPolicy.backoffMs(4))
        assertEquals(10_000, SyncPolicy.backoffMs(5))
        assertEquals(10_000, SyncPolicy.backoffMs(99))
        assertEquals(500, SyncPolicy.backoffMs(-3))
    }

    @Test
    fun `staleness is three missed heartbeats`() {
        assertFalse(SyncPolicy.isStale(44_999, 0))
        assertTrue(SyncPolicy.isStale(45_000, 0))
        assertTrue(SyncPolicy.isStale(90_000, 0))
    }

    @Test
    fun `a session refreshes only while it still has time and only inside the lead`() {
        val now = 1_000_000L
        assertTrue(SyncPolicy.shouldRefresh(now, now + 29 * 60_000))
        assertFalse(SyncPolicy.shouldRefresh(now, now + 31 * 60_000))
        assertFalse(SyncPolicy.shouldRefresh(now, now))
        assertFalse(SyncPolicy.shouldRefresh(now, now - 1))
        assertTrue(SyncPolicy.expired(now, now))
        assertFalse(SyncPolicy.expired(now, now + 1))
    }

    @Test
    fun `a reset, a new workspace, a restart or a privacy epoch needs a snapshot`() {
        val loaded = SyncState(cursor = 5, privacyEpoch = 2, coreId = "c", bootId = "b")
        val base = LiveFrame.Change(cursor = 6, privacyEpoch = 2, coreId = "c", bootId = "b", reset = false)
        assertFalse(SyncPolicy.needsSnapshot(base, loaded))
        assertTrue(SyncPolicy.needsSnapshot(base.copy(reset = true), loaded))
        assertTrue(SyncPolicy.needsSnapshot(base, null))
        assertTrue(SyncPolicy.needsSnapshot(base.copy(privacyEpoch = 3), loaded))
        assertTrue(SyncPolicy.needsSnapshot(base.copy(coreId = "other"), loaded))
        assertTrue(SyncPolicy.needsSnapshot(base.copy(bootId = "restart"), loaded))
    }

    @Test
    fun `processing follows the desktop rule`() {
        assertFalse(SyncPolicy.showsProcessing(connected = false, sending = true, streamingText = null, tasks = emptyList()))
        assertTrue(SyncPolicy.showsProcessing(connected = true, sending = true, streamingText = null, tasks = emptyList()))
        assertTrue(SyncPolicy.showsProcessing(connected = true, sending = false, streamingText = null, tasks = listOf(task("running"))))
        assertTrue(SyncPolicy.showsProcessing(connected = true, sending = false, streamingText = null, tasks = listOf(task("cancelling"))))
        assertFalse(SyncPolicy.showsProcessing(connected = true, sending = false, streamingText = null, tasks = listOf(task("paused"))))
        assertFalse(SyncPolicy.showsProcessing(connected = true, sending = false, streamingText = "partial", tasks = listOf(task("running"))))
        assertFalse(
            SyncPolicy.showsProcessing(
                connected = true,
                sending = true,
                streamingText = null,
                tasks = emptyList(),
                approvals = listOf(ApprovalRow(id = "a")),
            ),
        )
    }

    @Test
    fun `the tail window is faster only while work is active`() {
        assertEquals(SyncPolicy.TAIL_COALESCE_MS, SyncPolicy.tailDelayMs(hasActiveWork = true))
        assertEquals(SyncPolicy.TAIL_IDLE_COALESCE_MS, SyncPolicy.tailDelayMs(hasActiveWork = false))
        assertTrue(SyncPolicy.hasActiveWork(listOf(task("paused"))))
        assertFalse(SyncPolicy.hasActiveWork(listOf(task("succeeded"))))
    }
}
