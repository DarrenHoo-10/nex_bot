package com.nexorai.nexbot.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** A newer APK that Core's release manifest offers, with the digest it must match. */
data class UpdateOffer(val version: String, val size: Long, val sha256: String, val url: String)

/**
 * Checks Core's public `/api/client/update` and downloads the offered APK.
 * A file is kept only when its size and SHA-256 match the offer.
 */
class ClientUpdates(origin: String, private val http: OkHttpClient = downloadHttp()) {
    private val origin = origin.trimEnd('/')

    fun check(platform: String, current: String): UpdateOffer? {
        val url = "$origin/api/client/update".toHttpUrl().newBuilder()
            .addQueryParameter("platform", platform).addQueryParameter("version", current).build()
        http.newCall(Request.Builder().url(url).get().build()).execute().use { response ->
            if (!response.isSuccessful) throw IOException("检查更新返回 HTTP ${response.code}")
            val body = Json.parseToJsonElement(response.body?.string().orEmpty()).jsonObject
            if (body["available"]?.jsonPrimitive?.booleanOrNull != true) return null
            val offer = UpdateOffer(
                version = body["version"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                size = body["size"]?.jsonPrimitive?.longOrNull ?: 0,
                sha256 = body["sha256"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                url = body["url"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            )
            return offer.takeIf { valid(it) && newer(it.version, current) }
        }
    }

    /** Downloads into [dir], reusing an already verified file; a mismatched file is deleted. */
    fun download(offer: UpdateOffer, dir: File, name: String): File {
        require(valid(offer)) { "更新信息无效" }
        return fetch(offer, dir, name)
    }

    internal fun fetch(offer: UpdateOffer, dir: File, name: String): File {
        dir.mkdirs()
        val target = File(dir, name)
        if (target.isFile && target.length() == offer.size && digest(target) == offer.sha256) return target
        val partial = File(dir, "$name.part")
        partial.delete()
        try {
            http.newCall(Request.Builder().url(offer.url).get().build()).execute().use { response ->
                if (!response.isSuccessful) throw IOException("下载更新返回 HTTP ${response.code}")
                val source = response.body?.byteStream() ?: throw IOException("更新文件为空")
                partial.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val read = source.read(buffer)
                        if (read < 0) break
                        total += read
                        if (total > offer.size) throw IOException("更新文件大小不符")
                        output.write(buffer, 0, read)
                    }
                }
            }
            if (partial.length() != offer.size || digest(partial) != offer.sha256) throw IOException("更新文件校验失败")
            target.delete()
            if (!partial.renameTo(target)) throw IOException("无法保存更新文件")
            return target
        } finally { partial.delete() }
    }

    companion object {
        private val version = Regex("""^\d+\.\d+\.\d+$""")
        private val sha = Regex("^[a-f0-9]{64}$")

        fun valid(offer: UpdateOffer): Boolean {
            val url = offer.url.toHttpUrlOrNull() ?: return false
            return version.matches(offer.version) && sha.matches(offer.sha256) && offer.size in 1..(512L * 1024 * 1024) &&
                url.scheme == "https" && url.username.isEmpty() && url.password.isEmpty()
        }

        /** True when [candidate] is a higher x.y.z than [current]; malformed candidates never are. */
        fun newer(candidate: String, current: String): Boolean {
            if (!version.matches(candidate)) return false
            if (!version.matches(current)) return true
            val a = candidate.split('.').map { it.toLong() }
            val b = current.split('.').map { it.toLong() }
            for (i in 0 until 3) if (a[i] != b[i]) return a[i] > b[i]
            return false
        }

        fun digest(file: File): String {
            val sha256 = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) { val read = input.read(buffer); if (read < 0) break; sha256.update(buffer, 0, read) }
            }
            return sha256.digest().joinToString("") { "%02x".format(it) }
        }

        /** Installers are large: no overall call deadline, but stalled reads still fail. */
        fun downloadHttp(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
    }
}
