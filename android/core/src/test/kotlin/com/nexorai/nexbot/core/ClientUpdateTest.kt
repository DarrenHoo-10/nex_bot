package com.nexorai.nexbot.core

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Test
import java.io.IOException
import java.nio.file.Files
import java.security.MessageDigest
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ClientUpdateTest {
    private val apk = ByteArray(4096) { (it % 251).toByte() }
    private val sha = MessageDigest.getInstance("SHA-256").digest(apk).joinToString("") { "%02x".format(it) }

    @Test fun `versions compare numerically and malformed offers are refused`() {
        assertTrue(ClientUpdates.newer("0.2.10", "0.2.9"))
        assertFalse(ClientUpdates.newer("0.2.9", "0.2.9"))
        assertFalse(ClientUpdates.newer("1.0.0-beta", "0.2.9"))
        assertFalse(ClientUpdates.valid(UpdateOffer("0.3.0", 10, sha, "http://mirror.test/a.apk")))
        assertFalse(ClientUpdates.valid(UpdateOffer("0.3.0", 10, "nope", "https://mirror.test/a.apk")))
        assertTrue(ClientUpdates.valid(UpdateOffer("0.3.0", 10, sha, "https://mirror.test/a.apk?Signature=x")))
    }

    @Test fun `check asks for the android platform and reports invalid offers as errors`() {
        MockWebServer().use { server ->
            val updates = ClientUpdates(server.url("/").toString(), OkHttpClient())
            server.enqueue(MockResponse().setBody("""{"platform":"android","current":"0.2.9","available":false}"""))
            assertNull(updates.check("android", "0.2.9"))
            val request = server.takeRequest()
            assertEquals("/api/client/update?platform=android&version=0.2.9", request.path)
            assertEquals(null, request.getHeader("Authorization"))
            server.enqueue(MockResponse().setBody("""{"available":true,"version":"0.3.0","size":4096,"sha256":"$sha","url":"https://mirror.test/nexbot-0.3.0-debug.apk"}"""))
            assertEquals(UpdateOffer("0.3.0", 4096, sha, "https://mirror.test/nexbot-0.3.0-debug.apk"), updates.check("android", "0.2.9"))
            server.enqueue(MockResponse().setBody("""{"available":true,"version":"0.2.8","size":4096,"sha256":"$sha","url":"https://mirror.test/old.apk"}"""))
            assertFailsWith<IOException> { updates.check("android", "0.2.9") }
            server.enqueue(MockResponse().setBody("{}"))
            assertFailsWith<IOException> { updates.check("android", "0.2.9") }
            server.enqueue(MockResponse().setResponseCode(503))
            assertFailsWith<IOException> { updates.check("android", "0.2.9") }
            server.enqueue(MockResponse().setBody("""{"available":false}"""))
            assertNull(updates.check("android", "0.2.9"))
        }
    }

    @Test fun `download keeps only a file with the offered size and digest`() {
        MockWebServer().use { server ->
            val dir = Files.createTempDirectory("nex-update").toFile()
            try {
                val updates = ClientUpdates("https://core.test", OkHttpClient())
                // MockWebServer is plain HTTP, so the bytes are fetched past the https-only offer check.
                val url = server.url("/nexbot-0.3.0-debug.apk").toString().replace("http://", "https://")
                val offer = UpdateOffer("0.3.0", apk.size.toLong(), sha, url)
                val plain = offer.copy(url = server.url("/nexbot-0.3.0-debug.apk").toString())
                server.enqueue(MockResponse().setBody(Buffer().write(apk)))
                val file = updates.fetch(plain, dir, "nexbot-0.3.0.apk")
                assertTrue(file.readBytes().contentEquals(apk))
                // A verified file is reused without another request.
                assertEquals(file, updates.download(offer, dir, "nexbot-0.3.0.apk"))
                assertEquals(1, server.requestCount)
                file.delete()
                val tampered = apk.copyOf().also { it[0] = 9 }
                server.enqueue(MockResponse().setBody(Buffer().write(tampered)))
                assertFailsWith<IOException> { updates.fetch(plain, dir, "nexbot-0.3.0.apk") }
                server.enqueue(MockResponse().setBody(Buffer().write(apk + apk)))
                assertFailsWith<IOException> { updates.fetch(plain, dir, "nexbot-0.3.0.apk") }
                assertTrue(dir.listFiles().orEmpty().isEmpty())
            } finally { dir.deleteRecursively() }
        }
    }
}
