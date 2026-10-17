package com.nexorai.nexbot.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Decodes documents captured from a real Core (`scripts/capture-android-fixtures.mjs`,
 * run against a disposable workspace with synthetic identity). These are the
 * contract tests: a field renamed or dropped by Core shows up here, not on a
 * phone at runtime.
 */
class WireTest {
    private fun fixture(name: String): String =
        checkNotNull(javaClass.classLoader.getResourceAsStream("fixtures/$name")) { "missing fixture $name" }
            .bufferedReader(Charsets.UTF_8)
            .use { it.readText() }

    @Test
    fun `identity and login replies decode`() {
        val identity = CoreJson.decodeFromString(IdentityInfo.serializer(), fixture("identity.json"))
        assertEquals(1, identity.version)
        assertTrue(identity.loginRequired)
        assertTrue(identity.initialized)
        assertEquals(listOf("password"), identity.loginMethods)
        assertTrue(identity.coreId.isNotEmpty())

        val start = CoreJson.decodeFromString(LoginTransaction.serializer(), fixture("login-start.json"))
        assertEquals("password", start.challenge)
        assertTrue(start.transactionId.isNotEmpty())
        assertTrue(start.bindingToken.isNotEmpty())
        assertTrue(start.stepId.isNotEmpty())

        val session = CoreJson.decodeFromString(SessionInfo.serializer(), fixture("login-respond.json"))
        assertTrue(session.token.isNotEmpty())
        assertTrue(session.sessionId.isNotEmpty())
        assertEquals(identity.coreId, session.coreId)
        assertTrue(session.expiresAt > 0)
    }

    @Test
    fun `full state carries memory bodies and the finished-work journal`() {
        val state = CoreJson.decodeFromString(CoreState.serializer(), fixture("state-full.json"))
        assertNull(state.view)
        assertEquals(2, state.bots.size)
        assertEquals(1, state.routines.size)
        assertEquals("每周一上午整理发布清单。", state.memories.single().content)
        assertEquals(1, state.sync.cursor)
        assertTrue(state.sync.coreId.isNotEmpty())
        assertTrue(state.sync.bootId.isNotEmpty())
        // Host-only fields (policy body, device capabilities) are projected out
        // of fixtures; the tolerance case below proves unknown fields are ignored.
        assertTrue(state.bots.all { it.policyVersion == 1L })
        assertTrue(state.bots.any { it.unreadCount > 0 })
    }

    @Test
    fun `summary state omits memory bodies and names itself`() {
        val summary = CoreJson.decodeFromString(CoreState.serializer(), fixture("state-summary.json"))
        assertEquals("summary", summary.view)
        assertEquals(2, summary.bots.size)
        assertNull(summary.memories.single().content)
        assertTrue(summary.journal.isEmpty())
        assertEquals(summary.sync.coreId, CoreJson.decodeFromString(CoreState.serializer(), fixture("state-full.json")).sync.coreId)
    }

    @Test
    fun `messages keep roles, sequence, markdown and tool fields`() {
        val feed = CoreJson.decodeFromString(MessageFeed.serializer(), fixture("messages.json"))
        assertEquals(2, feed.messages.size)
        assertEquals(listOf("user", "assistant"), feed.messages.map { it.role })
        assertEquals(1L, feed.messages.first().seq)
        assertEquals(2L, feed.messages.last().seq)
        assertTrue(feed.messages.last().content.contains("### 发布清单"))
        assertTrue(feed.messages.last().content.contains("| 项 | 状态 |"))
        assertTrue(feed.streaming.isEmpty())
        assertEquals(false, feed.hasMore)
        assertEquals(1, feed.sync.cursor)
    }

    @Test
    fun `the captured live frame drives the parser and the change view`() {
        val frames = mutableListOf<SseFrame>()
        val parser = SseParser { frames += it }
        parser.feed(fixture("events.txt").toByteArray(Charsets.UTF_8))
        parser.finish()
        assertEquals(1, frames.size)
        assertEquals("change", frames.single().event)
        val change = frames.single().toLiveFrame() as LiveFrame.Change
        assertEquals(1, change.cursor)
        assertEquals(false, change.reset)
        assertEquals(frames.single().id, "1")
    }

    @Test
    fun `unknown fields and an unexpected view never fail decoding`() {
        val state = CoreJson.decodeFromString(
            CoreState.serializer(),
            """{"view":"something-new","sync":{"cursor":2,"extra":true},"bots":[{"id":"b","name":"n","brand_new":1}]}""",
        )
        assertEquals("something-new", state.view)
        assertEquals("b", state.bots.single().id)
        assertNotNull(state.bots.single().name)
    }
}
