package com.nexorai.nexbot.ui

import com.nexorai.nexbot.core.MessageRow
import java.time.Instant
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ChatItemsTest {
    private val zone = ZoneId.of("UTC")
    private val today = Instant.parse("2026-10-17T12:00:00Z").toEpochMilli()
    private val yesterday = Instant.parse("2026-10-16T09:00:00Z").toEpochMilli()

    private fun message(id: String, at: Long) = MessageRow(
        id = id,
        botId = "bot-1",
        seq = 1,
        role = "assistant",
        kind = "message",
        content = id,
        createdAt = at,
    )

    @Test
    fun `one divider per day, before its messages`() {
        val rows = chatItems(
            listOf(message("a", today), message("b", today + 60_000)),
            now = today,
            zone = zone,
        )
        assertEquals(3, rows.size)
        assertTrue(rows[0] is ChatItem.Day)
        assertEquals("今天", (rows[0] as ChatItem.Day).label)
        assertEquals("a", (rows[1] as ChatItem.Msg).message.id)
        assertEquals("b", (rows[2] as ChatItem.Msg).message.id)
    }

    @Test
    fun `a new day starts a new divider`() {
        val rows = chatItems(
            listOf(message("old", yesterday), message("new", today)),
            now = today,
            zone = zone,
        )
        assertEquals(2, rows.filterIsInstance<ChatItem.Day>().size)
        assertEquals(listOf("昨天", "今天"), rows.filterIsInstance<ChatItem.Day>().map { it.label })
    }

    @Test
    fun `day and time labels follow the local calendar`() {
        assertEquals("今天", dayLabel(today, now = today, zone = zone))
        assertEquals("昨天", dayLabel(yesterday, now = today, zone = zone))
        assertEquals("10月15日", dayLabel(Instant.parse("2026-10-15T08:00:00Z").toEpochMilli(), now = today, zone = zone))
        assertEquals("2025年12月31日", dayLabel(Instant.parse("2025-12-31T08:00:00Z").toEpochMilli(), now = today, zone = zone))
        assertEquals("12:00", timeLabel(today, zone = zone))
    }
}
