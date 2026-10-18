package com.nexorai.nexbot.core

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Before
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** One client against a fake Core, so the request shapes are asserted too. */
class CoreClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: CoreClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = CoreClient(server.url("/").toString().trimEnd('/'))
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun json(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json; charset=utf-8")
        .setBody(body)

    @Test
    fun `identity needs no bearer`() = runBlocking {
        server.enqueue(json("""{"version":1,"coreId":"c","loginRequired":true,"initialized":true,"loginMethods":["password"]}"""))
        val identity = client.identity()
        assertEquals("c", identity.coreId)
        val recorded = server.takeRequest()
        assertEquals("/api/client/identity", recorded.path)
        assertNull(recorded.getHeader("Authorization"))
    }

    @Test
    fun `login is a two step transaction and sends the password only once`() = runBlocking {
        server.enqueue(json("""{"transactionId":"t","bindingToken":"b","stepId":"s","challenge":"password","expiresAt":1}"""))
        server.enqueue(json("""{"token":"tok","sessionId":"sid","coreId":"c","expiresAt":2}"""))
        val transaction = client.startLogin("owner@example.test", "Pixel")
        val session = client.respondLogin(transaction, " synthetic password ")
        assertEquals("tok", session.token)
        val start = server.takeRequest()
        assertEquals("/api/auth/start", start.path)
        assertTrue(start.body.readUtf8().contains("\"account\":\"owner@example.test\""))
        assertNull(start.getHeader("Authorization"))
        val respond = server.takeRequest()
        assertEquals("/api/auth/respond", respond.path)
        assertTrue(respond.body.readUtf8().contains("\"password\":\" synthetic password \""))
    }

    @Test
    fun `summary state asks for the view and decodes it`() = runBlocking {
        server.enqueue(json("""{"view":"summary","sync":{"cursor":3},"bots":[],"memories":[{"id":"m","title":"t"}]}"""))
        client.useToken("tok")
        val state = client.state(summary = true)
        assertEquals("summary", state.view)
        assertNull(state.memories.single().content)
        val recorded = server.takeRequest()
        assertEquals("/api/state?view=summary", recorded.path)
        assertEquals("Bearer tok", recorded.getHeader("Authorization"))
    }

    @Test
    fun `full state keeps the default path`() = runBlocking {
        server.enqueue(json("""{"sync":{"cursor":3},"bots":[]}"""))
        client.state(summary = false)
        assertEquals("/api/state", server.takeRequest().path)
    }

    @Test
    fun `refresh rotates the stored bearer`() = runBlocking {
        server.enqueue(json("""{"token":"new","sessionId":"s","coreId":"c","expiresAt":99}"""))
        client.useToken("old")
        val session = client.refresh()
        assertEquals("new", session.token)
        assertEquals("new", client.token)
        val recorded = server.takeRequest()
        assertEquals("/api/auth/refresh", recorded.path)
        assertEquals("Bearer old", recorded.getHeader("Authorization"))
    }

    @Test
    fun `messages page by after and carry streaming text`() = runBlocking {
        server.enqueue(
            json("""{"sync":{"cursor":1},"messages":[{"id":"m1","seq":2,"role":"assistant","content":"hi"}],"hasMore":false,"streaming":[{"taskId":"t","text":"partial"}]}"""),
        )
        val feed = client.messages("bot-1", after = 1)
        assertEquals("partial", feed.streaming.single().text)
        assertEquals("/api/agents/messages?bot=bot-1&after=1", server.takeRequest().path)
    }

    @Test
    fun `sending reuses the caller's idempotency key`() = runBlocking {
        server.enqueue(json("""{"taskId":"task-1"}"""))
        client.useToken("tok")
        val receipt = client.send("bot-1", "你好", "client-1", listOf("a1", "a2"))
        assertEquals("task-1", receipt.taskId)
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"clientId\":\"client-1\""))
        assertTrue(body.contains("\"text\":\"你好\""))
        assertTrue(body.contains("\"botId\":\"bot-1\""))
        assertTrue(body.contains("\"attachments\":[\"a1\",\"a2\"]"))
    }

    @Test
    fun `an upload carries the base64 payload and returns the attachment`() = runBlocking {
        server.enqueue(json("""{"id":"a1","botId":"bot-1","name":"notes.md","mime":"text/markdown","size":5}"""))
        client.useToken("tok")
        val uploaded = client.uploadAttachment("bot-1", "notes.md", "aGVsbG8=")
        assertEquals("a1", uploaded.id)
        assertEquals("text/markdown", uploaded.mime)
        val recorded = server.takeRequest()
        assertEquals("/api/attachments", recorded.path)
        val body = recorded.body.readUtf8()
        assertTrue(body.contains("\"name\":\"notes.md\""))
        assertTrue(body.contains("\"data\":\"aGVsbG8=\""))
        assertEquals("Bearer tok", recorded.getHeader("Authorization"))
    }

    @Test
    fun `approval mode is saved with the bot version`() = runBlocking {
        server.enqueue(json("""{"ok":true}"""))
        client.useToken("tok")
        client.setApprovalMode("bot-1", "full", 3)
        val recorded = server.takeRequest()
        assertEquals("/api/bots/approval-mode", recorded.path)
        val body = recorded.body.readUtf8()
        assertTrue(body.contains("\"id\":\"bot-1\""))
        assertTrue(body.contains("\"mode\":\"full\""))
        assertTrue(body.contains("\"version\":3"))
    }

    @Test
    fun `attachments download with the bearer`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("hello"))
        client.useToken("tok")
        val bytes = client.download("/api/attachments/a1")
        assertEquals("hello", bytes.decodeToString())
        val recorded = server.takeRequest()
        assertEquals("/api/attachments/a1", recorded.path)
        assertEquals("Bearer tok", recorded.getHeader("Authorization"))
    }

    @Test
    fun `a refusal keeps the server message, status and code`() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(409)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":"任务、权限或审批已变化"}"""),
        )
        val failure = assertFailsWith<CoreException> { client.decide("approval-1", "hash-1", true) }
        assertEquals(409, failure.status)
        assertEquals("任务、权限或审批已变化", failure.message)
    }

    @Test
    fun `a non-json success body is reported instead of crashing`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("<html>"))
        val failure = assertFailsWith<CoreException> { client.identity() }
        assertEquals(200, failure.status)
    }

    @Test
    fun `the live stream decodes change and revoked and resumes from a cursor`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                "id: 7\n" +
                    "event: change\n" +
                    "data: {\"cursor\":7,\"privacyEpoch\":2,\"coreId\":\"c\",\"bootId\":\"b\",\"reset\":false}\n" +
                    "\n" +
                    "event: revoked\n" +
                    "data: {}\n" +
                    "\n",
            ),
        )
        client.useToken("tok")
        val frames = withTimeout(10_000) { client.events("6").toList() }
        assertEquals(2, frames.size)
        val change = frames[0]
        assertTrue(change is LiveFrame.Change)
        change as LiveFrame.Change
        assertEquals(7, change.cursor)
        assertEquals(2, change.privacyEpoch)
        assertEquals(false, change.reset)
        assertEquals(LiveFrame.Revoked, frames[1])
        val recorded = server.takeRequest()
        assertEquals("6", recorded.getHeader("Last-Event-ID"))
        // The stream is authenticated like every other request; without this
        // header Core answers 401 and the app falls back to polling.
        assertEquals("Bearer tok", recorded.getHeader("Authorization"))
        assertEquals("/api/events", recorded.path)
    }

    @Test
    fun `a stream that ends without frames completes instead of hanging`() = runBlocking {
        server.enqueue(MockResponse().setBody(""))
        val frames = withTimeout(10_000) { client.events().toList() }
        assertTrue(frames.isEmpty())
    }
}
