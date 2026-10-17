package com.nexorai.nexbot.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class OriginTest {
    private fun valid(input: String): String =
        (CoreOrigin.parse(input) as CoreOrigin.Result.Valid).origin

    private fun reason(input: String): String =
        (CoreOrigin.parse(input) as CoreOrigin.Result.Invalid).reason

    @Test
    fun `accepts an https root and normalizes case and the default port`() {
        assertEquals("https://bot.nexorai.com.cn", valid("HTTPS://Bot.NexorAI.com.cn:443/"))
        assertEquals("https://bot.nexorai.com.cn", valid("  https://bot.nexorai.com.cn  "))
    }

    @Test
    fun `accepts private http hosts`() {
        assertEquals("http://192.168.1.4:8799", valid("http://192.168.1.4:8799"))
        assertEquals("http://10.0.0.5:8799", valid("http://10.0.0.5:8799"))
        assertEquals("http://172.16.3.9:8799", valid("http://172.16.3.9:8799"))
        assertEquals("http://172.31.3.9:8799", valid("http://172.31.3.9:8799"))
        assertEquals("http://127.0.0.1:8799", valid("http://127.0.0.1:8799"))
        assertEquals("http://localhost:8799", valid("http://localhost:8799"))
        assertEquals("http://[::1]:8799", valid("http://[::1]:8799"))
    }

    @Test
    fun `allows a tailnet name over http`() {
        assertEquals("http://macbook.tail1234.ts.net:8810", valid("http://macbook.tail1234.ts.net:8810"))
    }

    @Test
    fun `rejects public or malformed addresses`() {
        assertEquals(CoreOrigin.INSECURE_PUBLIC, reason("http://bot.nexorai.com.cn"))
        assertEquals(CoreOrigin.INSECURE_PUBLIC, reason("http://172.32.0.1:8799"))
        assertEquals(CoreOrigin.INSECURE_PUBLIC, reason("http://100.64.0.1:8799"))
        assertEquals(CoreOrigin.NOT_A_URL, reason("bot.nexorai.com.cn"))
        assertEquals(CoreOrigin.NOT_A_URL, reason("ftp://bot.nexorai.com.cn"))
        assertEquals(CoreOrigin.NOT_ROOT, reason("https://bot.nexorai.com.cn/app"))
        assertEquals(CoreOrigin.NOT_ROOT, reason("https://bot.nexorai.com.cn?x=1"))
        assertEquals(CoreOrigin.NOT_ROOT, reason("https://user:pass@bot.nexorai.com.cn"))
    }

    @Test
    fun `classifies hosts the way the rule does`() {
        assertTrue(CoreOrigin.isPrivateHost("localhost"))
        assertTrue(CoreOrigin.isPrivateHost("::1"))
        assertTrue(CoreOrigin.isPrivateHost("192.168.0.1"))
        assertTrue(CoreOrigin.isPrivateHost("172.20.0.1"))
        assertTrue(CoreOrigin.isPrivateHost("box.ts.net"))
        assertFalse(CoreOrigin.isPrivateHost("100.64.0.1"))
        assertFalse(CoreOrigin.isPrivateHost("8.8.8.8"))
        assertFalse(CoreOrigin.isPrivateHost("example.com"))
    }
}
