package com.nexorai.nexbot.core

/** One dispatched Server-Sent Event. */
data class SseFrame(
    val data: String,
    val event: String,
    val id: String?,
)

/** What the one live stream can tell a client. */
sealed interface LiveFrame {
    /** The only payload Core's stream carries: "something changed, cursor N". */
    data class Change(
        val cursor: Long,
        val privacyEpoch: Long,
        val coreId: String,
        val bootId: String,
        val reset: Boolean,
    ) : LiveFrame

    /** The session behind this stream is gone; clear private state and re-pair. */
    data object Revoked : LiveFrame

    /** A frame this client build does not know; keep the stream, ignore the body. */
    data class Unknown(val event: String, val data: String) : LiveFrame
}

fun SseFrame.toLiveFrame(): LiveFrame = when (event) {
    "change" -> try {
        val value = CoreJson.decodeFromString(SyncEvent.serializer(), data)
        LiveFrame.Change(value.cursor, value.privacyEpoch, value.coreId, value.bootId, value.reset)
    } catch (_: Exception) {
        LiveFrame.Unknown(event, data)
    }

    "revoked" -> LiveFrame.Revoked
    else -> LiveFrame.Unknown(event, data)
}

/**
 * Incremental Server-Sent Events parser over the raw bytes of a response.
 *
 * Written here instead of using a library for the same reason the desktop
 * supervisor exists (`src/lib/live-events.ts`): a half-open proxy must not look
 * like a connected Core, and Core's own liveness proof is that it sends a
 * `change` frame every fifteen seconds. This parser therefore reports every
 * dispatched frame, and the caller owns staleness.
 *
 * It accepts CRLF, LF and CR line endings, joins multi-line `data`, ignores
 * comments (the `: keepalive` lines proxies inject), keeps the last `id` across
 * events as SSE requires, and never fails the stream over one malformed frame.
 */
class SseParser(private val onFrame: (SseFrame) -> Unit) {
    private val line = ByteLine()
    private val data = StringBuilder()
    private var event = ""
    private var lastId: String? = null
    private var frameId: String? = null
    private var lastWasCr = false
    private var firstLine = true

    fun feed(bytes: ByteArray, length: Int = bytes.size) {
        var index = 0
        while (index < length) {
            val byte = bytes[index].toInt() and 0xFF
            index++
            when (byte) {
                0x0D -> {
                    endLine()
                    lastWasCr = true
                }

                0x0A -> {
                    // The LF of a CRLF pair: the CR already ended the line.
                    if (!lastWasCr) endLine()
                    lastWasCr = false
                }

                else -> {
                    lastWasCr = false
                    line.append(byte)
                }
            }
        }
    }

    /** Flush a final event that arrived without its trailing blank line. */
    fun finish() {
        if (line.size > 0) endLine()
        dispatch()
    }

    private fun endLine() {
        var text = line.takeUtf8()
        if (firstLine) {
            firstLine = false
            if (text.startsWith('\uFEFF')) text = text.substring(1)
        }
        if (text.isEmpty()) {
            dispatch()
            return
        }
        if (text.startsWith(":")) return
        val colon = text.indexOf(':')
        val field = if (colon < 0) text else text.substring(0, colon)
        val rawValue = if (colon < 0) "" else text.substring(colon + 1)
        val value = if (rawValue.startsWith(" ")) rawValue.substring(1) else rawValue
        when (field) {
            "data" -> {
                if (data.isNotEmpty()) data.append('\n')
                data.append(value)
            }

            "event" -> event = value
            "id" -> if (!value.contains('\u0000')) {
                lastId = value
                frameId = value
            }
            // "retry" is deliberately ignored: the supervisor owns backoff.
        }
    }

    private fun dispatch() {
        if (data.isEmpty() && event.isEmpty() && frameId == null) return
        val frame = SseFrame(
            data = data.toString(),
            event = event.ifEmpty { "message" },
            id = frameId ?: lastId,
        )
        data.setLength(0)
        event = ""
        frameId = null
        onFrame(frame)
    }

    private class ByteLine {
        private var buffer = ByteArray(128)
        var size = 0
            private set

        fun append(byte: Int) {
            if (size == buffer.size) buffer = buffer.copyOf(buffer.size * 2)
            buffer[size++] = byte.toByte()
        }

        fun takeUtf8(): String {
            val text = String(buffer, 0, size, Charsets.UTF_8)
            size = 0
            return text
        }
    }
}
