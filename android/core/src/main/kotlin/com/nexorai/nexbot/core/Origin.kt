package com.nexorai.nexbot.core

import java.net.URI
import java.net.URISyntaxException

/**
 * Where a Core lives.
 *
 * The rule mirrors `coreOrigin` in `electron/nex-client-main.mjs`, the desktop
 * thin client's own guard: a root URL only — no credentials, path, query or
 * fragment — HTTPS anywhere, and HTTP only where the traffic is already
 * private. `*.ts.net` is the one extra name: Tailscale carries it inside
 * WireGuard even though this process sees `http`.
 *
 * Login has a second, narrower rule inside Core (a remote password login needs
 * HTTPS or a private source address). That one is enforced by the server; the
 * client surfaces its 426 instead of duplicating the guess. The tailnet
 * `http` allowance here is therefore about reconnecting an existing session.
 */
object CoreOrigin {
    sealed interface Result {
        data class Valid(val origin: String) : Result

        data class Invalid(val reason: String) : Result
    }

    const val NOT_ROOT = "只填写服务器根地址，例如 https://bot.example.com"
    const val NOT_A_URL = "地址格式不正确，请包含 http:// 或 https://"
    const val NO_HOST = "地址缺少主机名"
    const val INSECURE_PUBLIC = "请填写 HTTPS 地址；只有私有网络或 tailnet 的地址可以使用 http"

    fun parse(input: String): Result {
        val raw = input.trim()
        if (raw.isEmpty()) return Result.Invalid(NOT_ROOT)
        val uri = try {
            URI(raw)
        } catch (_: URISyntaxException) {
            return Result.Invalid(NOT_A_URL)
        }
        val scheme = uri.scheme?.lowercase() ?: return Result.Invalid(NOT_A_URL)
        if (scheme != "http" && scheme != "https") return Result.Invalid(NOT_A_URL)
        if (uri.rawUserInfo != null) return Result.Invalid(NOT_ROOT)
        if (!uri.rawPath.isNullOrEmpty() && uri.rawPath != "/") return Result.Invalid(NOT_ROOT)
        if (uri.rawQuery != null || uri.rawFragment != null) return Result.Invalid(NOT_ROOT)
        val reportedHost = uri.host?.lowercase()?.removeSuffix(".") ?: return Result.Invalid(NO_HOST)
        if (reportedHost.isEmpty()) return Result.Invalid(NO_HOST)
        // Java keeps the brackets on an IPv6 literal.
        val host = reportedHost.removePrefix("[").removeSuffix("]")
        if (scheme == "http" && !isPrivateHost(host)) return Result.Invalid(INSECURE_PUBLIC)
        val authority = if (host.contains(':')) "[$host]" else host
        val origin = buildString {
            append(scheme).append("://").append(authority)
            val port = uri.port
            if (port != -1 && !isDefaultPort(scheme, port)) append(':').append(port)
        }
        return Result.Valid(origin)
    }

    fun isPrivateHost(host: String): Boolean {
        if (host == "localhost" || host == "::1") return true
        if (host.endsWith(".ts.net")) return true
        val parts = host.split('.')
        if (parts.size != 4) return false
        val octets = parts.map { part -> part.toIntOrNull() ?: return false }
        if (octets.any { octet -> octet !in 0..255 }) return false
        return when {
            octets[0] == 127 -> true
            octets[0] == 10 -> true
            octets[0] == 192 && octets[1] == 168 -> true
            octets[0] == 172 && octets[1] in 16..31 -> true
            else -> false
        }
    }

    private fun isDefaultPort(scheme: String, port: Int): Boolean =
        (scheme == "http" && port == 80) || (scheme == "https" && port == 443)
}
