package com.nexorai.nexbot.core

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.Base64

/** The bundled workspace can call only the signed-in Core's API, never a supplied host. */
class WorkspaceTransport(private val origin: String, private val token: () -> String?, private val http: OkHttpClient = CoreClient.defaultHttp()) {
    data class Reply(val status: Int, val body: ByteArray, val contentType: String = "")
    private data class Asset(val reply: Reply, val etag: String?, val expires: Long)
    private val assets = LinkedHashMap<String, Asset>(16, 0.75f, true)
    private var assetToken: String? = null

    @Synchronized fun clearAssets() {
        assets.clear()
        assetToken = null
    }

    fun request(path: String, method: String, body: String): Reply {
        validate(path, method)
        require(body.length <= 36 * 1024 * 1024) { "请求过大" }
        val bearer = token()?.takeIf { it.isNotBlank() } ?: throw IOException("登录已失效")
        val route = path.substringBefore('?')
        val query = path.substringAfter('?', "")
        val preview = method == "GET" && isAttachmentPreview(route, query)
        val avatar = method == "GET" && isGroupAvatar(route, query)
        val cliPreview = method == "GET" && isCliImagePreview(route, query)
        val now = System.currentTimeMillis()
        val old = if (preview || avatar) synchronized(this) {
            if (assetToken != bearer) { assets.clear(); assetToken = bearer }
            assets[path]?.takeIf { it.expires > now }
        } else null
        if (avatar && old != null) return old.reply
        val builder = Request.Builder().url(origin.trimEnd('/') + path).header("Authorization", "Bearer $bearer")
        if (preview && old?.etag != null) builder.header("If-None-Match", old.etag)
        when {
            method == "GET" -> builder.get()
            route == "/api/cli-agents/images" -> {
                val maxBytes = 5 * 1024 * 1024
                require(body.length <= ((maxBytes + 2) / 3) * 4) { "图片不能超过 5 MB" }
                val bytes = Base64.getDecoder().decode(body)
                require(bytes.size in 1..maxBytes) { "图片不能超过 5 MB" }
                builder.post(bytes.toRequestBody("application/octet-stream".toMediaType()))
            }
            else -> builder.post(body.toRequestBody("application/json; charset=utf-8".toMediaType()))
        }
        http.newCall(builder.build()).execute().use { response ->
            if ((preview || avatar || cliPreview) && token() != bearer) throw IOException("登录已失效")
            if (preview && response.code == 304 && old != null) return old.reply
            val source = response.body?.source() ?: return Reply(response.code, ByteArray(0))
            val limit = 32L * 1024 * 1024
            if (source.request(limit + 1)) throw IOException("响应过大")
            val reply = Reply(response.code, source.readByteArray(), response.header("Content-Type").orEmpty())
            if ((preview || avatar) && reply.status == 200 && reply.body.size <= 1024 * 1024 && reply.contentType.startsWith("image/")) {
                synchronized(this) {
                    if (assetToken == bearer) {
                        assets[path] = Asset(reply, response.header("ETag"), now + 300_000)
                        if (assets.size > 16) assets.remove(assets.keys.first())
                    }
                }
            }
            return reply
        }
    }

    companion object {
        private val attachmentPreview = Regex("^/api/attachments/[a-zA-Z0-9-]+$")
        private val cliImagePreview = Regex("^/api/cli-agents/images/[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
        fun isCliImagePreview(path: String, query: String?) = query.isNullOrEmpty() && cliImagePreview.matches(path)
        /** Core-served image previews, fetched with the native token for <img> tags. */
        fun isAttachmentPreview(path: String, query: String?) = attachmentPreview.matches(path) && query == "preview=1"
        private val groupAvatarQuery = Regex("^id=[a-zA-Z0-9-]+&chat=[a-zA-Z0-9_-]+&v=[a-f0-9]{16}$")
        fun isGroupAvatar(path: String, query: String?) = path == "/api/feishu/group-avatar" && query != null && groupAvatarQuery.matches(query)
        fun validate(path: String, method: String) {
            require(method == "GET" || method == "POST") { "不支持的请求方法" }
            require(path.startsWith("/api/") && !path.contains('\\') && !path.contains('#') && !path.any { it.code < 32 }) { "不支持的请求地址" }
            val route = path.substringBefore('?')
            require(!route.contains('%') && !route.contains("..") && !route.contains("//")) { "不支持的请求地址" }
            require(route !in setOf("/api/session", "/api/auth/start", "/api/auth/respond", "/api/auth/refresh")) { "登录由客户端管理" }
        }
    }
}
