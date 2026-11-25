package com.nexorai.nexbot.core

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.decodeBase64
import okio.utf8Size
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Native half of the Agent mode stream (`/api/cli-agents/stream`) for the bundled
 * workspace. The WebView cannot open a WebSocket (its CSP is `connect-src 'none'`
 * and a page cannot send `Authorization`), so the page asks the app to hold the
 * socket and this class relays frames both ways.
 *
 * The relay is deliberately dumb: one OkHttp WebSocket per page-chosen id, the
 * fixed Core path, the current bearer on the upgrade, text frames as strings and
 * binary frames as base64. It never retries. When a socket ends for any reason
 * the page is told once with a close code and its own reconnect logic (backoff,
 * subscription replay, keep-alive ping) decides what happens next. Frame
 * contents are never logged or inspected.
 */
class CliStreamRelay(
    private val origin: String,
    private val token: () -> String?,
    private val sink: Sink,
    http: OkHttpClient = CoreClient.defaultHttp(),
) {
    /** Called from OkHttp's threads, in order per socket id. */
    interface Sink {
        fun opened(id: String)
        fun text(id: String, text: String)
        fun binary(id: String, base64: String)
        fun closed(id: String, code: Int)
    }

    // the handshake keeps the shared timeouts; OkHttp lifts them once the upgrade succeeded
    private val client = http.newBuilder().pingInterval(0, TimeUnit.SECONDS).build()
    private val sockets = ConcurrentHashMap<String, WebSocket>()

    /** Runs one page-to-app bridge message. False when `method` is not a stream method. */
    fun dispatch(method: String, args: List<String>): Boolean {
        when (method) {
            "streamOpen" -> open(args[0])
            "streamText" -> sendText(args[0], args[1])
            "streamBinary" -> sendBinary(args[0], args[1])
            "streamClose" -> close(args[0], args.getOrNull(1)?.toIntOrNull() ?: CLOSE_NORMAL)
            else -> return false
        }
        return true
    }

    fun open(id: String) {
        if (!ID.matches(id)) { sink.closed(id.take(MAX_ID), CLOSE_POLICY); return }
        if (sockets.containsKey(id)) return
        val bearer = token()?.takeIf { it.isNotBlank() }
        if (bearer == null) { sink.closed(id, CLOSE_UNAUTHORIZED); return }
        if (sockets.size >= MAX_SOCKETS) { sink.closed(id, CLOSE_TRY_AGAIN); return }
        val request = Request.Builder().url(streamUrl(origin)).header("Authorization", "Bearer $bearer").build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (owns(id, webSocket)) sink.opened(id)
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (owns(id, webSocket)) sink.text(id, text)
            }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (owns(id, webSocket)) sink.binary(id, bytes.base64())
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (!release(id, webSocket)) return
                webSocket.close(CLOSE_NORMAL, null)
                sink.closed(id, code)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (release(id, webSocket)) sink.closed(id, code)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!release(id, webSocket)) return
                sink.closed(id, if (response?.code == 401) CLOSE_UNAUTHORIZED else CLOSE_ABNORMAL)
            }
        }
        // Callbacks take the same lock, so one that fires before the entry exists waits for it.
        synchronized(sockets) {
            if (sockets.containsKey(id)) return
            sockets[id] = client.newWebSocket(request, listener)
        }
    }

    private fun owns(id: String, socket: WebSocket) = synchronized(sockets) { sockets[id] === socket }
    private fun release(id: String, socket: WebSocket) = synchronized(sockets) { sockets.remove(id, socket) }
    private fun take(id: String) = synchronized(sockets) { sockets.remove(id) }

    fun sendText(id: String, text: String) {
        val socket = sockets[id] ?: return
        if (text.utf8Size() > MAX_FRAME) { fail(id, socket, CLOSE_TOO_BIG); return }
        if (!socket.send(text)) fail(id, socket, CLOSE_INTERNAL)
    }

    fun sendBinary(id: String, base64: String) {
        val socket = sockets[id] ?: return
        val bytes = base64.decodeBase64()
        if (bytes == null) { fail(id, socket, CLOSE_UNSUPPORTED); return }
        if (bytes.size > MAX_FRAME) { fail(id, socket, CLOSE_TOO_BIG); return }
        if (!socket.send(bytes)) fail(id, socket, CLOSE_INTERNAL)
    }

    /** The page closed this socket: nothing is reported back. */
    fun close(id: String, code: Int = CLOSE_NORMAL) {
        val socket = take(id) ?: return
        socket.close(validCode(code), null)
    }

    /** Ends every socket, e.g. the screen stopped. With [report] the page hears about each one. */
    fun closeAll(code: Int, report: Boolean) {
        for (id in sockets.keys.toList()) {
            val socket = take(id) ?: continue
            socket.close(validCode(code), null)
            if (report) sink.closed(id, code)
        }
    }

    private fun fail(id: String, socket: WebSocket, code: Int) {
        if (!release(id, socket)) return
        socket.close(code, null)
        sink.closed(id, code)
    }

    companion object {
        const val CLOSE_NORMAL = 1000
        const val CLOSE_GOING_AWAY = 1001
        const val CLOSE_UNSUPPORTED = 1003
        const val CLOSE_ABNORMAL = 1006
        const val CLOSE_POLICY = 1008
        const val CLOSE_TOO_BIG = 1009
        const val CLOSE_INTERNAL = 1011
        const val CLOSE_TRY_AGAIN = 1013
        /** Core closes with this code when the login ended; the page must not reconnect. */
        const val CLOSE_UNAUTHORIZED = 4401
        /** Core accepts at most 1 MiB per client frame. */
        const val MAX_FRAME = 1024 * 1024
        const val MAX_SOCKETS = 4
        private const val MAX_ID = 40
        private val ID = Regex("^[A-Za-z0-9_-]{1,$MAX_ID}$")

        fun streamUrl(origin: String): String {
            val base = origin.trimEnd('/')
            val rest = when {
                base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
                base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
                else -> throw IllegalArgumentException("不支持的服务地址")
            }
            return "$rest/api/cli-agents/stream"
        }

        /** OkHttp refuses reserved codes (1005, 1006, 1015...) and the page may pass anything. */
        private fun validCode(code: Int) = if (code in 1000..4999 && code !in setOf(1004, 1005, 1006) && code !in 1015..2999) code else CLOSE_NORMAL
    }
}
