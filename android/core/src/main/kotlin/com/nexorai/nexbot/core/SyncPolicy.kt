package com.nexorai.nexbot.core

/**
 * Timing and state rules a phone applies to the live stream.
 *
 * Pure on purpose: every value is asserted on a JVM with plain numbers, so the
 * expensive part (a real stream, a flaky radio) never has to be part of a test
 * that answers "did we coalesce, back off and decide to resnapshot correctly".
 * The numbers match `docs/plans/2026-10-17-android-client.md` §7.
 */
object SyncPolicy {
    /** Frames arrive per token while a reply streams; one tail request per window. */
    const val TAIL_COALESCE_MS = 120L

    /** With nothing executing, a change is a heartbeat, not a reason to hurry. */
    const val TAIL_IDLE_COALESCE_MS = 1_000L

    /** Snapshot is the expensive call; never more often than this. */
    const val SNAPSHOT_MIN_INTERVAL_MS = 2_000L

    /** Foreground fallback refresh even if no change frame arrives. */
    const val SNAPSHOT_TICK_MS = 10_000L

    /** A Core that does not understand `view=summary` gets the slower fallback. */
    const val FULL_STATE_TICK_MS = 15_000L

    /** Three missed heartbeats: Core sends one every 15 seconds. */
    const val STALE_AFTER_MS = 45_000L

    /** Refresh a session when this much of it is left. */
    const val REFRESH_LEAD_MS = 30 * 60_000L

    const val MAX_BACKOFF_MS = 10_000L

    /** 0.5s, 1s, 2s, 4s, 8s, then the cap. The caller adds up to ±20% jitter. */
    fun backoffMs(attempt: Int): Long {
        val exponent = attempt.coerceIn(0, 5)
        return (500L shl exponent).coerceAtMost(MAX_BACKOFF_MS)
    }

    fun isStale(nowMs: Long, lastFrameAtMs: Long, staleAfterMs: Long = STALE_AFTER_MS): Boolean =
        nowMs - lastFrameAtMs >= staleAfterMs

    fun shouldRefresh(nowMs: Long, expiresAtMs: Long, leadMs: Long = REFRESH_LEAD_MS): Boolean =
        expiresAtMs > nowMs && expiresAtMs - nowMs <= leadMs

    fun expired(nowMs: Long, expiresAtMs: Long): Boolean = expiresAtMs <= nowMs

    /**
     * A change frame invalidates the loaded snapshot when the stream cannot be
     * folded onto it: Core pruned past our cursor, the workspace changed, the
     * process restarted, or the privacy epoch moved (content was forgotten).
     */
    fun needsSnapshot(change: LiveFrame.Change, loaded: SyncState?): Boolean {
        if (change.reset) return true
        if (loaded == null) return true
        return change.coreId != loaded.coreId ||
            change.bootId != loaded.bootId ||
            change.privacyEpoch != loaded.privacyEpoch
    }

    /**
     * The desktop's typing rule without rooms: busy, not waiting on a card,
     * and nothing streaming yet. A streaming text turns the bubble into that
     * text instead of the dots (`AgentDesktop.tsx:145-146`).
     */
    fun showsProcessing(
        connected: Boolean,
        sending: Boolean,
        streamingText: String?,
        tasks: List<TaskRow>,
        approvals: List<ApprovalRow> = emptyList(),
    ): Boolean {
        if (!connected) return false
        if (approvals.isNotEmpty()) return false
        if (!streamingText.isNullOrEmpty()) return false
        if (sending) return true
        return tasks.any { it.status == "queued" || it.status == "running" || it.status == "cancelling" }
    }

    fun hasActiveWork(tasks: List<TaskRow>): Boolean =
        tasks.any { it.status == "queued" || it.status == "running" || it.status == "paused" || it.status == "cancelling" }

    /** The tail request's debounce window for the current moment. */
    fun tailDelayMs(hasActiveWork: Boolean): Long =
        if (hasActiveWork) TAIL_COALESCE_MS else TAIL_IDLE_COALESCE_MS
}
