package com.nexorai.nexbot.sync

import com.nexorai.nexbot.core.ApprovalRow
import com.nexorai.nexbot.core.CoreClient
import com.nexorai.nexbot.data.ConnectionStore
import com.nexorai.nexbot.data.StoredConnection
import com.nexorai.nexbot.notifications.Notifier
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Before
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The repository against a fake Core, with no Android runtime: every request
 * shape, every state transition and the retry key are asserted here.
 */
class RepositoryTest {
    private class FakeStore(var saved: StoredConnection? = null) : ConnectionStore {
        override fun load(): StoredConnection? = saved

        override fun save(connection: StoredConnection) {
            saved = connection
        }

        override fun clear() {
            saved = null
        }
    }

    private class RecordingNotifier : Notifier {
        val approvals = mutableListOf<String>()
        val replies = mutableListOf<String>()

        override fun approval(botId: String, botName: String) {
            approvals.add(botId)
        }

        override fun reply(botId: String, botName: String) {
            replies.add(botId)
        }
    }

    /** Serves the live stream forever and everything else from an explicit queue. */
    private class Fixture : Dispatcher() {
        private val queued = ArrayDeque<MockResponse>()

        fun enqueue(response: MockResponse) {
            synchronized(queued) { queued.addLast(response) }
        }

        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.path.orEmpty()
            if (path.startsWith("/api/events")) {
                return MockResponse()
                    .setResponseCode(200)
                    .setHeader("Content-Type", "text/event-stream")
                    .setBody("")
            }
            synchronized(queued) { if (queued.isNotEmpty()) return queued.removeFirst() }
            return MockResponse().setResponseCode(404).setBody("""{"error":"unexpected request"}""")
        }
    }

    private lateinit var server: MockWebServer
    private lateinit var fixture: Fixture
    private lateinit var scope: CoroutineScope
    private lateinit var store: FakeStore

    @Before
    fun setUp() {
        server = MockWebServer()
        fixture = Fixture()
        server.start()
        server.dispatcher = fixture
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        store = FakeStore()
    }

    @After
    fun tearDown() {
        scope.cancel()
        server.shutdown()
    }

    // ---- fixtures --------------------------------------------------------

    // MockWebServer advertises the machine's own host name; the phone's rule
    // only accepts loopback or a private address, so name the fixture by IP.
    private fun origin(): String = "http://127.0.0.1:${server.port}"

    private fun repository(notifier: Notifier = Notifier.None): Repository = Repository(
        store = store,
        notifier = notifier,
        clientFactory = { address -> CoreClient(address) },
        scope = scope,
        deviceName = { "Pixel Test · Android" },
        tailDelayMs = 1,
        snapshotMinIntervalMs = 1,
        tickMs = 3_600_000,
        backgroundGraceMs = 1,
    )

    private fun json(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json; charset=utf-8")
        .setBody(body)

    private fun identityBody() = """{"version":1,"coreId":"core-1","loginRequired":true,"initialized":true,"loginMethods":["password"]}"""

    private fun resumeBody() = """{"authenticated":true,"protocol":"native-v1","sessionId":"s1","coreId":"core-1","expiresAt":${System.currentTimeMillis() + 3_600_000}}"""

    private fun sessionBody() = """{"token":"token-1","sessionId":"s1","coreId":"core-1","expiresAt":${System.currentTimeMillis() + 3_600_000},"protocol":"native-v1","version":1}"""

    private fun stateBody(
        bots: List<String> = emptyList(),
        approvals: List<String> = emptyList(),
        cursor: Long = 1,
    ) = """{"view":"summary","sync":{"cursor":$cursor,"privacyEpoch":1,"coreId":"ws-1","bootId":"boot-1"},"bots":[${bots.joinToString(",")}],"tasks":[],"approvals":[${approvals.joinToString(",")}],"routines":[],"occurrences":[],"memories":[],"devices":[],"onlineDevices":[],"delegations":[],"journal":[]}"""

    private fun bot(id: String, name: String, unread: Int = 0) =
        """{"id":"$id","name":"$name","version":1,"read_seq":0,"unread_count":$unread,"last_message":"hi"}"""

    private fun approval(id: String, hash: String, botId: String = "bot-1") =
        """{"id":"$id","argument_hash":"$hash","expires_at":0,"tool_name":"device.exec","arguments_json":"{}","authorization_snapshot_json":"{}","bot_id":"$botId","conversation_id":"c1","task_id":"t1","call_id":"call-1"}"""

    private fun message(id: String, seq: Long, role: String, content: String) =
        """{"id":"$id","bot_id":"bot-1","seq":$seq,"role":"$role","kind":"message","content":"$content"}"""

    private fun messagesBody(messages: List<String>, hasMore: Boolean = false) =
        """{"sync":{"cursor":1,"privacyEpoch":1,"coreId":"ws-1","bootId":"boot-1"},"messages":[${messages.joinToString(",")}],"hasMore":$hasMore,"streaming":[]}"""

    private suspend fun await(
        repo: Repository,
        timeout: Long = 5_000,
        predicate: (Repository.UiState) -> Boolean,
    ): Repository.UiState = withTimeout(timeout) { repo.state.first(predicate) }

    private suspend fun readyRepo(notifier: Notifier = Notifier.None): Repository {
        store.saved = StoredConnection(
            origin = origin(),
            publicCoreId = "core-1",
            token = "token-old",
            sessionId = "s1",
            expiresAt = System.currentTimeMillis() + 3_600_000,
        )
        fixture.enqueue(json(resumeBody()))
        fixture.enqueue(json(stateBody(bots = listOf(bot("bot-1", "Ada")))))
        val repo = repository(notifier)
        repo.start()
        await(repo) {
            it.phase == Repository.Phase.Ready && it.bots.any { bot -> bot.id == "bot-1" }
        }
        return repo
    }

    /** Drain recorded requests until [wanted] matching [prefix] are seen. */
    private fun requestsFor(prefix: String, wanted: Int = 1, timeoutMs: Long = 5_000): List<RecordedRequest> {
        val found = mutableListOf<RecordedRequest>()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (found.size < wanted && System.currentTimeMillis() < deadline) {
            val request = server.takeRequest(50, TimeUnit.MILLISECONDS) ?: continue
            if (request.path.orEmpty().startsWith(prefix)) found.add(request)
        }
        return found
    }

    /** Drain everything recorded so far, in order. */
    private fun drainRequests(timeoutMs: Long = 200): List<RecordedRequest> {
        val found = mutableListOf<RecordedRequest>()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val request = server.takeRequest(50, TimeUnit.MILLISECONDS) ?: break
            found.add(request)
        }
        return found
    }

    // ---- tests -----------------------------------------------------------

    @Test
    fun `login stores the session and shows the fleet`() = runBlocking {
        fixture.enqueue(json(identityBody()))
        fixture.enqueue(json("""{"transactionId":"tx-1","bindingToken":"bind-1","stepId":"step-1","challenge":"password","expiresAt":0}"""))
        fixture.enqueue(json(sessionBody()))
        fixture.enqueue(json(stateBody(bots = listOf(bot("bot-1", "Ada")))))
        val repo = repository()
        repo.start()
        await(repo) { it.phase == Repository.Phase.Login }

        repo.login(origin(), "owner@example.test", " synthetic password ")
        val ready = try {
            await(repo) {
                it.phase == Repository.Phase.Ready && it.bots.any { bot -> bot.id == "bot-1" }
            }
        } catch (timeout: kotlinx.coroutines.TimeoutCancellationException) {
            val current = repo.state.value
            val paths = drainRequests().map { it.path }
            throw AssertionError(
                "origin=${origin()} phase=${current.phase} error=${current.error} busy=${current.busy} bots=${current.bots.size} paths=$paths",
                timeout,
            )
        }
        assertEquals("core-1", ready.connection?.publicCoreId)
        assertEquals("token-1", store.saved?.token)
        assertEquals("owner@example.test", store.saved?.account)
        val requests = requestsFor("/api/auth/", wanted = 2)
        assertEquals(listOf("/api/auth/start", "/api/auth/respond"), requests.map { it.path })
        assertTrue(requests.last().body.readUtf8().contains("\"password\":\" synthetic password \""))
        repo.close()
    }

    @Test
    fun `resume sends the saved token only to the recorded Core`() = runBlocking {
        val repo = readyRepo()
        val requests = drainRequests()
        val stateRequest = requests.firstOrNull { it.path.orEmpty().startsWith("/api/state") }
        assertNotNull(stateRequest)
        assertEquals("Bearer token-old", stateRequest.getHeader("Authorization"))
        val resumeRequest = requests.firstOrNull { it.path.orEmpty().startsWith("/api/session") }
        assertNotNull(resumeRequest)
        assertTrue(resumeRequest.body.readUtf8().contains("token-old"))
        repo.close()
    }

    @Test
    fun `a failed send keeps the idempotency key for the retry`() = runBlocking {
        val repo = readyRepo()
        fixture.enqueue(json(messagesBody(listOf(message("m1", 1, "assistant", "hello")))))
        fixture.enqueue(json(stateBody(bots = listOf(bot("bot-1", "Ada")))))
        fixture.enqueue(json(messagesBody(emptyList())))
        repo.selectBot("bot-1")
        await(repo) { it.messages.size == 1 }
        // Let selectBot's forced snapshot and tail finish before queueing the
        // send responses; otherwise a background reload can consume them.
        delay(300)
        drainRequests()

        fixture.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        repo.send("hello")
        val first = requestsFor("/api/agents/input").single()
        fixture.enqueue(json("""{"taskId":"task-1"}"""))
        repo.send("hello")
        val second = requestsFor("/api/agents/input").single()
        val ids = listOf(first, second).map { request ->
            Regex("\"clientId\":\"([^\"]+)\"").find(request.body.readUtf8())?.groupValues?.get(1)
        }
        assertNotNull(ids[0])
        assertEquals(ids[0], ids[1])
        repo.close()
    }

    @Test
    fun `an approval decision posts the hash from the snapshot`() = runBlocking {
        val repo = readyRepo()
        repo.decide(
            ApprovalRow(id = "approval-1", argumentHash = "hash-1", toolName = "device.exec", botId = "bot-1"),
            allow = true,
        )
        val request = requestsFor("/api/approvals").firstOrNull()
        assertNotNull(request)
        val body = request.body.readUtf8()
        assertTrue(body.contains("\"id\":\"approval-1\""), body)
        assertTrue(body.contains("\"hash\":\"hash-1\""), body)
        assertTrue(body.contains("\"allow\":true"), body)
        repo.close()
    }

    @Test
    fun `a revoked session clears the stored connection and returns to login`() = runBlocking {
        store.saved = StoredConnection(
            origin = origin(),
            publicCoreId = "core-1",
            token = "token-old",
            sessionId = "s1",
            expiresAt = System.currentTimeMillis() + 3_600_000,
        )
        fixture.enqueue(json(resumeBody()))
        fixture.enqueue(
            MockResponse().setResponseCode(401)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":"Unauthorized"}"""),
        )
        val repo = repository()
        repo.start()
        await(repo) { it.phase == Repository.Phase.Login }
        assertNull(store.saved)
        repo.close()
    }

    @Test
    fun `a public http address is refused before any request`() = runBlocking {
        val repo = repository()
        repo.start()
        await(repo) { it.phase == Repository.Phase.Login }
        repo.login("http://bot.example.com", "owner@example.test", "pw")
        val failed = await(repo) { it.error != null }
        assertEquals(Repository.Phase.Login, failed.phase)
        assertTrue(failed.error!!.contains("https", ignoreCase = true), failed.error)
        repo.close()
    }

    @Test
    fun `new unread mail on another bot is announced once`() = runBlocking {
        val notifier = RecordingNotifier()
        val repo = readyRepo(notifier)
        fixture.enqueue(json(stateBody(bots = listOf(bot("bot-2", "Beta", unread = 1)))))
        repo.retry()
        await(repo) { it.bots.firstOrNull { bot -> bot.id == "bot-2" }?.unreadCount == 1L }
        assertTrue(notifier.replies.contains("bot-2"), notifier.replies.toString())
        // A snapshot with the same unread count must not announce again.
        fixture.enqueue(json(stateBody(bots = listOf(bot("bot-2", "Beta", unread = 1)))))
        repo.retry()
        delay(150)
        assertEquals(1, notifier.replies.count { it == "bot-2" })
        repo.close()
    }
}
