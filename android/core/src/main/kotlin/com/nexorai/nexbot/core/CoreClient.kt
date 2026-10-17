package com.nexorai.nexbot.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit

/** A refusal or failure the person can read, plus the HTTP status that caused it. */
class CoreException(
    val status: Int,
    override val message: String,
    val code: String? = null,
) : Exception(message)

/**
 * The phone's whole view of one Core.
 *
 * One instance per saved connection. The bearer is held here and never
 * persisted by this class; the caller owns storage (Keystore-backed on
 * Android) and hands it back with [useToken].
 *
 * Every call is bounded by a 15-second timeout and does not follow redirects,
 * so a token cannot be walked to another host. The one unbounded exchange is
 * [events]: a live SSE response is open until the stream or the caller ends it.
 */
class CoreClient(
    origin: String,
    private val http: OkHttpClient = defaultHttp(),
) {
    val origin: String = origin.trimEnd('/')

    @Volatile
    var token: String? = null
        private set

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    fun useToken(value: String?) {
        token = value
    }

    // ---- identity --------------------------------------------------------

    suspend fun identity(): IdentityInfo = get("/api/client/identity", IdentityInfo.serializer())

    suspend fun startLogin(account: String, name: String): LoginTransaction = post(
        "/api/auth/start",
        jsonBody("account" to account, "name" to name),
        LoginTransaction.serializer(),
        bearer = null,
    )

    suspend fun respondLogin(transaction: LoginTransaction, password: String): SessionInfo = post(
        "/api/auth/respond",
        jsonBody(
            "transactionId" to transaction.transactionId,
            "bindingToken" to transaction.bindingToken,
            "stepId" to transaction.stepId,
            "password" to password,
        ),
        SessionInfo.serializer(),
        bearer = null,
    )

    /** Re-verify a saved token on a cold start. The caller compares `coreId` to the saved one. */
    suspend fun resume(savedToken: String): ResumedSession = post(
        "/api/session",
        jsonBody("token" to savedToken),
        ResumedSession.serializer(),
        bearer = null,
    )

    suspend fun logout() {
        post("/api/auth/logout", EMPTY_BODY, OkReply.serializer())
    }

    /**
     * Trade the current bearer for a fresh one without a password. The old
     * token dies here, which is why the new one is kept on success only.
     */
    suspend fun refresh(): SessionInfo {
        val session = post("/api/auth/refresh", EMPTY_BODY, SessionInfo.serializer())
        token = session.token
        return session
    }

    suspend fun clients(): ClientSessions = get("/api/clients", ClientSessions.serializer())

    suspend fun revokeSession(sessionId: String) {
        post("/api/clients/revoke", jsonBody("sessionId" to sessionId), OkReply.serializer())
    }

    // ---- state and messages ---------------------------------------------

    /**
     * The whole client snapshot. [summary] asks Core for the same document
     * without memory bodies or the finished-work journal — the shape a phone
     * polls. An older Core ignores the parameter and answers with the full
     * document; `CoreState.view` is then null and the caller keeps working.
     */
    suspend fun state(summary: Boolean): CoreState = get(
        if (summary) "/api/state?view=summary" else "/api/state",
        CoreState.serializer(),
    )

    suspend fun messages(botId: String, after: Long? = null, before: Long? = null): MessageFeed {
        require(after == null || before == null) { "after and before are exclusive" }
        require(after == null || after >= 0) { "after must not be negative" }
        require(before == null || before > 0) { "before must be positive" }
        val params = buildMap {
            put("bot", botId)
            if (after != null) put("after", after.toString())
            if (before != null) put("before", before.toString())
        }
        return get(withQuery("/api/agents/messages", params), MessageFeed.serializer())
    }

    suspend fun send(botId: String, text: String, clientId: String): SendReceipt = post(
        "/api/agents/input",
        jsonBody("botId" to botId, "text" to text, "clientId" to clientId),
        SendReceipt.serializer(),
    )

    suspend fun markRead(botId: String, seq: Long) {
        post("/api/agents/read", jsonBody("botId" to botId, "seq" to seq), OkReply.serializer())
    }

    suspend fun decide(approvalId: String, argumentHash: String, allow: Boolean) {
        post(
            "/api/approvals",
            jsonBody("id" to approvalId, "hash" to argumentHash, "allow" to allow),
            OkReply.serializer(),
        )
    }

    suspend fun cancel(taskId: String) {
        post("/api/cancel", jsonBody("taskId" to taskId), OkReply.serializer())
    }

    suspend fun resumeTask(taskId: String) {
        post("/api/resume", jsonBody("taskId" to taskId), OkReply.serializer())
    }

    suspend fun setRoutineEnabled(id: String, version: Long, enabled: Boolean) {
        post(
            "/api/routines/toggle",
            jsonBody("id" to id, "version" to version, "enabled" to enabled),
            OkReply.serializer(),
        )
    }

    suspend fun runRoutine(id: String, clientId: String) {
        post("/api/routines/run", jsonBody("id" to id, "clientId" to clientId), OkReply.serializer())
    }

    // ---- the live stream -------------------------------------------------

    /**
     * Open `/api/events` once per connection.
     *
     * `lastEventId` is the cursor of the newest folded frame, so a reconnect
     * that Core can still replay misses nothing. A frame's `reset` flag (or a
     * `revoked` frame) is the caller's signal to rebuild its snapshot; this
     * class does not decide policy.
     *
     * The flow completes when the server ends the response and fails on a
     * transport error, except when the collector cancelled it.
     */
    fun events(lastEventId: String? = null): Flow<LiveFrame> = callbackFlow {
        val bearer = token
        val request = Request.Builder()
            .url(origin + "/api/events")
            .apply {
                if (!lastEventId.isNullOrEmpty()) header("Last-Event-ID", lastEventId)
                if (!bearer.isNullOrEmpty()) header("Authorization", "Bearer $bearer")
            }
            .get()
            .build()
        // Streaming needs no read timeout; a half-open socket is detected by
        // the caller with Core's 15-second heartbeats.
        val streamingHttp = http.newBuilder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .callTimeout(0, TimeUnit.MILLISECONDS)
            .build()
        val call = streamingHttp.newCall(request)
        val worker = launch(Dispatchers.IO) {
            val pending = ArrayDeque<LiveFrame>()
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) {
                        this@callbackFlow.close(error(response.code, response.body?.string().orEmpty()))
                        return@use
                    }
                    val source = response.body?.source()
                    if (source == null) {
                        this@callbackFlow.close()
                        return@use
                    }
                    val parser = SseParser { frame -> pending.addLast(frame.toLiveFrame()) }
                    val buffer = ByteArray(8192)
                    while (!source.exhausted()) {
                        val read = source.read(buffer)
                        if (read == -1) break
                        parser.feed(buffer, read)
                        while (pending.isNotEmpty()) send(pending.removeFirst())
                    }
                    parser.finish()
                    while (pending.isNotEmpty()) send(pending.removeFirst())
                    this@callbackFlow.close()
                }
            } catch (failure: IOException) {
                if (!call.isCanceled()) this@callbackFlow.close(failure)
            }
        }
        awaitClose {
            call.cancel()
            worker.cancel()
        }
    }

    // ---- plumbing --------------------------------------------------------

    private suspend fun <T> get(path: String, serializer: KSerializer<T>): T =
        decode(execute("GET", path, null, token), serializer)

    private suspend fun <T> post(
        path: String,
        body: String,
        serializer: KSerializer<T>,
        bearer: String? = token,
    ): T = decode(execute("POST", path, body, bearer), serializer)

    private suspend fun execute(method: String, path: String, body: String?, bearer: String?): Response {
        val url = if (path.startsWith("http")) path else origin + path
        val builder = Request.Builder().url(url)
        if (bearer != null) builder.header("Authorization", "Bearer $bearer")
        if (method == "GET") builder.get() else builder.post((body ?: EMPTY_BODY).toRequestBody(jsonMedia))
        val response = withContext(Dispatchers.IO) { http.newCall(builder.build()).execute() }
        if (!response.isSuccessful) {
            val text = withContext(Dispatchers.IO) { response.body?.string().orEmpty() }
            response.close()
            throw error(response.code, text)
        }
        return response
    }

    private suspend fun <T> decode(response: Response, serializer: KSerializer<T>): T {
        val text = withContext(Dispatchers.IO) { response.body?.string().orEmpty() }
        val status = response.code
        response.close()
        return try {
            CoreJson.decodeFromString(serializer, text)
        } catch (_: Exception) {
            throw CoreException(status, "服务器返回了无法解析的数据")
        }
    }

    private fun error(status: Int, text: String): CoreException {
        val parsed = runCatching { CoreJson.parseToJsonElement(text).jsonObject }.getOrNull()
        val message = runCatching { parsed?.get("error")?.jsonPrimitive?.contentOrNull }.getOrNull()
        val code = runCatching { parsed?.get("code")?.jsonPrimitive?.contentOrNull }.getOrNull()
        return CoreException(status, message ?: "请求失败（$status）", code)
    }

    private fun withQuery(path: String, params: Map<String, String>): String {
        if (params.isEmpty()) return path
        val builder = (origin + path).toHttpUrl().newBuilder()
        for ((key, value) in params) builder.addQueryParameter(key, value)
        return builder.build().toString()
    }

    private fun jsonBody(vararg fields: Pair<String, Any?>): String = buildJsonObject {
        for ((key, value) in fields) {
            put(
                key,
                when (value) {
                    null -> JsonNull
                    is Boolean -> JsonPrimitive(value)
                    is Number -> JsonPrimitive(value)
                    else -> JsonPrimitive(value.toString())
                },
            )
        }
    }.let { CoreJson.encodeToString(JsonObject.serializer(), it) }

    companion object {
        private const val EMPTY_BODY = "{}"

        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .callTimeout(15, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
    }
}
