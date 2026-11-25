package com.nexorai.nexbot.core

import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CliStreamRelayTest {
    private class Recorder : CliStreamRelay.Sink {
        val events = LinkedBlockingQueue<String>()
        override fun opened(id: String) { events.add("open:$id") }
        override fun text(id: String, text: String) { events.add("text:$id:$text") }
        override fun binary(id: String, base64: String) { events.add("binary:$id:$base64") }
        override fun closed(id: String, code: Int) { events.add("closed:$id:$code") }
        fun next(): String = assertNotNull(events.poll(5, TimeUnit.SECONDS), "no event")
        fun none() = assertNull(events.poll(300, TimeUnit.MILLISECONDS))
    }

    /** What the Core side of the fake socket saw and the handle to push frames back. */
    private class Peer : WebSocketListener() {
        val received = LinkedBlockingQueue<Any>()
        val closes = LinkedBlockingQueue<Int>()
        val socket = LinkedBlockingQueue<WebSocket>()
        override fun onOpen(webSocket: WebSocket, response: Response) { socket.add(webSocket) }
        override fun onMessage(webSocket: WebSocket, text: String) { received.add(text) }
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) { received.add(bytes) }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { closes.add(code); webSocket.close(code, null) }
        fun live(): WebSocket = assertNotNull(socket.poll(5, TimeUnit.SECONDS), "no upgrade")
        fun frame(): Any = assertNotNull(received.poll(5, TimeUnit.SECONDS), "no frame")
    }

    private fun relay(server: MockWebServer, sink: CliStreamRelay.Sink, token: () -> String? = { "fixture-token" }, http: OkHttpClient = CoreClient.defaultHttp()) =
        CliStreamRelay(server.url("/").toString(), token, sink, http)

    @Test fun `stream url follows the origin scheme and never takes a page path`() {
        assertEquals("wss://core.example/api/cli-agents/stream", CliStreamRelay.streamUrl("https://core.example/"))
        assertEquals("ws://127.0.0.1:3000/api/cli-agents/stream", CliStreamRelay.streamUrl("http://127.0.0.1:3000"))
        assertFailsWith<IllegalArgumentException> { CliStreamRelay.streamUrl("ftp://core.example") }
    }

    @Test fun `upgrade carries the current bearer and frames cross in both directions`() {
        MockWebServer().use { server ->
            val peer = Peer()
            server.enqueue(MockResponse().withWebSocketUpgrade(peer))
            val sink = Recorder()
            val relay = relay(server, sink)
            relay.open("s1")
            val request = server.takeRequest(5, TimeUnit.SECONDS)!!
            assertEquals("/api/cli-agents/stream", request.path)
            assertEquals("Bearer fixture-token", request.getHeader("Authorization"))
            assertNull(request.getHeader("Origin"))
            assertEquals("open:s1", sink.next())
            val core = peer.live()

            core.send("""{"type":"list"}""")
            assertEquals("""text:s1:{"type":"list"}""", sink.next())
            core.send(byteArrayOf(1, 0, 0, 0, 7, 104, 105).toByteString())
            assertEquals("binary:s1:AQAAAAdoaQ==", sink.next())

            relay.sendText("s1", """{"type":"ping"}""")
            assertEquals("""{"type":"ping"}""", peer.frame())
            relay.sendBinary("s1", "AgAAAAdoaQ==")
            assertEquals(byteArrayOf(2, 0, 0, 0, 7, 104, 105).toByteString(), peer.frame())
            relay.sendText("s1", "你好")
            assertEquals("你好", peer.frame())
            relay.close("s1")
        }
    }

    @Test fun `dispatch maps bridge messages and ignores unrelated methods`() {
        MockWebServer().use { server ->
            val peer = Peer()
            server.enqueue(MockResponse().withWebSocketUpgrade(peer))
            val sink = Recorder()
            val relay = relay(server, sink)
            assertTrue(relay.dispatch("streamOpen", listOf("a")))
            assertEquals("open:a", sink.next())
            peer.live()
            assertTrue(relay.dispatch("streamText", listOf("a", "hello")))
            assertEquals("hello", peer.frame())
            assertTrue(relay.dispatch("streamBinary", listOf("a", "AAEC")))
            assertEquals(byteArrayOf(0, 1, 2).toByteString(), peer.frame())
            assertTrue(relay.dispatch("streamClose", listOf("a", "1000")))
            assertEquals(1000, peer.closes.poll(5, TimeUnit.SECONDS))
            assertTrue(!relay.dispatch("request", listOf("1", "/api/state", "GET", "")))
            assertTrue(!relay.dispatch("subscribe", listOf("1")))
        }
    }

    @Test fun `a missing token never touches the network and reports an ended login`() {
        MockWebServer().use { server ->
            val sink = Recorder()
            relay(server, sink, token = { null }).open("s1")
            assertEquals("closed:s1:4401", sink.next())
            relay(server, sink, token = { " " }).open("s2")
            assertEquals("closed:s2:4401", sink.next())
            assertEquals(0, server.requestCount)
        }
    }

    @Test fun `a rejected upgrade is reported once and a 401 maps to the login-ended code`() {
        MockWebServer().use { server ->
            val sink = Recorder()
            val relay = relay(server, sink)
            server.enqueue(MockResponse().setResponseCode(401))
            relay.open("a")
            assertEquals("closed:a:4401", sink.next())
            server.enqueue(MockResponse().setResponseCode(403))
            relay.open("b")
            assertEquals("closed:b:1006", sink.next())
            sink.none()
        }
    }

    @Test fun `the server's close code reaches the page and the socket is released`() {
        MockWebServer().use { server ->
            val peer = Peer()
            server.enqueue(MockResponse().withWebSocketUpgrade(peer))
            val sink = Recorder()
            val relay = relay(server, sink)
            relay.open("s1")
            assertEquals("open:s1", sink.next())
            peer.live().close(4401, "session ended")
            assertEquals("closed:s1:4401", sink.next())
            sink.none()
            // the id is free again, so a reconnect with it is allowed
            val second = Peer()
            server.enqueue(MockResponse().withWebSocketUpgrade(second))
            relay.open("s1")
            assertEquals("open:s1", sink.next())
            relay.closeAll(CliStreamRelay.CLOSE_GOING_AWAY, report = false)
        }
    }

    @Test fun `a socket the page closed reports nothing and drops late frames`() {
        MockWebServer().use { server ->
            val peer = Peer()
            server.enqueue(MockResponse().withWebSocketUpgrade(peer))
            val sink = Recorder()
            val relay = relay(server, sink)
            relay.open("s1")
            assertEquals("open:s1", sink.next())
            val core = peer.live()
            relay.close("s1", 1000)
            assertEquals(1000, peer.closes.poll(5, TimeUnit.SECONDS))
            core.send("late")
            sink.none()
            relay.sendText("s1", "after close")
            assertNull(peer.received.poll(300, TimeUnit.MILLISECONDS))
        }
    }

    @Test fun `closeAll tells the page about each socket only when asked`() {
        MockWebServer().use { server ->
            val peers = listOf(Peer(), Peer(), Peer(), Peer())
            peers.forEach { server.enqueue(MockResponse().withWebSocketUpgrade(it)) }
            val sink = Recorder()
            val relay = relay(server, sink)
            for (id in listOf("a", "b")) { relay.open(id); assertEquals("open:$id", sink.next()) }
            relay.closeAll(CliStreamRelay.CLOSE_GOING_AWAY, report = true)
            assertEquals(setOf("closed:a:1001", "closed:b:1001"), setOf(sink.next(), sink.next()))
            for (id in listOf("c", "d")) { relay.open(id); assertEquals("open:$id", sink.next()) }
            relay.closeAll(CliStreamRelay.CLOSE_GOING_AWAY, report = false)
            sink.none()
            assertEquals(4, peers.count { it.closes.poll(5, TimeUnit.SECONDS) == 1001 })
        }
    }

    @Test fun `bad ids, duplicates and too many sockets are refused without a request`() {
        MockWebServer().use { server ->
            val peers = CopyOnWriteArrayList<Peer>()
            repeat(CliStreamRelay.MAX_SOCKETS) { Peer().also { peers.add(it); server.enqueue(MockResponse().withWebSocketUpgrade(it)) } }
            val sink = Recorder()
            val relay = relay(server, sink)
            relay.open("a/b")
            assertEquals("closed:a/b:1008", sink.next())
            relay.open("")
            assertEquals("closed::1008", sink.next())
            assertEquals(0, server.requestCount)
            for (index in 1..CliStreamRelay.MAX_SOCKETS) { relay.open("s$index"); assertEquals("open:s$index", sink.next()) }
            relay.open("s1") // a duplicate of a live id changes nothing
            relay.open("extra")
            assertEquals("closed:extra:1013", sink.next())
            sink.none()
            assertEquals(CliStreamRelay.MAX_SOCKETS, server.requestCount)
            relay.closeAll(CliStreamRelay.CLOSE_GOING_AWAY, report = false)
        }
    }

    @Test fun `an oversized or undecodable frame closes that socket instead of being sent`() {
        MockWebServer().use { server ->
            val peers = listOf(Peer(), Peer(), Peer())
            peers.forEach { server.enqueue(MockResponse().withWebSocketUpgrade(it)) }
            val sink = Recorder()
            val relay = relay(server, sink)
            for (id in listOf("t", "b", "x")) { relay.open(id); assertEquals("open:$id", sink.next()) }
            relay.sendText("t", "a".repeat(CliStreamRelay.MAX_FRAME + 1))
            assertEquals("closed:t:1009", sink.next())
            relay.sendBinary("b", "not base64 !!")
            assertEquals("closed:b:1003", sink.next())
            relay.sendBinary("x", ByteArray(CliStreamRelay.MAX_FRAME + 1).toByteString().base64())
            assertEquals("closed:x:1009", sink.next())
            assertEquals(listOf(1009, 1003, 1009), peers.map { assertNotNull(it.closes.poll(5, TimeUnit.SECONDS)) })
            // sending to a closed socket is a no-op
            relay.sendText("t", "again")
            sink.none()
        }
    }

    @Test fun `an idle stream outlives the handshake read timeout`() {
        MockWebServer().use { server ->
            val peer = Peer()
            server.enqueue(MockResponse().withWebSocketUpgrade(peer))
            val sink = Recorder()
            val http = CoreClient.defaultHttp().newBuilder().readTimeout(150, TimeUnit.MILLISECONDS).callTimeout(300, TimeUnit.MILLISECONDS).build()
            val relay = relay(server, sink, http = http)
            relay.open("s1")
            assertEquals("open:s1", sink.next())
            val core = peer.live()
            Thread.sleep(900)
            sink.none()
            core.send("still here")
            assertEquals("text:s1:still here", sink.next())
            relay.closeAll(CliStreamRelay.CLOSE_GOING_AWAY, report = false)
        }
    }

    @Test fun `reserved close codes from the page are replaced instead of crashing`() {
        MockWebServer().use { server ->
            val peer = Peer()
            server.enqueue(MockResponse().withWebSocketUpgrade(peer))
            val sink = Recorder()
            val relay = relay(server, sink)
            relay.open("s1")
            assertEquals("open:s1", sink.next())
            relay.dispatch("streamClose", listOf("s1", "1006"))
            assertEquals(1000, peer.closes.poll(5, TimeUnit.SECONDS))
        }
    }
}
