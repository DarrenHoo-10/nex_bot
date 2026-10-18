package com.nexorai.nexbot.core

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/** The bundled workspace can call only the signed-in Core's API, never a supplied host. */
class WorkspaceTransport(private val origin: String, private val token: () -> String?, private val http: OkHttpClient = CoreClient.defaultHttp()) {
    data class Reply(val status: Int, val body: ByteArray)

    fun request(path: String, method: String, body: String): Reply {
        validate(path, method)
        require(body.length <= 36 * 1024 * 1024) { "请求过大" }
        val bearer = token()?.takeIf { it.isNotBlank() } ?: throw IOException("登录已失效")
        val builder = Request.Builder().url(origin.trimEnd('/') + path).header("Authorization", "Bearer $bearer")
        if (method == "GET") builder.get() else builder.post(body.toRequestBody("application/json; charset=utf-8".toMediaType()))
        http.newCall(builder.build()).execute().use { response ->
            val source = response.body?.source() ?: return Reply(response.code, ByteArray(0))
            val limit = 32L * 1024 * 1024
            if (source.request(limit + 1)) throw IOException("响应过大")
            return Reply(response.code, source.readByteArray())
        }
    }

    companion object {
        fun validate(path: String, method: String) {
            require(method == "GET" || method == "POST") { "不支持的请求方法" }
            require(path.startsWith("/api/") && !path.contains('\\') && !path.contains('#') && !path.any { it.code < 32 }) { "不支持的请求地址" }
            val route = path.substringBefore('?')
            require(!route.contains('%') && !route.contains("..") && !route.contains("//")) { "不支持的请求地址" }
            require(route !in setOf("/api/session", "/api/auth/start", "/api/auth/respond", "/api/auth/refresh")) { "登录由客户端管理" }
        }
    }
}
