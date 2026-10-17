package com.nexorai.nexbot.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SseTest {
    /** Feed the text in three-byte slices so the parser is exercised mid-frame. */
    private fun parse(text: String): List<SseFrame> {
        val frames = mutableListOf<SseFrame>()
        val parser = SseParser { frames += it }
        val bytes = text.toByteArray(Charsets.UTF_8)
        var index = 0
        while (index < bytes.size) {
            val size = minOf(3, bytes.size - index)
            parser.feed(bytes.copyOfRange(index, index + size))
            index += size
        }
        return frames
    }

    @Test
    fun `reads one change frame with its id`() {
        val frames = parse("id: 7\nevent: change\ndata: {\"cursor\":7}\n\n")
        assertEquals(1, frames.size)
        assertEquals("7", frames.single().id)
        assertEquals("change", frames.single().event)
        assertEquals("{\"cursor\":7}", frames.single().data)
    }

    @Test
    fun `joins multi line data and ignores comments`() {
        val frames = parse(": keepalive\n\ndata: first\ndata: second\n\n")
        assertEquals(1, frames.size)
        assertEquals("first\nsecond", frames.single().data)
        assertEquals("message", frames.single().event)
    }

    @Test
    fun `accepts CRLF, LF and CR line endings`() {
        assertEquals(1, parse("id: 1\r\nevent: change\r\ndata: a\r\n\r\n").size)
        assertEquals(1, parse("id: 2\revent: change\rdata: b\r\r").size)
        assertEquals("a", parse("id: 1\r\nevent: change\r\ndata: a\r\n\r\n").single().data)
    }

    @Test
    fun `keeps the last id across events as SSE requires`() {
        val frames = parse("id: 9\nevent: change\ndata: {}\n\nevent: revoked\ndata: {}\n\n")
        assertEquals(2, frames.size)
        assertEquals("9", frames[0].id)
        assertEquals("9", frames[1].id)
        assertEquals("revoked", frames[1].event)
    }

    @Test
    fun `decodes a change payload`() {
        val frame = parse("id: 4\nevent: change\ndata: {\"cursor\":4,\"privacyEpoch\":2,\"coreId\":\"c\",\"bootId\":\"b\",\"reset\":true}\n\n").single()
        val live = frame.toLiveFrame()
        assertTrue(live is LiveFrame.Change)
        live as LiveFrame.Change
        assertEquals(4, live.cursor)
        assertEquals(2, live.privacyEpoch)
        assertEquals("c", live.coreId)
        assertEquals("b", live.bootId)
        assertTrue(live.reset)
    }

    @Test
    fun `decodes revoked and keeps unknown events as data`() {
        assertEquals(LiveFrame.Revoked, parse("event: revoked\ndata: {}\n\n").single().toLiveFrame())
        val unknown = parse("event: future-thing\ndata: x\n\n").single().toLiveFrame()
        assertTrue(unknown is LiveFrame.Unknown)
        assertEquals("future-thing", (unknown as LiveFrame.Unknown).event)
    }

    @Test
    fun `a malformed change payload does not throw`() {
        val live = parse("event: change\ndata: not-json\n\n").single().toLiveFrame()
        assertTrue(live is LiveFrame.Unknown)
    }

    @Test
    fun `flushes a frame without a trailing blank line`() {
        val frames = mutableListOf<SseFrame>()
        val parser = SseParser { frames += it }
        parser.feed("event: change\ndata: {}".toByteArray())
        parser.finish()
        assertEquals(1, frames.size)
    }
}
